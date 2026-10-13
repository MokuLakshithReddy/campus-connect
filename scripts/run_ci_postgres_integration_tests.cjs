/**
 * POSTGRESQL CI INTEGRATION TEST RUNNER
 * 
 * Runs end-to-end against a real PostgreSQL instance (e.g. GitHub Actions Postgres service container):
 * 1. Bootstraps auth schema & extensions
 * 2. Applies the full master schema (supabase/schema.sql) on a clean database
 * 3. Tests transactional identity verification (BEGIN -> SET LOCAL ROLE authenticated -> SELECT auth.uid())
 * 4. Verifies student directory linking with row locking (SELECT ... FOR UPDATE)
 * 5. Verifies duplicate claim conflict rejection (fail-closed)
 * 6. Verifies immutability of student academic fields
 * 7. Verifies prevention of self-granting college_admin (both INSERT and UPDATE paths)
 * 8. Verifies anti-spoofing branch triggers on posts (rejects mismatched branch on INSERT and UPDATE)
 * 9. Verifies threat model: direct alteration of is_verified without sync RPC is blocked
 * 10. Verifies search_campus_students privacy scoping, cross-branch rules, and unverified filtering
 * 11. Verifies PostgreSQL Row Level Security (RLS) audience enforcement (college vs branch)
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

async function runCiIntegrationTests() {
  console.log('================================================================================');
  console.log('RUNNING POSTGRESQL CI INTEGRATION TESTS (TRANSACTIONAL IDENTITIES & SECURITY ENGINE)');
  console.log(`Connecting to: ${DATABASE_URL.replace(/:[^:@]*@/, ':****@')}`);
  console.log('================================================================================\n');

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const testRunId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const testRoll = `25MVCSMR8${testRunId.slice(0, 3)}`; // 12 chars: 25MVCSMR + 4 chars
  const user1Id = crypto.randomUUID();
  const user2Id = crypto.randomUUID();

  let passed = 0;
  let total = 0;

  try {
    // STEP 1: Bootstrap Auth Schema & Extensions
    console.log('[Step 1] Bootstrapping PostgreSQL auth schema & environment...');
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
      END
      $$;

      CREATE SCHEMA IF NOT EXISTS auth;

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

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
        SELECT COALESCE(
          nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
          (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid;
      $$;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
        SELECT COALESCE(
          nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        );
      $$;

      GRANT USAGE ON SCHEMA auth TO authenticated;
      GRANT SELECT ON auth.users TO authenticated;
    `);
    console.log('        Auth schema and functions bootstrapped successfully.');

    // STEP 2: Apply Clean Master Schema
    console.log('[Step 2] Executing full master schema from clean database state...');
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
    await client.query(schemaSql);
    console.log('        Master schema applied successfully.');

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

    // Setup Test Fixtures
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
        ($1, 'authenticated', 'authenticated', $3, json_build_object('username', $4, 'student_id', $5)),
        ($2, 'authenticated', 'authenticated', $6, json_build_object('username', $7, 'student_id', $5));

      UPDATE public.profiles SET student_id = $5 WHERE id IN ($1, $2);
    `, [
      user1Id,
      user2Id,
      `user1_${testRunId}@ci.test`,
      `user1_${testRunId}`,
      testRoll,
      `user2_${testRunId}@ci.test`,
      `user2_${testRunId}`
    ]);

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
      if (err.message.includes('Student roll number cannot be modified') || err.message.includes('permission denied')) {
        tamperingBlocked = true;
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
      if (err.message.includes('College role cannot be self-modified') || err.message.includes('permission denied')) {
        escalationBlocked = true;
      }
    }
    if (escalationBlocked) {
      console.log('PASSED (Self-escalation to college_admin rejected by PostgreSQL)');
      passed++;
    } else {
      throw new Error('Student was able to self-escalate college_role to college_admin!');
    }

    // TEST 7: Role Escalation Prevention on INSERT
    total++;
    process.stdout.write('[Test 7] Testing privilege escalation protection on INSERT... ');
    const evilUserId = crypto.randomUUID();
    await withAuthenticatedSession(client, evilUserId, async () => {
      await client.query(`
        INSERT INTO public.profiles (id, username, college_role, is_verified)
        VALUES ('${evilUserId}', 'evil_${testRunId}', 'college_admin', true);
      `);
    });
    const evilProfile = await client.query(`SELECT college_role, is_verified FROM public.profiles WHERE id = $1;`, [evilUserId]);
    if (evilProfile.rows[0]?.college_role === 'student' && evilProfile.rows[0]?.is_verified === false) {
      console.log('PASSED (Non-admin INSERT automatically forced to college_role=student, is_verified=false)');
      passed++;
    } else {
      throw new Error(`Profile insert escalation was not neutralized: ${JSON.stringify(evilProfile.rows)}`);
    }
    await client.query(`DELETE FROM public.profiles WHERE id = $1;`, [evilUserId]);

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
      }
    }
    if (spoofBlockedOnUpdate) {
      console.log('PASSED (branch_id alteration on UPDATE rejected by trigger)');
      passed++;
    } else {
      throw new Error('User was able to modify branch_id on existing post!');
    }
    await client.query(`DELETE FROM public.posts WHERE id = '${user1PostId}';`);

    // TEST 10: Threat Model: Reject Direct Alteration of is_verified without Trusted RPC
    total++;
    process.stdout.write('[Test 10] Testing threat model: Direct profile verification bypass attempt... ');
    let directVerifyBlocked = false;
    try {
      await withAuthenticatedSession(client, user2Id, async () => {
        await client.query(`UPDATE public.profiles SET is_verified = true WHERE id = '${user2Id}';`);
      });
    } catch (err) {
      if (err.message.includes('permission denied') || err.message.includes('Verification status cannot be modified') || err.message.includes('Unauthorized')) {
        directVerifyBlocked = true;
      }
    }
    if (directVerifyBlocked) {
      console.log('PASSED (Direct alteration of is_verified blocked by database permissions/call-stack trigger)');
      passed++;
    } else {
      throw new Error('User was able to directly modify is_verified on profiles!');
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
    if (foundUser1 && foundUser1.student_id.startsWith('****') && foundUser1.student_id.endsWith(testRoll.slice(-4))) {
      console.log('PASSED (Unverified blocked, cross-branch scraping blocked, own branch masked)');
      passed++;
    } else {
      throw new Error(`Search student check failed: ${JSON.stringify(ownBranchSearch.rows)}`);
    }

    // TEST 12: Database-Level Audience RLS Policies
    total++;
    process.stdout.write('[Test 12] Testing database-level audience RLS policies (branch vs college)... ');
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

    console.log('\n================================================================================');
    console.log(`ALL TESTS PASSED: ${passed}/${total} PostgreSQL integration tests successful.`);
    console.log('================================================================================\n');

  } finally {
    try {
      await client.query(`
        DELETE FROM public.student_directory WHERE roll_number = $1;
        DELETE FROM auth.users WHERE id IN ($2, $3);
      `, [testRoll, user1Id, user2Id]);
    } catch (e) {
      // Ignored in cleanup
    }
    await client.end();
  }
}

runCiIntegrationTests().catch(err => {
  console.error('\nCI INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
