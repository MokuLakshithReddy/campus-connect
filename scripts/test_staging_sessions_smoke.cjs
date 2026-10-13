/**
 * STAGING SESSIONS SMOKE TEST SUITE
 * 
 * Verifies live database privileges, RLS policies, and RPC security barriers
 * across all 5 user session contexts against the deployed Supabase instance:
 * 1. Anonymous session
 * 2. Unverified student session
 * 3. Ordinary verified student session
 * 4. Club organizer session
 * 5. College administrator session
 */

const https = require('https');
const crypto = require('crypto');

const MANAGEMENT_TOKEN = process.env.TEST_SUPABASE_MANAGEMENT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.TEST_SUPABASE_PROJECT_REF;
const KNOWN_PRODUCTION_PROJECT_REF = 'gtkvujspajcelzufpggr';

if (!MANAGEMENT_TOKEN) {
  console.error('ERROR: SUPABASE_ACCESS_TOKEN or TEST_SUPABASE_MANAGEMENT_TOKEN environment variable is required.');
  process.exit(1);
}

if (!PROJECT_REF) {
  console.error('ERROR: TEST_SUPABASE_PROJECT_REF environment variable is required.');
  console.error('Defaulting to production or hardcoded projects has been disabled for safety.');
  process.exit(1);
}

if (PROJECT_REF === KNOWN_PRODUCTION_PROJECT_REF && process.env.ALLOW_PRODUCTION_TEST_RUN !== 'true') {
  console.error(`SAFETY GUARD ACTIVE: Target project reference matches production (${PROJECT_REF}).`);
  console.error('Refusing to execute mutating live test suites against production.');
  console.error('To override this safety barrier deliberately, set ALLOW_PRODUCTION_TEST_RUN=true.');
  process.exit(1);
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

async function runStagingSmokeTest() {
  const testRunId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const unverifiedStudentId = crypto.randomUUID();
  const verifiedStudentId = crypto.randomUUID();
  const organizerId = crypto.randomUUID();
  const outsiderOrganizerId = crypto.randomUUID();
  const targetStudentId = crypto.randomUUID();

  // Dynamically resolve college administrator fixture from test environment
  let adminId = process.env.TEST_ADMIN_USER_ID;
  if (!adminId) {
    const adminLookup = await querySql("SELECT id FROM public.profiles WHERE college_role = 'college_admin' LIMIT 1;");
    if (adminLookup && adminLookup.length > 0 && adminLookup[0]?.id) {
      adminId = adminLookup[0].id;
    } else {
      throw new Error("No college_admin user found in target database and TEST_ADMIN_USER_ID was not set.");
    }
  }

  const club1Id = crypto.randomUUID();
  const club2Id = crypto.randomUUID();
  const event1Id = crypto.randomUUID();
  const event2Id = crypto.randomUUID();

  console.log('================================================================================');
  console.log(`RUNNING STAGING SESSIONS SMOKE TEST SUITE (Run ID: ${testRunId})`);
  console.log(`Target Supabase Project: ${PROJECT_REF}`);
  console.log('================================================================================\n');

  let passed = 0;
  let total = 0;

  try {
    // 0. Setup fixtures in auth.users and clubs
    await querySql(`
      INSERT INTO auth.users (id, email)
      VALUES 
        ('${unverifiedStudentId}', 'unverified_${testRunId}@campus.internal'),
        ('${verifiedStudentId}', 'verified_${testRunId}@campus.internal'),
        ('${organizerId}', 'organizer_${testRunId}@campus.internal'),
        ('${outsiderOrganizerId}', 'outsider_${testRunId}@campus.internal'),
        ('${targetStudentId}', 'target_${testRunId}@campus.internal')
      ON CONFLICT (id) DO NOTHING;

      -- Create clubs
      INSERT INTO public.clubs (id, name, slug, category, status, content_visibility, created_by)
      VALUES 
        ('${club1Id}', 'Club Alpha ${testRunId}', 'alpha-${testRunId.toLowerCase()}', 'Technical', 'active', 'college', '${organizerId}'),
        ('${club2Id}', 'Club Beta ${testRunId}', 'beta-${testRunId.toLowerCase()}', 'Cultural', 'active', 'college', '${outsiderOrganizerId}');

      -- Club memberships
      INSERT INTO public.club_memberships (club_id, user_id, role, status)
      VALUES 
        ('${club1Id}', '${organizerId}', 'organizer', 'active'),
        ('${club2Id}', '${outsiderOrganizerId}', 'organizer', 'active');

      -- Events
      INSERT INTO public.events (id, club_id, title, description, venue, start_time, end_time, capacity, is_published, created_by)
      VALUES 
        ('${event1Id}', '${club1Id}', 'Alpha Event', 'Desc', 'Hall A', NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 2 hours', 100, true, '${organizerId}'),
        ('${event2Id}', '${club2Id}', 'Beta Event', 'Desc', 'Hall B', NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 2 hours', 100, true, '${outsiderOrganizerId}');
    `);

    // =========================================================================
    // 1. ANONYMOUS SESSION
    // =========================================================================
    total++;
    process.stdout.write('[Test 1.1] Anonymous Session: Table SELECT queries blocked or return 0 rows... ');
    let anonProfilesBlocked = false;
    try {
      const anonRes = await querySql(`
        BEGIN;
        SET LOCAL ROLE anon;
        SELECT count(*) FROM public.profiles;
        COMMIT;
      `);
      if (anonRes.length === 0 || anonRes[0].count === '0') {
        anonProfilesBlocked = true;
      }
    } catch (e) {
      if (e.message.includes('permission denied') || e.message.includes('42501')) {
        anonProfilesBlocked = true;
      }
    }
    if (anonProfilesBlocked) {
      console.log('PASSED (Anon profile access strictly denied)');
      passed++;
    } else {
      throw new Error('Anonymous session was able to read profiles!');
    }

    total++;
    process.stdout.write('[Test 1.2] Anonymous Session: RPC mutation rejected with Authentication Required... ');
    let anonRpcBlocked = false;
    try {
      await querySql(`
        BEGIN;
        SET LOCAL ROLE anon;
        SELECT public.register_for_event('${event1Id}');
        COMMIT;
      `);
    } catch (e) {
      if (e.message.includes('Authentication required') || e.message.includes('permission denied')) {
        anonRpcBlocked = true;
      }
    }
    if (anonRpcBlocked) {
      console.log('PASSED (Anon RPC invocation rejected)');
      passed++;
    } else {
      throw new Error('Anonymous session was able to execute register_for_event RPC!');
    }

    // =========================================================================
    // 2. UNVERIFIED STUDENT SESSION
    // =========================================================================
    total++;
    process.stdout.write('[Test 2.1] Unverified Student Session: Profile readable, is_verified=false... ');
    const unverifiedProfile = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${unverifiedStudentId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT is_verified, college_role FROM public.profiles WHERE id = '${unverifiedStudentId}';
      COMMIT;
    `);
    if (unverifiedProfile[0]?.is_verified === false && unverifiedProfile[0]?.college_role === 'student') {
      console.log('PASSED (Profile reflects unverified student status)');
      passed++;
    } else {
      throw new Error(`Unexpected unverified profile state: ${JSON.stringify(unverifiedProfile)}`);
    }

    total++;
    process.stdout.write('[Test 2.2] Unverified Student Session: Self-escalation to is_verified blocked... ');
    let selfVerifyBlocked = false;
    try {
      await querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${unverifiedStudentId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        UPDATE public.profiles SET is_verified = true WHERE id = '${unverifiedStudentId}';
        COMMIT;
      `);
    } catch (e) {
      if (e.message.includes('Unauthorized') || e.message.includes('verified directory synchronization') || e.message.includes('permission denied') || e.message.includes('42501')) {
        selfVerifyBlocked = true;
      }
    }
    if (selfVerifyBlocked) {
      console.log('PASSED (Self-verification blocked by database trigger)');
      passed++;
    } else {
      throw new Error('Unverified student was able to set is_verified = true!');
    }

    // =========================================================================
    // 3. ORDINARY STUDENT SESSION
    // =========================================================================
    total++;
    process.stdout.write('[Test 3.1] Ordinary Student Session: Event registration & cancellation lifecycle... ');
    const regRes = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${verifiedStudentId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.register_for_event('${event1Id}') AS res;
      COMMIT;
    `);
    const regData = regRes[0]?.res;
    if (regData?.success === true && regData.qr_code_token) {
      // Now cancel
      const cancelRes = await querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${verifiedStudentId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.cancel_event_registration('${event1Id}') AS res;
        COMMIT;
      `);
      if (cancelRes[0]?.res?.success === true) {
        console.log('PASSED (Student registered, received QR token, and successfully cancelled)');
        passed++;
      } else {
        throw new Error(`Cancellation failed: ${JSON.stringify(cancelRes)}`);
      }
    } else {
      throw new Error(`Registration failed: ${JSON.stringify(regRes)}`);
    }

    total++;
    process.stdout.write('[Test 3.2] Ordinary Student Session: Ticket check-in unauthorized... ');
    // Register verified student again so a valid token exists
    const regAgain = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${verifiedStudentId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.register_for_event('${event1Id}') AS res;
      COMMIT;
    `);
    const token = regAgain[0]?.res?.qr_code_token;

    let studentCheckinBlocked = false;
    try {
      await querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${unverifiedStudentId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.check_in_event_attendee('${event1Id}', '${token}');
        COMMIT;
      `);
    } catch (e) {
      if (e.message.includes('Unauthorized') || e.message.includes('Only event organizers')) {
        studentCheckinBlocked = true;
      }
    }
    if (studentCheckinBlocked) {
      console.log('PASSED (Ordinary student cannot scan tickets)');
      passed++;
    } else {
      throw new Error('Ordinary student was able to scan attendee ticket!');
    }

    // =========================================================================
    // 4. ORGANIZER SESSION
    // =========================================================================
    total++;
    process.stdout.write('[Test 4.1] Organizer Session: Authorized to check in attendee for OWN club event... ');
    const orgCheckin = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${organizerId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.check_in_event_attendee('${event1Id}', '${token}') AS res;
      COMMIT;
    `);
    if (orgCheckin[0]?.res?.success === true) {
      console.log('PASSED (Organizer successfully checked in attendee)');
      passed++;
    } else {
      throw new Error(`Organizer check-in failed: ${JSON.stringify(orgCheckin)}`);
    }

    total++;
    process.stdout.write('[Test 4.2] Organizer Session: Cross-club check-in strictly rejected... ');
    // Register verified student for Beta event (Club 2)
    const regBeta = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${verifiedStudentId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.register_for_event('${event2Id}') AS res;
      COMMIT;
    `);
    const betaToken = regBeta[0]?.res?.qr_code_token;

    // Organizer of Club 1 tries to check in attendee for Club 2 event
    let crossClubBlocked = false;
    try {
      await querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${organizerId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.check_in_event_attendee('${event2Id}', '${betaToken}');
        COMMIT;
      `);
    } catch (e) {
      if (e.message.includes('Unauthorized') || e.message.includes('Only event organizers')) {
        crossClubBlocked = true;
      }
    }
    if (crossClubBlocked) {
      console.log('PASSED (Club 1 organizer denied from checking in attendees for Club 2 event)');
      passed++;
    } else {
      throw new Error('Cross-club check-in erroneously succeeded!');
    }

    // =========================================================================
    // 5. COLLEGE ADMINISTRATOR SESSION
    // =========================================================================
    total++;
    process.stdout.write('[Test 5.1] Administrator Session: Non-admin calling verify_student_account blocked... ');
    let nonAdminVerifyBlocked = false;
    try {
      await querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${verifiedStudentId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.verify_student_account('${targetStudentId}', true);
        COMMIT;
      `);
    } catch (e) {
      if (e.message.includes('Unauthorized') || e.message.includes('Only college administrators')) {
        nonAdminVerifyBlocked = true;
      }
    }
    if (nonAdminVerifyBlocked) {
      console.log('PASSED (Student blocked from administrative verify_student_account RPC)');
      passed++;
    } else {
      throw new Error('Non-admin user was able to call verify_student_account!');
    }

    total++;
    process.stdout.write('[Test 5.2] Administrator Session: College admin verifies student account via RPC... ');
    const adminVerifyRes = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${adminId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.verify_student_account('${targetStudentId}', true) AS res;
      COMMIT;
    `);
    if (adminVerifyRes[0]?.res?.success === true) {
      const verifyCheck = await querySql(`SELECT is_verified FROM public.profiles WHERE id = '${targetStudentId}';`);
      if (verifyCheck[0]?.is_verified === true) {
        console.log('PASSED (Admin verified student profile, persisted successfully)');
        passed++;
      } else {
        throw new Error(`Target student is_verified did not persist: ${JSON.stringify(verifyCheck)}`);
      }
    } else {
      throw new Error(`Admin verification failed: ${JSON.stringify(adminVerifyRes)}`);
    }

    console.log('\n================================================================================');
    console.log(`ALL TESTS PASSED: ${passed}/${total} staging smoke test assertions successful.`);
    console.log('================================================================================\n');

  } finally {
    try {
      await querySql(`
        DELETE FROM public.event_registrations WHERE event_id IN ('${event1Id}', '${event2Id}');
        DELETE FROM public.events WHERE id IN ('${event1Id}', '${event2Id}');
        DELETE FROM public.club_memberships WHERE club_id IN ('${club1Id}', '${club2Id}');
        DELETE FROM public.clubs WHERE id IN ('${club1Id}', '${club2Id}');
        DELETE FROM auth.users WHERE id IN (
          '${unverifiedStudentId}', '${verifiedStudentId}', '${organizerId}', 
          '${outsiderOrganizerId}', '${targetStudentId}'
        );
      `);
      console.log('Staging test fixtures cleaned up successfully.');
    } catch (e) {
      console.error('Cleanup notice:', e.message);
    }
  }
}

runStagingSmokeTest().catch((err) => {
  console.error('\nSTAGING SMOKE TEST FAILED:', err.message);
  process.exit(1);
});
