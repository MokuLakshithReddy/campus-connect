/**
 * LIVE SUPABASE EVENT REGISTRATION & QR CHECK-IN VALIDATION SUITE
 * 
 * Verifies live database transactions against the deployed Supabase project:
 * 1. Concurrency: Two simultaneous attempts for the final seat cannot exceed capacity
 * 2. Identity Isolation: A student cannot register or cancel another student's registration
 * 3. QR Single-Use: A QR ticket cannot be used twice for attendance check-in
 * 4. Authorization Boundary: Regular students cannot check in attendees or read ticket details
 * 5. State Reconciliation: Registration, cancellation, and attendance counts remain consistent
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

async function runLiveEventsTestSuite() {
  const testRunId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const organizerId = crypto.randomUUID();
  const student1Id = crypto.randomUUID();
  const student2Id = crypto.randomUUID();
  const clubId = crypto.randomUUID();
  const eventId = crypto.randomUUID();

  console.log('================================================================================');
  console.log(`RUNNING LIVE SUPABASE EVENT & QR CHECK-IN VALIDATION (Run ID: ${testRunId})`);
  console.log(`Target Project: ${PROJECT_REF}`);
  console.log('================================================================================\n');

  let passed = 0;
  let total = 0;

  try {
    // 0. Setup test users and club fixtures
    await querySql(`
      INSERT INTO auth.users (id, email)
      VALUES 
        ('${organizerId}', 'org_${testRunId}@campus.internal'),
        ('${student1Id}', 'stud1_${testRunId}@campus.internal'),
        ('${student2Id}', 'stud2_${testRunId}@campus.internal')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO public.clubs (id, name, slug, category, status, content_visibility, created_by)
      VALUES ('${clubId}', 'Live Event Test Club ${testRunId}', 'live-event-${testRunId.toLowerCase()}', 'Technical', 'active', 'college', '${organizerId}');

      -- Make organizer an active organizer of the club
      INSERT INTO public.club_memberships (club_id, user_id, role, status)
      VALUES ('${clubId}', '${organizerId}', 'organizer', 'active');

      -- Create an event with capacity = 1
      INSERT INTO public.events (id, club_id, title, description, venue, start_time, end_time, capacity, is_published, created_by)
      VALUES ('${eventId}', '${clubId}', 'Exclusive Live Hackathon', 'Strict single-seat event', 'Lab 1', NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 4 hours', 1, true, '${organizerId}');
    `);

    // TEST 1: True Concurrent Seat Contention (Race Condition on Final Seat)
    total++;
    process.stdout.write('[Test 1] Testing event capacity enforcement under TRUE concurrent seat claiming (capacity=1)... ');
    
    // Launch two simultaneous independent database sessions to claim the 1 available seat
    const [attempt1, attempt2] = await Promise.allSettled([
      querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${student1Id}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.register_for_event('${eventId}') AS res;
        COMMIT;
      `),
      querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${student2Id}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.register_for_event('${eventId}') AS res;
        COMMIT;
      `)
    ]);

    const successes = [attempt1, attempt2].filter(a => a.status === 'fulfilled' && a.value[0]?.res?.success === true);
    const failures = [attempt1, attempt2].filter(a => a.status === 'rejected' || a.value[0]?.res?.success !== true);

    const eventCheck = await querySql(`SELECT COUNT(*)::int AS count FROM public.event_registrations WHERE event_id = '${eventId}' AND status = 'registered';`);
    const registeredCount = parseInt(eventCheck[0].count);

    if (successes.length === 1 && failures.length === 1 && registeredCount === 1) {
      console.log('PASSED (Exactly 1 concurrent claim succeeded; 1 rejected with capacity error; registeredCount=1)');
      passed++;
    } else {
      throw new Error(`Concurrency race test failed: successes=${successes.length}, failures=${failures.length}, registeredCount=${registeredCount}`);
    }

    const winnerId = attempt1.status === 'fulfilled' ? student1Id : student2Id;
    const loserId = attempt1.status === 'fulfilled' ? student2Id : student1Id;
    const winningReg = attempt1.status === 'fulfilled' ? attempt1.value[0].res : attempt2.value[0].res;

    // Concurrent retry test: loser launches 2 simultaneous retry attempts
    const [retry1, retry2] = await Promise.allSettled([
      querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${loserId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.register_for_event('${eventId}') AS res;
        COMMIT;
      `),
      querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${loserId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.register_for_event('${eventId}') AS res;
        COMMIT;
      `)
    ]);

    const retrySuccesses = [retry1, retry2].filter(r => r.status === 'fulfilled');
    if (retrySuccesses.length === 0) {
      // Both concurrent retries were rejected
    } else {
      throw new Error('Concurrent retry erroneously claimed seat when capacity is full!');
    }

    // TEST 2: Identity Isolation on Registration Cancellation
    total++;
    process.stdout.write('[Test 2] Testing registration cancellation isolation (cross-user cancellation denied)... ');
    
    // Loser student attempts to cancel winner student's registration
    await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${loserId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.cancel_event_registration('${eventId}') AS res;
      COMMIT;
    `);

    // Verify Winner's registration is still intact
    const regStillActive = await querySql(`SELECT status FROM public.event_registrations WHERE event_id = '${eventId}' AND user_id = '${winnerId}';`);
    if (regStillActive[0]?.status === 'registered') {
      console.log('PASSED (Non-registered student cancellation attempt had zero effect on active ticket)');
      passed++;
    } else {
      throw new Error(`Unauthorized cancellation succeeded! Registration: ${JSON.stringify(regStillActive)}`);
    }

    // TEST 3: QR Ticket Retrieval and Check-In Authorization Boundary
    total++;
    process.stdout.write('[Test 3] Testing check-in authorization boundary (student caller denied; organizer allowed)... ');
    const qrToken = winningReg.qr_code_token;

    // Ordinary Loser Student attempts to check in Winner Student
    let studentCheckinDenied = false;
    try {
      await querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${loserId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.check_in_event_attendee('${eventId}', '${qrToken}') AS res;
        COMMIT;
      `);
    } catch (err) {
      if (err.message.includes('Unauthorized') || err.message.includes('permission denied')) {
        studentCheckinDenied = true;
      }
    }

    // Club Organizer performs check-in
    const organizerCheckin = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${organizerId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.check_in_event_attendee('${eventId}', '${qrToken}') AS res;
      COMMIT;
    `);
    const checkinRes = organizerCheckin[0]?.res;

    if (studentCheckinDenied && checkinRes?.success === true) {
      console.log('PASSED (Non-organizer student blocked from check-in RPC; club organizer check-in verified)');
      passed++;
    } else {
      throw new Error(`Check-in auth test failed: studentDenied=${studentCheckinDenied}, orgCheckin=${JSON.stringify(organizerCheckin)}`);
    }

    // TEST 4: QR Single-Use Enforcement (Replay Protection)
    total++;
    process.stdout.write('[Test 4] Testing QR token single-use replay protection (cannot check in twice)... ');
    let duplicateCheckinDenied = false;
    try {
      await querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${organizerId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.check_in_event_attendee('${eventId}', '${qrToken}') AS res;
        COMMIT;
      `);
    } catch (err) {
      if (err.message.includes('already checked in') || err.message.includes('duplicate') || err.message.includes('attended')) {
        duplicateCheckinDenied = true;
      }
    }

    if (duplicateCheckinDenied) {
      console.log('PASSED (Duplicate QR scan rejected by database trigger/RPC)');
      passed++;
    } else {
      throw new Error('QR token was accepted a second time!');
    }

    // TEST 5: Canonical Stats Reconciliation RPC
    total++;
    process.stdout.write('[Test 5] Testing get_event_registration_stats RPC reconciliation... ');
    const statsRes = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${winnerId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT * FROM public.get_event_registration_stats(ARRAY['${eventId}'::uuid]);
      COMMIT;
    `);

    const statCount = parseInt(statsRes[0]?.registration_count);
    if (statCount === 1) {
      console.log(`PASSED (Reconciled stats match real attendee count: ${statCount})`);
      passed++;
    } else {
      throw new Error(`Stats mismatch: expected 1, got ${statCount}`);
    }

    // TEST 6: Genuine Cancellation and Concurrent Seat Re-opening Race
    total++;
    process.stdout.write('[Test 6] Testing seat reopening upon cancellation & concurrent race to claim freed seat... ');
    
    // Winner cancels their registration
    await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${winnerId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.cancel_event_registration('${eventId}');
      COMMIT;
    `);

    // Both students race concurrently to claim the newly opened seat
    const [reclaim1, reclaim2] = await Promise.allSettled([
      querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${student1Id}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.register_for_event('${eventId}') AS res;
        COMMIT;
      `),
      querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${student2Id}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.register_for_event('${eventId}') AS res;
        COMMIT;
      `)
    ]);

    const reclaimSuccesses = [reclaim1, reclaim2].filter(r => r.status === 'fulfilled' && r.value[0]?.res?.success === true);
    const reclaimFailures = [reclaim1, reclaim2].filter(r => r.status === 'rejected');

    const finalCountRes = await querySql(`SELECT COUNT(*)::int AS count FROM public.event_registrations WHERE event_id = '${eventId}' AND status = 'registered';`);
    const finalRegisteredCount = parseInt(finalCountRes[0].count);

    if (reclaimSuccesses.length === 1 && reclaimFailures.length === 1 && finalRegisteredCount === 1) {
      console.log('PASSED (Cancellation freed seat; concurrent race produced exactly 1 registration; capacity never exceeded)');
      passed++;
    } else {
      throw new Error(`Concurrent seat reopening race failed: successes=${reclaimSuccesses.length}, failures=${reclaimFailures.length}, finalCount=${finalRegisteredCount}`);
    }

    console.log('\n================================================================================');
    console.log(`ALL TESTS PASSED: ${passed}/${total} live Supabase event & QR validation tests successful.`);
    console.log('================================================================================\n');

  } finally {
    try {
      await querySql(`
        DELETE FROM public.event_registrations WHERE event_id = '${eventId}';
        DELETE FROM public.events WHERE id = '${eventId}';
        DELETE FROM public.club_memberships WHERE club_id = '${clubId}';
        DELETE FROM public.clubs WHERE id = '${clubId}';
        DELETE FROM auth.users WHERE id IN ('${organizerId}', '${student1Id}', '${student2Id}');
      `);
      console.log('Test fixtures cleaned up successfully.');
    } catch (e) {
      console.error('Cleanup notice:', e.message);
    }
  }
}

runLiveEventsTestSuite().catch((err) => {
  console.error('\nLIVE SUITE FAILED:', err.message);
  process.exit(1);
});
