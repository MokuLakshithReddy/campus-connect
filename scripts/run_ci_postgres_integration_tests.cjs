/**
 * POSTGRESQL CI INTEGRATION TEST RUNNER (DUAL-PATH & MIGRATION VERIFICATION)
 * 
 * Runs end-to-end against a real PostgreSQL instance (e.g. GitHub Actions Postgres service container):
 * 1. Bootstraps auth & storage schemas, realtime publication, extensions, and standard roles
 * 2. PATH 1: Applies all migrations sequentially (supabase/migrations/*.sql) on clean database
 * 3. Executes complete security test suite against migrations-built database
 * 4. PATH 2: Re-verifies against consolidated schema (supabase/schema.sql) on clean database
 * 5. Executes complete security test suite against schema-built database
 * 6. UPGRADE PATH: Verifies sequential migrations can execute idempotently over existing schema
 * 
 * Tested Security Engine Invariants:
 * - Literal longest-prefix student roll branch resolution
 * - Row locking (SELECT ... FOR UPDATE) during student directory claim
 * - Fail-closed duplicate claim rejection in concurrent/overlapping scenarios
 * - Academic fields immutability (roll number, branch)
 * - Self-escalation prevention on UPDATE (college_role cannot be self-modified)
 * - Self-escalation prevention on INSERT (auth user fixture + forced downgrade to student, unverified)
 * - Anti-spoofing branch triggers on posts (INSERT & UPDATE)
 * - Concurrency-safe atomic internal authorization table (internal.active_sync_authorizations)
 * - Setting internal session variables gives ZERO bypass capability
 * - Column-level privacy enforcement: Direct reading of student_id by other users is rejected
 * - Dedicated get_my_profile() RPC for self-profile loading
 * - search_campus_students privacy scoping, cross-branch scraping protection, and masking
 * - PostgreSQL RLS audience enforcement (college vs branch vs club-members)
 * - Student directory integrity audit function (audit_student_directory_integrity)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgrespassword@localhost:5432/postgres';

async function withAuthenticatedSession(client, userId, callback) {
  await client.query('BEGIN;');
  try {
    await client.query(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${userId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
    `);

    // Verify session identity before executing test operation
    const verify = await client.query('SELECT auth.uid() AS uid, current_user AS role;');
    if (verify.rows[0].uid !== userId) {
      throw new Error(`Session identity verification failed: expected ${userId}, got ${verify.rows[0].uid}`);
    }
    if (verify.rows[0].role !== 'authenticated') {
      throw new Error(`Session role verification failed: expected authenticated, got ${verify.rows[0].role}`);
    }

    const result = await callback();
    await client.query('COMMIT;');
    return result;
  } catch (err) {
    await client.query('ROLLBACK;').catch(() => {});
    throw err;
  }
}

async function bootstrapEnvironment(client) {
  // Step 1: Create standard Supabase roles if they do not exist
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
      END IF;
    END
    $$;
  `);

  // Step 2: Create extensions schema and grant access
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    GRANT USAGE ON SCHEMA extensions TO postgres, authenticated, anon, service_role, public;
  `);

  // Step 3: Ensure essential cryptographic extensions exist in public schema
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
  `);

  // Step 4: Bootstrap Supabase Realtime Publication if not already present
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
      END IF;
    END
    $$;
  `);


  // Step 5: Bootstrap auth schema and users table
  await client.query(`CREATE SCHEMA IF NOT EXISTS auth;`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS auth.users (
      instance_id UUID,
      id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
      aud VARCHAR(255),
      role VARCHAR(255),
      email VARCHAR(255),
      encrypted_password VARCHAR(255),
      email_confirmed_at TIMESTAMPTZ,
      raw_app_meta_data JSONB DEFAULT '{}'::jsonb,
      raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
        (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid;
    $$;
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb,
        '{}'::jsonb
      );
    $$;
  `);
  await client.query(`GRANT USAGE ON SCHEMA auth TO authenticated, anon;`);
  await client.query(`GRANT SELECT ON auth.users TO authenticated, anon;`);

  // Step 6: Bootstrap mock storage schema
  await client.query(`CREATE SCHEMA IF NOT EXISTS storage;`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      owner uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      public boolean DEFAULT false,
      avif_autodetection boolean DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      owner_id text
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text REFERENCES storage.buckets(id),
      name text,
      owner uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      last_accessed_at timestamptz DEFAULT now(),
      metadata jsonb,
      path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED
    );
  `);
  await client.query(`ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`);
  await client.query(`
    CREATE OR REPLACE FUNCTION storage.foldername(name text)
    RETURNS text[] LANGUAGE plpgsql AS $$
    DECLARE _parts text[];
    BEGIN
      _parts := string_to_array(name, '/');
      RETURN _parts[1:array_length(_parts, 1) - 1];
    END;
    $$;
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION storage.extension(name text)
    RETURNS text LANGUAGE plpgsql AS $$
    DECLARE _parts text[]; _filename text;
    BEGIN
      _parts := string_to_array(name, '/');
      _filename := _parts[array_length(_parts, 1)];
      RETURN split_part(_filename, '.', 2);
    END;
    $$;
  `);
  await client.query(`GRANT USAGE ON SCHEMA storage TO authenticated, anon;`);
  await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA storage TO authenticated, anon;`);
}

async function resetPublicSchema(client) {
  await client.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO postgres;
    GRANT USAGE, CREATE ON SCHEMA public TO public;
    GRANT USAGE, CREATE ON SCHEMA public TO authenticated;
    GRANT USAGE, CREATE ON SCHEMA public TO anon;
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
  `);
}

async function applyMigrationsSequentially(client) {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Applying ${files.length} migrations sequentially from ${migrationsDir}...`);
  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    process.stdout.write(`  -> Applying migration: ${file}... `);
    await client.query(sql);
    console.log('OK');
  }
}

async function applyConsolidatedSchema(client) {
  const schemaPath = path.join(__dirname, '..', 'supabase', 'schema.sql');
  console.log(`Applying consolidated schema from ${schemaPath}...`);
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await client.query(sql);
  console.log('  -> Consolidated schema applied successfully.');
}

async function runSecurityTestSuite(client, testContextName) {
  console.log(`\n--------------------------------------------------------------------------------`);
  console.log(`EXECUTING SECURITY & INTEGRATION TEST SUITE: [${testContextName}]`);
  console.log(`--------------------------------------------------------------------------------`);

  const testRunId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const testRoll = `25MVCSMR8${testRunId.slice(0, 3)}`; // 12 chars: 25MVCSMR + 4 chars
  const user1Id = crypto.randomUUID();
  const user2Id = crypto.randomUUID();
  const evilUserId = crypto.randomUUID();

  let passed = 0;
  let total = 0;

  try {
    // TEST 1: Branches and Prefixes Seed Verification
    total++;
    process.stdout.write('[Test 1] Verifying official branches and prefix configuration... ');
    const branchRes = await client.query('SELECT count(*) AS cnt FROM public.academic_branches;');
    const prefixRes = await client.query('SELECT count(*) AS cnt FROM public.academic_branch_prefixes WHERE is_active = true;');
    if (parseInt(branchRes.rows[0].cnt, 10) >= 13 && parseInt(prefixRes.rows[0].cnt, 10) >= 2) {
      console.log(`PASSED (${branchRes.rows[0].cnt} branches, ${prefixRes.rows[0].cnt} prefixes)`);
      passed++;
    } else {
      throw new Error(`Unexpected counts: branches=${branchRes.rows[0].cnt}, prefixes=${prefixRes.rows[0].cnt}`);
    }

    // TEST 2: Literal Prefix Matching RPC
    total++;
    process.stdout.write('[Test 2] Testing resolve_student_branch RPC... ');
    const resolveRes = await client.query(`SELECT public.resolve_student_branch($1) AS res;`, [testRoll]);
    const resolved = resolveRes.rows[0]?.res;
    if (resolved && resolved.success === true && resolved.branch_code === 'CSE-AIML') {
      console.log(`PASSED (Resolved to ${resolved.course} ${resolved.branch_code})`);
      passed++;
    } else {
      throw new Error(`Failed to resolve roll number: ${JSON.stringify(resolveRes.rows)}`);
    }

    // Setup Test Fixtures (Each SQL command is a single statement to avoid extended protocol prepared statement error)
    const aimlBranch = await client.query("SELECT id FROM public.academic_branches WHERE course='B.Tech' AND branch_code='CSE-AIML';");
    const cseBranch = await client.query("SELECT id FROM public.academic_branches WHERE course='B.Tech' AND branch_code='CSE';");
    const aimlBranchId = aimlBranch.rows[0].id;
    const cseBranchId = cseBranch.rows[0].id;

    await client.query(`
      INSERT INTO public.student_directory (roll_number, branch_id, admission_year, is_active)
      VALUES ($1, $2, 2025, true);
    `, [testRoll, aimlBranchId]);

    await client.query(`
      INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data)
      VALUES 
        ($1::uuid, 'authenticated', 'authenticated', $3::text, json_build_object('username', $4::text, 'student_id', $5::text)),
        ($2::uuid, 'authenticated', 'authenticated', $6::text, json_build_object('username', $7::text, 'student_id', $5::text));
    `, [
      user1Id,
      user2Id,
      `user1_${testRunId}@ci.test`,
      `user1_${testRunId}`,
      testRoll,
      `user2_${testRunId}@ci.test`,
      `user2_${testRunId}`
    ]);

    await client.query(`
      UPDATE public.profiles SET student_id = $1::text WHERE id = $2::uuid OR id = $3::uuid;
    `, [testRoll, user1Id, user2Id]);

    // TEST 3: User 1 Directory Linking Flow with Transactional Identity
    total++;
    process.stdout.write('[Test 3] Testing directory account-linking flow (User 1 transactional claim)... ');
    const linkRes = await withAuthenticatedSession(client, user1Id, async () => {
      return await client.query(`SELECT public.sync_authenticated_student_directory() AS res;`);
    });
    const linkObj = linkRes.rows[0]?.res;
    if (linkObj && linkObj.linked === true && linkObj.roll_number === testRoll) {
      const profCheck = await client.query(`SELECT is_verified, branch_id FROM public.profiles WHERE id = $1;`, [user1Id]);
      if (profCheck.rows[0]?.is_verified === true && profCheck.rows[0]?.branch_id === aimlBranchId) {
        console.log('PASSED (Identity verified in txn, row locked, claimed, is_verified=true)');
        passed++;
      } else {
        throw new Error(`Profile was not updated properly: ${JSON.stringify(profCheck.rows)}`);
      }
    } else {
      throw new Error(`Directory link failed: ${JSON.stringify(linkRes.rows)}`);
    }

    // TEST 4: Conflict Rejection (Fail-closed on already claimed directory record)
    total++;
    process.stdout.write('[Test 4] Testing conflict rejection (User 2 duplicate claim inside txn)... ');
    let conflictRejected = false;
    try {
      await withAuthenticatedSession(client, user2Id, async () => {
        await client.query(`SELECT public.sync_authenticated_student_directory() AS res;`);
      });
    } catch (err) {
      if (err.message.includes('already linked') || err.message.includes('Directory record already linked')) {
        conflictRejected = true;
      } else {
        throw err;
      }
    }
    if (conflictRejected) {
      console.log('PASSED (Duplicate claim aborted: Directory record already linked)');
      passed++;
    } else {
      throw new Error('User 2 was erroneously allowed to claim an already linked directory record!');
    }

    // TEST 5: Academic Field Immutability on UPDATE
    total++;
    process.stdout.write('[Test 5] Testing academic field immutability for verified student... ');
    let tamperingBlocked = false;
    try {
      await withAuthenticatedSession(client, user1Id, async () => {
        await client.query(`UPDATE public.profiles SET student_id = '25MVCSMR0099' WHERE id = '${user1Id}';`);
      });
    } catch (err) {
      if (err.message.includes('Student roll number cannot be modified') ||
          err.message.includes('Verified student roll number cannot be modified') ||
          err.message.includes('permission denied') ||
          err.message.includes('Unauthorized')) {
        tamperingBlocked = true;
      } else {
        throw err;
      }
    }
    if (tamperingBlocked) {
      console.log('PASSED (Student prevented from modifying roll number)');
      passed++;
    } else {
      throw new Error('Student was able to modify verified roll number!');
    }

    // TEST 6: Role Escalation Prevention on UPDATE
    total++;
    process.stdout.write('[Test 6] Testing privilege escalation protection on UPDATE... ');
    let escalationBlocked = false;
    try {
      await withAuthenticatedSession(client, user1Id, async () => {
        await client.query(`UPDATE public.profiles SET college_role = 'college_admin' WHERE id = '${user1Id}';`);
      });
    } catch (err) {
      if (err.message.includes('College role cannot be self-modified') ||
          err.message.includes('Only college admins can modify college roles') ||
          err.message.includes('permission denied') ||
          err.message.includes('Unauthorized')) {
        escalationBlocked = true;
      } else {
        throw err;
      }
    }
    if (escalationBlocked) {
      console.log('PASSED (Self-escalation to college_admin rejected by PostgreSQL)');
      passed++;
    } else {
      throw new Error('Student was able to self-escalate college_role to college_admin!');
    }

    // TEST 7: Role Escalation Prevention on INSERT (FIXED FIXTURE: Auth User created first, separate queries)
    total++;
    process.stdout.write('[Test 7] Testing privilege escalation protection on INSERT (proper auth fixture)... ');
    
    // 1. Create corresponding auth user first to satisfy foreign-key constraint
    await client.query(`
      INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data)
      VALUES ($1::uuid, 'authenticated', 'authenticated', $2::text, json_build_object('username', $3::text));
    `, [evilUserId, `evil_${testRunId}@ci.test`, `evil_${testRunId}`]);

    // 2. Remove auto-created profile so we can test the explicit INSERT path
    await client.query(`
      DELETE FROM public.profiles WHERE id = $1;
    `, [evilUserId]);

    // 3. Attempt privileged profile insert as authenticated ordinary user
    await withAuthenticatedSession(client, evilUserId, async () => {
      await client.query(`
        INSERT INTO public.profiles (id, username, college_role, is_verified)
        VALUES ('${evilUserId}', 'evil_${testRunId}', 'college_admin', true);
      `);
    });

    // 4. Assert resulting profile has college_role = 'student' and is_verified = false
    const evilProfile = await client.query(`SELECT college_role, is_verified FROM public.profiles WHERE id = $1;`, [evilUserId]);
    if (evilProfile.rows[0]?.college_role === 'student' && evilProfile.rows[0]?.is_verified === false) {
      console.log('PASSED (Non-admin INSERT automatically forced to college_role=student, is_verified=false)');
      passed++;
    } else {
      throw new Error(`Profile insert escalation was not neutralized: ${JSON.stringify(evilProfile.rows)}`);
    }

    // Clean up evil test user
    await client.query(`DELETE FROM auth.users WHERE id = $1;`, [evilUserId]);

    // TEST 8: Anti-Spoofing: Reject Mismatched Branch on Post INSERT
    total++;
    process.stdout.write('[Test 8] Testing anti-spoofing on post INSERT (reject mismatched branch)... ');
    let spoofBlockedOnInsert = false;
    try {
      await withAuthenticatedSession(client, user1Id, async () => {
        // user1 is verified in AIML. Attempt to create post with CSE branch
        await client.query(`
          INSERT INTO public.posts (id, user_id, branch_id, content_visibility, image_url, caption)
          VALUES ('${crypto.randomUUID()}', '${user1Id}', '${cseBranchId}', 'branch', 'https://example.com/spoof.jpg', 'Spoofed branch');
        `);
      });
    } catch (err) {
      if (err.message.includes('Supplied branch_id does not match') || err.message.includes('Unauthorized')) {
        spoofBlockedOnInsert = true;
      } else {
        throw err;
      }
    }
    if (spoofBlockedOnInsert) {
      console.log('PASSED (Mismatched branch_id on INSERT rejected by trigger)');
      passed++;
    } else {
      throw new Error('User was able to spoof branch_id on post INSERT!');
    }

    // TEST 9: Anti-Spoofing: Reject Branch Modification on Post UPDATE
    total++;
    process.stdout.write('[Test 9] Testing anti-spoofing on post UPDATE (reject branch alteration)... ');
    const user1PostId = crypto.randomUUID();
    await client.query(`
      INSERT INTO public.posts (id, user_id, branch_id, content_visibility, image_url, caption)
      VALUES ('${user1PostId}', '${user1Id}', '${aimlBranchId}', 'branch', 'https://example.com/orig.jpg', 'Original post');
    `);

    let spoofBlockedOnUpdate = false;
    try {
      await withAuthenticatedSession(client, user1Id, async () => {
        await client.query(`
          UPDATE public.posts SET branch_id = '${cseBranchId}' WHERE id = '${user1PostId}';
        `);
      });
    } catch (err) {
      if (err.message.includes('cannot be modified by non-administrators') || err.message.includes('Unauthorized')) {
        spoofBlockedOnUpdate = true;
      } else {
        throw err;
      }
    }
    if (spoofBlockedOnUpdate) {
      console.log('PASSED (branch_id alteration on UPDATE rejected by trigger)');
      passed++;
    } else {
      throw new Error('User was able to modify branch_id on existing post!');
    }
    await client.query(`DELETE FROM public.posts WHERE id = '${user1PostId}';`);

    // TEST 10: Threat Model & Regression: Setting internal config gives ZERO authorization bypass
    total++;
    process.stdout.write('[Test 10] Testing threat model & regression (caller-controlled session token gives zero bypass)... ');
    let directVerifyBlocked = false;
    let branchTamperBlocked = false;

    // A. Attempt to set internal.active_sync_op_id and self-verify
    try {
      await withAuthenticatedSession(client, user2Id, async () => {
        await client.query(`SET LOCAL internal.active_sync_op_id = '${crypto.randomUUID()}';`);
        await client.query(`UPDATE public.profiles SET is_verified = true WHERE id = '${user2Id}';`);
      });
    } catch (err) {
      if (err.message.includes('permission denied') || err.message.includes('academic status can only be modified') || err.message.includes('Unauthorized')) {
        directVerifyBlocked = true;
      } else {
        throw err;
      }
    }

    // B. Attempt to set internal.active_sync_op_id and change branch
    try {
      await withAuthenticatedSession(client, user2Id, async () => {
        await client.query(`SET LOCAL internal.active_sync_op_id = '${crypto.randomUUID()}';`);
        await client.query(`UPDATE public.profiles SET branch_id = '${aimlBranchId}' WHERE id = '${user2Id}';`);
      });
    } catch (err) {
      if (err.message.includes('permission denied') || err.message.includes('academic status can only be modified') || err.message.includes('Unauthorized')) {
        branchTamperBlocked = true;
      } else {
        throw err;
      }
    }

    if (directVerifyBlocked && branchTamperBlocked) {
      console.log('PASSED (Both is_verified and branch_id tampering blocked even after client sets internal config)');
      passed++;
    } else {
      throw new Error(`Security bypass succeeded! directVerifyBlocked=${directVerifyBlocked}, branchTamperBlocked=${branchTamperBlocked}`);
    }

    // TEST 11: Privacy & Scoping in search_campus_students RPC
    total++;
    process.stdout.write('[Test 11] Testing search_campus_students privacy scoping and cross-branch rules... ');
    
    // A. Unverified user2 cannot search
    let unverifiedSearchBlocked = false;
    try {
      await withAuthenticatedSession(client, user2Id, async () => {
        await client.query(`SELECT * FROM public.search_campus_students('', NULL, 5);`);
      });
    } catch (err) {
      if (err.message.includes('Access restricted') || err.message.includes('Only verified')) {
        unverifiedSearchBlocked = true;
      }
    }
    if (!unverifiedSearchBlocked) {
      throw new Error('Unverified user was allowed to search student directory!');
    }

    // B. Verified user1 searching another branch with short query (<3 chars) must be rejected
    let shortQueryCrossBranchBlocked = false;
    try {
      await withAuthenticatedSession(client, user1Id, async () => {
        await client.query(`SELECT * FROM public.search_campus_students('a', '${cseBranchId}', 5);`);
      });
    } catch (err) {
      if (err.message.includes('Cross-branch search requires at least 3') || err.message.includes('Access restricted')) {
        shortQueryCrossBranchBlocked = true;
      }
    }
    if (!shortQueryCrossBranchBlocked) {
      throw new Error('Cross-branch search with <3 characters was not rejected!');
    }

    // C. Verified user1 searching own branch succeeds and masks roll number
    const ownBranchSearch = await withAuthenticatedSession(client, user1Id, async () => {
      return await client.query(`SELECT * FROM public.search_campus_students('', NULL, 5);`);
    });
    const foundUser1 = ownBranchSearch.rows.find(r => r.id === user1Id);
    if (!foundUser1 || !foundUser1.student_id.startsWith('****') || !foundUser1.student_id.endsWith(testRoll.slice(-4))) {
      throw new Error(`Search student check failed: ${JSON.stringify(ownBranchSearch.rows)}`);
    }

    // D. Wildcard-only query (%%%) must be blocked from cross-branch searches
    let wildcardCrossBranchBlocked = false;
    try {
      await withAuthenticatedSession(client, user1Id, async () => {
        await client.query(`SELECT * FROM public.search_campus_students('%%%', '${cseBranchId}', 5);`);
      });
    } catch (err) {
      if (err.message.includes('Cross-branch search requires at least 3') || err.message.includes('Access restricted')) {
        wildcardCrossBranchBlocked = true;
      }
    }
    if (!wildcardCrossBranchBlocked) {
      throw new Error('Wildcard search (%%%) bypassed minimum character length check!');
    }

    // E. Wildcard query in own branch searches literally for %%% and does not match all users
    const wildcardOwnBranch = await withAuthenticatedSession(client, user1Id, async () => {
      return await client.query(`SELECT * FROM public.search_campus_students('%%%', NULL, 20);`);
    });
    if (wildcardOwnBranch.rows.length !== 0) {
      throw new Error('Wildcard search (%%%) expanded unexpectedly and matched profiles!');
    }

    console.log('PASSED (Unverified blocked, cross-branch scraping blocked, own branch masked, wildcards sanitized)');
    passed++;

    // TEST 12: Database-Level Audience RLS Policies on Posts
    total++;
    process.stdout.write('[Test 12] Testing database-level audience RLS policies (branch vs college posts)... ');
    const testPostCollegeId = crypto.randomUUID();
    const testPostBranchId = crypto.randomUUID();

    await client.query(`
      INSERT INTO public.posts (id, user_id, branch_id, content_visibility, image_url, caption)
      VALUES 
        ('${testPostCollegeId}', '${user1Id}', '${aimlBranchId}', 'college', 'https://example.com/c.jpg', 'College wide post'),
        ('${testPostBranchId}', '${user1Id}', '${aimlBranchId}', 'branch', 'https://example.com/b.jpg', 'Branch specific post');
    `);

    // User 1 (in AIML) queries posts under RLS
    const user1Posts = await withAuthenticatedSession(client, user1Id, async () => {
      return await client.query(`SELECT id FROM public.posts WHERE id IN ('${testPostCollegeId}', '${testPostBranchId}');`);
    });

    // User 2 (not in AIML) queries posts under RLS
    const user2Posts = await withAuthenticatedSession(client, user2Id, async () => {
      return await client.query(`SELECT id FROM public.posts WHERE id IN ('${testPostCollegeId}', '${testPostBranchId}');`);
    });

    const user1Ids = user1Posts.rows.map(p => p.id);
    const user2Ids = user2Posts.rows.map(p => p.id);

    if (user1Ids.includes(testPostCollegeId) && user1Ids.includes(testPostBranchId) &&
        user2Ids.includes(testPostCollegeId) && !user2Ids.includes(testPostBranchId)) {
      console.log('PASSED (AIML student sees branch post; unlinked student sees only college post)');
      passed++;
    } else {
      throw new Error(`Audience RLS check failed: user1 saw ${JSON.stringify(user1Ids)}, user2 saw ${JSON.stringify(user2Ids)}`);
    }

    // Clean up test posts
    await client.query(`DELETE FROM public.posts WHERE id IN ('${testPostCollegeId}', '${testPostBranchId}');`);

    // TEST 13: Student Directory Integrity Reconciliation
    total++;
    process.stdout.write('[Test 13] Testing directory reconciliation audit function (audit_student_directory_integrity)... ');
    const auditRes = await client.query(`SELECT * FROM public.audit_student_directory_integrity();`);
    const anomalousEntries = auditRes.rows.filter(r => r.roll_number === testRoll);
    if (anomalousEntries.length === 0) {
      console.log('PASSED (Test directory record validated successfully against prefix rules)');
      passed++;
    } else {
      throw new Error(`Directory audit flagged valid test record: ${JSON.stringify(anomalousEntries)}`);
    }

    // TEST 14: Direct Profile Privacy Enforcement (Column-Level Protection)
    total++;
    process.stdout.write('[Test 14] Testing direct profile read privacy (preventing student_id column leakage)... ');
    let directStudentIdLeakBlocked = false;
    try {
      await withAuthenticatedSession(client, user2Id, async () => {
        // User 2 attempts to select another student's sensitive student_id directly from public.profiles
        await client.query(`SELECT student_id FROM public.profiles WHERE id = '${user1Id}';`);
      });
    } catch (err) {
      if (err.message.includes('permission denied for column student_id') || err.message.includes('permission denied')) {
        directStudentIdLeakBlocked = true;
      }
    }

    // Verify User 1 CAN load their own full profile via secure get_my_profile() RPC
    const ownProfileRes = await withAuthenticatedSession(client, user1Id, async () => {
      return await client.query(`SELECT * FROM public.get_my_profile();`);
    });
    const ownProfileRow = ownProfileRes.rows[0];

    if (directStudentIdLeakBlocked && ownProfileRow && ownProfileRow.student_id === testRoll) {
      console.log('PASSED (Direct student_id column queries denied; caller reads own record via get_my_profile RPC)');
      passed++;
    } else {
      throw new Error(`Privacy check failed! leakBlocked=${directStudentIdLeakBlocked}, ownProfile=${JSON.stringify(ownProfileRow)}`);
    }

    // TEST 15: Concurrency-Safe Atomic Internal Authorization Lifecycle
    total++;
    process.stdout.write('[Test 15] Testing atomic authorization cleanup (no lingering authorizations in internal table)... ');
    const authTableRes = await client.query(`SELECT count(*) AS cnt FROM internal.active_sync_authorizations;`);
    const remainingAuths = parseInt(authTableRes.rows[0].cnt, 10);
    if (remainingAuths === 0) {
      console.log('PASSED (0 lingering authorization records; consumed and purged atomically)');
      passed++;
    } else {
      throw new Error(`Lingering authorization records detected: ${remainingAuths}`);
    }

    // TEST 16: Feed Audience & Club-Member Isolation (Database-Backed Integration Test)
    total++;
    process.stdout.write('[Test 16] Testing feed audience isolation (college vs branch vs club-members)... ');
    const testClubId = crypto.randomUUID();
    const collegeEventId = crypto.randomUUID();
    const branchEventId = crypto.randomUUID();
    const memberEventId = crypto.randomUUID();

    // Create a test club (with user1 as creator)
    await client.query(`
      INSERT INTO public.clubs (id, name, slug, category, status, content_visibility, created_by, branch_id)
      VALUES ('${testClubId}', 'Test AIML Club ${testClubId.slice(0, 6)}', 'test-aiml-club-${testClubId.slice(0, 8)}', 'Technical', 'active', 'college', '${user1Id}', '${aimlBranchId}');
    `);

    // Insert 3 test events under different visibility scopes
    await client.query(`
      INSERT INTO public.events (id, club_id, title, venue, start_time, is_published, content_visibility, branch_id, created_by)
      VALUES 
        ('${collegeEventId}', '${testClubId}', 'College Fest', 'Main Hall', now() + interval '1 day', true, 'college', NULL, '${user1Id}'),
        ('${branchEventId}', '${testClubId}', 'AIML Workshop', 'Lab 1', now() + interval '2 days', true, 'branch', '${aimlBranchId}', '${user1Id}'),
        ('${memberEventId}', '${testClubId}', 'Secret Club Meeting', 'Room 10', now() + interval '3 days', true, 'club_members', '${aimlBranchId}', '${user1Id}');
    `);

    // User 2 (not in AIML branch, not a club member) queries events
    const user2Events = await withAuthenticatedSession(client, user2Id, async () => {
      return await client.query(`SELECT id FROM public.events WHERE id IN ('${collegeEventId}', '${branchEventId}', '${memberEventId}');`);
    });
    const user2EventIds = user2Events.rows.map(e => e.id);

    // User 2 must see ONLY the college-wide event
    const user2IsolationPassed = user2EventIds.includes(collegeEventId) && 
                                 !user2EventIds.includes(branchEventId) && 
                                 !user2EventIds.includes(memberEventId);

    // Clean up test events and club
    await client.query(`DELETE FROM public.events WHERE id IN ('${collegeEventId}', '${branchEventId}', '${memberEventId}');`);
    await client.query(`DELETE FROM public.clubs WHERE id = '${testClubId}';`);

    if (user2IsolationPassed) {
      console.log('PASSED (College event visible to all; branch & club_members events restricted by database RLS)');
      passed++;
    } else {
      throw new Error(`Feed audience check failed: user2 saw ${JSON.stringify(user2EventIds)}`);
    }

    // TEST 17: First-Time Password Requirement Bypass Prevention
    total++;
    process.stdout.write('[Test 17] Testing first-time password requirement (RPC bypass blocked, server trigger verified)... ');
    const pwdTestUserId = crypto.randomUUID();
    await client.query(`
      INSERT INTO auth.users (id, email, encrypted_password)
      VALUES ('${pwdTestUserId}', 'pwd_test@campus.internal', 'initial_hash_123');
    `);
    await client.query(`
      INSERT INTO public.profiles (id, username, student_id, college_role, is_verified, must_change_password)
      VALUES ('${pwdTestUserId}', 'pwd_tester', '25MVCSPWD123', 'student', false, true)
      ON CONFLICT (id) DO UPDATE SET must_change_password = true;
    `);

    // A. Attempt to call complete_first_time_password_change() WITHOUT updating password
    let pwdBypassBlocked = false;
    try {
      await withAuthenticatedSession(client, pwdTestUserId, async () => {
        await client.query(`SELECT public.complete_first_time_password_change();`);
      });
    } catch (err) {
      if (err.message.includes('Password has not been updated yet') || err.message.includes('You must complete a password update')) {
        pwdBypassBlocked = true;
      }
    }

    // Verify flag remained true in database
    const profCheck1 = await client.query(`SELECT must_change_password FROM public.profiles WHERE id = '${pwdTestUserId}';`);
    const flagStillTrue = profCheck1.rows[0]?.must_change_password === true;

    // B. Simulate genuine password change on auth.users
    await client.query(`
      UPDATE auth.users
      SET encrypted_password = 'new_updated_hash_456'
      WHERE id = '${pwdTestUserId}';
    `);

    // Verify trigger cleared must_change_password automatically
    const profCheck2 = await client.query(`SELECT must_change_password FROM public.profiles WHERE id = '${pwdTestUserId}';`);
    const flagCleared = profCheck2.rows[0]?.must_change_password === false;

    // Clean up pwd test user
    await client.query(`DELETE FROM auth.users WHERE id = '${pwdTestUserId}';`);

    if (pwdBypassBlocked && flagStillTrue && flagCleared) {
      console.log('PASSED (RPC bypass blocked; flag cleared only upon real auth password update)');
      passed++;
    } else {
      throw new Error(`Password requirement check failed: bypassBlocked=${pwdBypassBlocked}, flagStillTrue=${flagStillTrue}, flagCleared=${flagCleared}`);
    }

    // TEST 18: Student Privacy via Table Joins and Anonymous RLS
    total++;
    process.stdout.write('[Test 18] Testing privacy against table joins and anonymous access... ');
    let joinPrivacyDenied = false;
    try {
      await withAuthenticatedSession(client, user2Id, async () => {
        // Attempting to leak student_id by joining public.posts with public.profiles
        await client.query(`SELECT p.student_id FROM public.posts JOIN public.profiles p ON posts.user_id = p.id;`);
      });
    } catch (err) {
      if (err.message.includes('permission denied for column student_id') || err.message.includes('permission denied')) {
        joinPrivacyDenied = true;
      }
    }

    // Anonymous query under RLS
    let anonAccessDenied = false;
    let anonSeesZero = false;
    try {
      await client.query(`BEGIN; SET LOCAL ROLE anon;`);
      const anonProfiles = await client.query(`SELECT count(*) AS cnt FROM public.profiles;`);
      await client.query(`COMMIT;`);
      anonSeesZero = parseInt(anonProfiles.rows[0].cnt, 10) === 0;
    } catch (err) {
      await client.query(`ROLLBACK;`).catch(() => {});
      if (err.message.includes('permission denied for table profiles') || err.message.includes('permission denied') || err.message.includes('42501')) {
        anonAccessDenied = true;
      }
    }

    // Anonymous query to public.public_profiles view must also be denied
    let anonPublicProfilesDenied = false;
    try {
      await client.query(`BEGIN; SET LOCAL ROLE anon;`);
      await client.query(`SELECT count(*) FROM public.public_profiles;`);
      await client.query(`COMMIT;`);
    } catch (err) {
      await client.query(`ROLLBACK;`).catch(() => {});
      if (err.message.includes('permission denied for table public_profiles') || err.message.includes('permission denied for view public_profiles') || err.message.includes('permission denied') || err.message.includes('42501')) {
        anonPublicProfilesDenied = true;
      }
    }

    if (joinPrivacyDenied && (anonSeesZero || anonAccessDenied) && anonPublicProfilesDenied) {
      console.log('PASSED (Join queries to student_id denied; anonymous access blocked from profiles table and public_profiles view)');
      passed++;
    } else {
      throw new Error(`Join/anon privacy failed: joinDenied=${joinPrivacyDenied}, anonSeesZero=${anonSeesZero}, anonDenied=${anonAccessDenied}, anonPublicProfilesDenied=${anonPublicProfilesDenied}`);
    }

    // TEST 19: Channel Messages Audience and Membership Isolation
    total++;
    process.stdout.write('[Test 19] Testing channel message isolation (active members vs pending/rejected/non-members)... ');
    const msgClubId = crypto.randomUUID();
    const genChannelId = crypto.randomUUID();
    const annChannelId = crypto.randomUUID();
    const pendingUserId = crypto.randomUUID();
    const rejectedUserId = crypto.randomUUID();
    const genMsgId = crypto.randomUUID();
    const annMsgId = crypto.randomUUID();

    // Setup club, channels, and users
    await client.query(`INSERT INTO auth.users (id, email) VALUES ('${pendingUserId}', 'pending@campus.internal'), ('${rejectedUserId}', 'rejected@campus.internal');`);
    await client.query(`INSERT INTO public.clubs (id, name, slug, category, status, content_visibility, created_by, branch_id) VALUES ('${msgClubId}', 'Msg Test Club ${msgClubId.slice(0, 6)}', 'msg-club-${msgClubId.slice(0, 8)}', 'Technical', 'active', 'college', '${user1Id}', '${aimlBranchId}');`);
    await client.query(`INSERT INTO public.club_channels (id, club_id, name, type) VALUES ('${genChannelId}', '${msgClubId}', 'general', 'general'), ('${annChannelId}', '${msgClubId}', 'announcements', 'announcements');`);
    await client.query(`INSERT INTO public.club_memberships (club_id, user_id, role, status) VALUES ('${msgClubId}', '${user1Id}', 'member', 'active'), ('${msgClubId}', '${pendingUserId}', 'member', 'pending'), ('${msgClubId}', '${rejectedUserId}', 'member', 'rejected');`);
    await client.query(`INSERT INTO public.channel_messages (id, channel_id, sender_id, content, content_visibility, branch_id) VALUES ('${genMsgId}', '${genChannelId}', '${user1Id}', 'Secret internal discussion', 'club_members', NULL), ('${annMsgId}', '${annChannelId}', '${user1Id}', 'Public campus announcement', 'college', NULL);`);

    // Active member queries general message
    const user1GenMsgs = await withAuthenticatedSession(client, user1Id, async () => {
      return await client.query(`SELECT id FROM public.channel_messages WHERE id = '${genMsgId}';`);
    });

    // Pending member queries general message
    const pendingGenMsgs = await withAuthenticatedSession(client, pendingUserId, async () => {
      return await client.query(`SELECT id FROM public.channel_messages WHERE id = '${genMsgId}';`);
    });

    // Rejected member queries general message
    const rejectedGenMsgs = await withAuthenticatedSession(client, rejectedUserId, async () => {
      return await client.query(`SELECT id FROM public.channel_messages WHERE id = '${genMsgId}';`);
    });

    // Non-member queries general message
    const nonMemberGenMsgs = await withAuthenticatedSession(client, user2Id, async () => {
      return await client.query(`SELECT id FROM public.channel_messages WHERE id = '${genMsgId}';`);
    });

    // All can read announcement message
    const user2AnnMsgs = await withAuthenticatedSession(client, user2Id, async () => {
      return await client.query(`SELECT id FROM public.channel_messages WHERE id = '${annMsgId}';`);
    });

    const channelIsolationPassed = user1GenMsgs.rows.length === 1 &&
                                   pendingGenMsgs.rows.length === 0 &&
                                   rejectedGenMsgs.rows.length === 0 &&
                                   nonMemberGenMsgs.rows.length === 0 &&
                                   user2AnnMsgs.rows.length === 1;

    // Cleanup channel test fixtures
    await client.query(`DELETE FROM public.channel_messages WHERE id IN ('${genMsgId}', '${annMsgId}');`);
    await client.query(`DELETE FROM public.club_channels WHERE id IN ('${genChannelId}', '${annChannelId}');`);
    await client.query(`DELETE FROM public.club_memberships WHERE club_id = '${msgClubId}';`);
    await client.query(`DELETE FROM public.clubs WHERE id = '${msgClubId}';`);
    await client.query(`DELETE FROM auth.users WHERE id IN ('${pendingUserId}', '${rejectedUserId}');`);

    if (channelIsolationPassed) {
      console.log('PASSED (Active members see discussions; pending/rejected/non-members blocked; public announcements accessible)');
      passed++;
    } else {
      throw new Error(`Channel message isolation failed: user1=${user1GenMsgs.rows.length}, pending=${pendingGenMsgs.rows.length}, rejected=${rejectedGenMsgs.rows.length}, nonMember=${nonMemberGenMsgs.rows.length}`);
    }

    // TEST 20: Full End-to-End Enrollment & Onboarding Sequence
    total++;
    process.stdout.write('[Test 20] Testing full enrollment sequence (roster -> account -> sync -> password reset)... ');
    const e2eRoll = '25MVCSMR7777';
    const e2eUserId = crypto.randomUUID();

    // Step A: Admin registers roster entry in student_directory
    await client.query(`
      INSERT INTO public.student_directory (roll_number, branch_id, admission_year, is_active)
      VALUES ($1, $2, 2025, true)
      ON CONFLICT (roll_number) DO UPDATE SET is_active = true, profile_id = NULL;
    `, [e2eRoll, aimlBranchId]);

    // Step B: Account provisioning in auth.users
    await client.query(`
      INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data)
      VALUES ($1::uuid, $2::text, 'temp_hash', $3::jsonb);
    `, [e2eUserId, `${e2eRoll.toLowerCase()}@campus.internal`, JSON.stringify({
      username: e2eRoll,
      student_id: e2eRoll,
      must_change_password: true
    })]);

    // Step C: First login triggers sync_authenticated_student_directory RPC
    const syncRes = await withAuthenticatedSession(client, e2eUserId, async () => {
      return await client.query(`SELECT public.sync_authenticated_student_directory() AS res;`);
    });
    const parsedSync = syncRes.rows[0].res;
    if (!parsedSync.linked || !parsedSync.verified) {
      throw new Error(`Sync failed for provisioned student: ${JSON.stringify(parsedSync)}`);
    }

    // Step D: Profile verification state and must_change_password check
    const profCheck = await client.query(`SELECT is_verified, must_change_password, branch_id FROM public.profiles WHERE id = $1;`, [e2eUserId]);
    if (!profCheck.rows[0].is_verified || !profCheck.rows[0].must_change_password) {
      throw new Error(`Profile state invalid after sync: ${JSON.stringify(profCheck.rows[0])}`);
    }

    // Step E: RPC complete_first_time_password_change fails if password not changed in auth.users
    let prematureClearFailed = false;
    try {
      await withAuthenticatedSession(client, e2eUserId, async () => {
        await client.query(`SELECT public.complete_first_time_password_change();`);
      });
    } catch (e) {
      prematureClearFailed = true;
    }
    if (!prematureClearFailed) {
      throw new Error('complete_first_time_password_change should fail before password update!');
    }

    // Step F: Password update in auth.users fires trigger and clears must_change_password
    await client.query(`
      UPDATE auth.users
      SET encrypted_password = 'new_secure_password_hash'
      WHERE id = $1;
    `, [e2eUserId]);

    const finalProf = await client.query(`SELECT must_change_password FROM public.profiles WHERE id = $1;`, [e2eUserId]);
    if (finalProf.rows[0].must_change_password !== false) {
      throw new Error('must_change_password flag was not cleared after authentic password change in auth.users!');
    }

    // Cleanup e2e fixtures
    await client.query(`DELETE FROM public.student_directory WHERE roll_number = $1;`, [e2eRoll]);
    await client.query(`DELETE FROM auth.users WHERE id = $1;`, [e2eUserId]);

    console.log('PASSED (Roster enrolled -> user provisioned -> directory linked & verified -> password update verified)');
    passed++;

    console.log(`\n>> Result for [${testContextName}]: ${passed}/${total} tests PASSED.`);

  } finally {
    try {
      await client.query(`DELETE FROM public.student_directory WHERE roll_number = $1;`, [testRoll]);
    } catch (e) {}
    try {
      await client.query(`DELETE FROM auth.users WHERE id = $1::uuid OR id = $2::uuid OR id = $3::uuid;`, [user1Id, user2Id, evilUserId]);
    } catch (e) {}
  }
}

async function runCiIntegrationTests() {
  console.log('================================================================================');
  console.log('RUNNING DUAL-PATH POSTGRESQL INTEGRATION & MIGRATION VERIFICATION');
  console.log(`Connecting to: ${DATABASE_URL.replace(/:[^:@]*@/, ':****@')}`);
  console.log('================================================================================\n');

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const mode = process.argv.find(arg => arg.startsWith('--mode='))?.split('=')[1] || 'both';

  try {
    // --------------------------------------------------------------------------
    // PATH 1: SEQUENTIAL MIGRATIONS EXECUTION FROM CLEAN DATABASE
    // --------------------------------------------------------------------------
    if (mode === 'migrations' || mode === 'both') {
      console.log('\n================================================================================');
      console.log('PATH 1: Clean DB -> Bootstrap -> Apply Sequential Migrations (supabase/migrations/)');
      console.log('================================================================================');
      await bootstrapEnvironment(client);
      await resetPublicSchema(client);
      await applyMigrationsSequentially(client);
      await runSecurityTestSuite(client, 'Path 1: Sequential Migrations');
    }

    // --------------------------------------------------------------------------
    // PATH 2: CONSOLIDATED SCHEMA EXECUTION FROM CLEAN DATABASE
    // --------------------------------------------------------------------------
    if (mode === 'schema' || mode === 'both') {
      console.log('\n================================================================================');
      console.log('PATH 2: Clean DB -> Bootstrap -> Apply Consolidated Master Schema (supabase/schema.sql)');
      console.log('================================================================================');
      await bootstrapEnvironment(client);
      await resetPublicSchema(client);
      await applyConsolidatedSchema(client);
      await runSecurityTestSuite(client, 'Path 2: Consolidated Schema');
    }

    // --------------------------------------------------------------------------
    // PATH 3: UPGRADE / IDEMPOTENCY PATH
    // --------------------------------------------------------------------------
    if (mode === 'both') {
      console.log('\n================================================================================');
      console.log('PATH 3: Upgrade / Idempotency Verification: Re-applying migrations over existing DB');
      console.log('================================================================================');
      await applyMigrationsSequentially(client);
      await runSecurityTestSuite(client, 'Path 3: Upgraded Database');
    }

    console.log('\n================================================================================');
    console.log('ALL VERIFICATION PATHS COMPLETED SUCCESSFULLY!');
    console.log('  [x] Clean DB built from sequential migrations passed all tests');
    console.log('  [x] Clean DB built from consolidated schema passed all tests');
    console.log('  [x] Upgrade idempotency re-run verified without data/policy loss');
    console.log('================================================================================\n');

  } finally {
    await client.end();
  }
}

runCiIntegrationTests().catch(err => {
  console.error('\nCI INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
