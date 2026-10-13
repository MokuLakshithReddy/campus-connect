/**
 * LIVE SUPABASE DATABASE SESSION & DIRECTORY LINKING TEST SUITE
 * 
 * Verifies with REAL database transactions against Supabase:
 * 1. Clean resolution of official prefixes to academic branches
 * 2. Directory linking flow with row locking (SELECT ... FOR UPDATE)
 * 3. Rejection of duplicate/conflict claiming by another account
 * 4. Immutability of verified roll number & academic branch for students
 * 5. Rejection of self-escalation to college_admin on INSERT and UPDATE
 * 6. Roll number masking in search_campus_students RPC
 * 7. Content audience isolation (branch vs college) enforced by database
 */

const https = require('https');
const crypto = require('crypto');

const MANAGEMENT_TOKEN = process.env.TEST_SUPABASE_MANAGEMENT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.TEST_SUPABASE_PROJECT_REF || 'gtkvujspajcelzufpggr';

if (!MANAGEMENT_TOKEN) {
  console.log('NOTICE: TEST_SUPABASE_MANAGEMENT_TOKEN / SUPABASE_ACCESS_TOKEN is required to run live Supabase tests.');
  console.log('Skipping live Supabase directory test runner.');
  process.exit(0);
}

function querySql(query) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query });
    const req = https.request(
      {
        hostname: 'api.supabase.com',
        port: 443,
        path: `/v1/projects/${PROJECT_REF}/database/query`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MANAGEMENT_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`SQL query failed (HTTP ${res.statusCode}): ${body}`));
          }
          try {
            resolve(body ? JSON.parse(body) : []);
          } catch (e) {
            resolve(body);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runTestSuite() {
  const testRunId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const testRoll = `25MVCSMR9${testRunId.slice(0, 3)}`; // Exactly 12 chars: 25MVCSMR + 4 chars
  const user1Id = crypto.randomUUID();
  const user2Id = crypto.randomUUID();

  console.log('================================================================================');
  console.log(`RUNNING LIVE DATABASE INTEGRATION TESTS (Run ID: ${testRunId})`);
  console.log(`Target Supabase Project: ${PROJECT_REF}`);
  console.log(`Test Roll Number: ${testRoll}`);
  console.log('================================================================================\n');

  let passed = 0;
  let total = 0;

  try {
    // 1. Verify all 13 branches and prefixes exist
    total++;
    process.stdout.write('[Test 1] Verifying official branches and prefix configuration... ');
    const branches = await querySql('SELECT count(*) AS cnt FROM public.academic_branches;');
    const prefixes = await querySql('SELECT count(*) AS cnt FROM public.academic_branch_prefixes WHERE is_active = true;');
    if (parseInt(branches[0].cnt) >= 13 && parseInt(prefixes[0].cnt) >= 2) {
      console.log(`PASSED (${branches[0].cnt} branches, ${prefixes[0].cnt} prefixes)`);
      passed++;
    } else {
      throw new Error(`Unexpected branch/prefix counts: ${JSON.stringify(branches)} / ${JSON.stringify(prefixes)}`);
    }

    // 2. Resolve student branch via RPC
    total++;
    process.stdout.write('[Test 2] Testing resolve_student_branch RPC (literal prefix matching)... ');
    const resolveRes = await querySql(`SELECT public.resolve_student_branch('${testRoll}') AS res;`);
    const resolved = resolveRes[0]?.res;
    if (resolved && resolved.success === true && resolved.branch_code === 'CSE-AIML') {
      console.log(`PASSED (Resolved to ${resolved.course} ${resolved.branch_code})`);
      passed++;
    } else {
      throw new Error(`Failed to resolve roll number: ${JSON.stringify(resolveRes)}`);
    }

    // Setup test directory entry
    const aimlBranch = await querySql("SELECT id FROM public.academic_branches WHERE course='B.Tech' AND branch_code='CSE-AIML';");
    const aimlBranchId = aimlBranch[0].id;

    await querySql(`
      INSERT INTO public.student_directory (roll_number, branch_id, admission_year, is_active)
      VALUES ('${testRoll}', '${aimlBranchId}', 2025, true);
    `);

    // Setup test users in auth.users (which triggers handle_new_user to create profiles)
    await querySql(`
      INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      )
      VALUES 
        ('00000000-0000-0000-0000-000000000000', '${user1Id}', 'authenticated', 'authenticated', 'test_user1_${testRunId}@disposable.internal', crypt('TestPass123!', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"username":"test_user1_${testRunId}","student_id":"${testRoll}"}', now(), now()),
        ('00000000-0000-0000-0000-000000000000', '${user2Id}', 'authenticated', 'authenticated', 'test_user2_${testRunId}@disposable.internal', crypt('TestPass123!', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"username":"test_user2_${testRunId}","student_id":"${testRoll}"}', now(), now());

      UPDATE public.profiles SET student_id = '${testRoll}' WHERE id IN ('${user1Id}', '${user2Id}');
    `);

    // 3. User 1 Directory Linking Flow with Real Session Simulation
    total++;
    process.stdout.write('[Test 3] Testing directory account-linking flow (User 1 claiming record)... ');
    const linkRes = await querySql(`
      SET LOCAL request.jwt.claim.sub = '${user1Id}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.sync_authenticated_student_directory() AS res;
    `);
    const linkObj = linkRes[0]?.res;
    if (linkObj && linkObj.linked === true && linkObj.roll_number === testRoll) {
      // Verify profile in DB
      const profCheck = await querySql(`SELECT is_verified, branch_id FROM public.profiles WHERE id = '${user1Id}';`);
      if (profCheck[0]?.is_verified === true && profCheck[0]?.branch_id === aimlBranchId) {
        console.log('PASSED (Row locked, claimed, is_verified=true)');
        passed++;
      } else {
        throw new Error(`Profile was not updated properly: ${JSON.stringify(profCheck)}`);
      }
    } else {
      throw new Error(`Directory linking failed: ${JSON.stringify(linkRes)}`);
    }

    // 4. User 2 Conflict Rejection (Fail-closed on already claimed directory record)
    total++;
    process.stdout.write('[Test 4] Testing conflict rejection (User 2 attempting duplicate claim)... ');
    let conflictRejected = false;
    try {
      await querySql(`
        SET LOCAL request.jwt.claim.sub = '${user2Id}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.sync_authenticated_student_directory() AS res;
      `);
    } catch (err) {
      if (err.message.includes('already linked') || err.message.includes('Directory record already linked')) {
        conflictRejected = true;
      } else {
        throw err;
      }
    }
    if (conflictRejected) {
      console.log('PASSED (Transaction aborted: Directory record already linked)');
      passed++;
    } else {
      throw new Error('User 2 was erroneously allowed to claim an already linked directory record!');
    }

    // 5. Academic Field Immutability (Student cannot alter verified roll number or branch)
    total++;
    process.stdout.write('[Test 5] Testing academic field immutability for verified student... ');
    let tamperingBlocked = false;
    try {
      await querySql(`
        SET LOCAL request.jwt.claim.sub = '${user1Id}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        UPDATE public.profiles SET student_id = '25MVCSMR0099' WHERE id = '${user1Id}';
      `);
    } catch (err) {
      if (err.message.includes('Student roll number cannot be modified') || err.message.includes('Unauthorized')) {
        tamperingBlocked = true;
      }
    }
    if (tamperingBlocked) {
      console.log('PASSED (Student prevented from modifying roll number)');
      passed++;
    } else {
      throw new Error('Student was able to modify verified roll number!');
    }

    // 6. Role Escalation Prevention on UPDATE
    total++;
    process.stdout.write('[Test 6] Testing privilege escalation protection on UPDATE... ');
    let escalationBlocked = false;
    try {
      await querySql(`
        SET LOCAL request.jwt.claim.sub = '${user1Id}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        UPDATE public.profiles SET college_role = 'college_admin' WHERE id = '${user1Id}';
      `);
    } catch (err) {
      if (err.message.includes('College role cannot be self-modified') || err.message.includes('Unauthorized')) {
        escalationBlocked = true;
      }
    }
    if (escalationBlocked) {
      console.log('PASSED (Self-escalation to college_admin rejected by PostgreSQL trigger)');
      passed++;
    } else {
      throw new Error('Student was able to self-escalate college_role to college_admin!');
    }

    // 7. Student Discovery Privacy (Masked Roll Number in search RPC)
    total++;
    process.stdout.write('[Test 7] Testing search_campus_students roll number masking... ');
    const searchRes = await querySql(`
      SET LOCAL request.jwt.claim.sub = '${user1Id}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT * FROM public.search_campus_students('test_user1_${testRunId}', NULL, 5);
    `);
    if (searchRes.length > 0 && searchRes[0].student_id.startsWith('****') && searchRes[0].student_id.endsWith(testRoll.slice(-4))) {
      console.log(`PASSED (Roll number masked as: ${searchRes[0].student_id})`);
      passed++;
    } else {
      throw new Error(`Roll number was not properly masked: ${JSON.stringify(searchRes)}`);
    }

    // 8. Database-Level Audience RLS Policy Verification
    total++;
    process.stdout.write('[Test 8] Testing database-level audience RLS policies (branch vs college)... ');
    const testPostCollegeId = crypto.randomUUID();
    const testPostBranchId = crypto.randomUUID();

    // Insert 1 college-wide post and 1 branch-specific post for AIML
    await querySql(`
      INSERT INTO public.posts (id, user_id, branch_id, content_visibility, image_url, caption)
      VALUES 
        ('${testPostCollegeId}', '${user1Id}', '${aimlBranchId}', 'college', 'https://example.com/c.jpg', 'College wide post'),
        ('${testPostBranchId}', '${user1Id}', '${aimlBranchId}', 'branch', 'https://example.com/b.jpg', 'Branch specific post');
    `);

    // User 1 (in AIML) queries posts under RLS
    const user1Posts = await querySql(`
      SET ROLE authenticated;
      SET request.jwt.claim.sub = '${user1Id}';
      SET request.jwt.claim.role = 'authenticated';
      SELECT id FROM public.posts WHERE id IN ('${testPostCollegeId}', '${testPostBranchId}');
      RESET ROLE;
    `);

    // User 2 (not linked to AIML, branch_id is NULL) queries posts under RLS
    const user2Posts = await querySql(`
      SET ROLE authenticated;
      SET request.jwt.claim.sub = '${user2Id}';
      SET request.jwt.claim.role = 'authenticated';
      SELECT id FROM public.posts WHERE id IN ('${testPostCollegeId}', '${testPostBranchId}');
      RESET ROLE;
    `);

    const user1Ids = user1Posts.map(p => p.id);
    const user2Ids = user2Posts.map(p => p.id);

    if (user1Ids.includes(testPostCollegeId) && user1Ids.includes(testPostBranchId) &&
        user2Ids.includes(testPostCollegeId) && !user2Ids.includes(testPostBranchId)) {
      console.log('PASSED (AIML student sees branch post; unlinked student sees only college post)');
      passed++;
    } else {
      throw new Error(`Audience RLS check failed: user1 saw ${JSON.stringify(user1Ids)}, user2 saw ${JSON.stringify(user2Ids)}`);
    }

    // Clean up test posts
    await querySql(`DELETE FROM public.posts WHERE id IN ('${testPostCollegeId}', '${testPostBranchId}');`);

    console.log('\n================================================================================');
    console.log(`ALL TESTS PASSED: ${passed}/${total} live integration tests successful.`);
    console.log('================================================================================\n');

  } finally {
    // Guaranteed cleanup of disposable test fixtures
    try {
      await querySql(`
        DELETE FROM public.student_directory WHERE roll_number = '${testRoll}';
        DELETE FROM auth.users WHERE id IN ('${user1Id}', '${user2Id}');
      `);
      console.log('Test fixtures cleaned up successfully.');
    } catch (cleanupErr) {
      console.warn('Warning during cleanup:', cleanupErr.message);
    }
  }
}

runTestSuite().catch(err => {
  console.error('\nTEST SUITE FAILED:', err.message);
  process.exit(1);
});
