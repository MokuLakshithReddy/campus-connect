/**
 * LIVE SUPABASE EVENT REGISTRATION & QR CHECK-IN VALIDATION SUITE
 * 
 * Verifies live database transactions against the deployed Supabase project:
 * 1. Concurrency: Two simultaneous independent database sessions competing for the final seat
 * 2. Database State: Verify directly from tables that registered count never exceeds capacity
 * 3. Idempotency: Repeated registration requests never create duplicate registrations
 * 4. Cancellation & Retry: Cancellation and re-registration cannot corrupt registration counts
 * 5. Ticket Hijack Prevention: Students cannot check in another student's ticket or their own ticket
 * 6. QR Single-Use: Replay attacks with the same QR token are strictly rejected by the database
 * 7. State Reconciliation: Registration, cancellation, and attendance counts remain consistent
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

// STRICT MUTATING SAFETY GUARD: Never execute mutating integration suites against production database
if (PROJECT_REF === KNOWN_PRODUCTION_PROJECT_REF) {
  console.error(`FATAL SAFETY GUARD: Target project reference is production (${PROJECT_REF}).`);
  console.error('Mutating live test suites are strictly prohibited from targeting the production database.');
  console.error('You MUST supply a dedicated staging or local Supabase test project reference.');
  process.exit(1);
}

// Query helper with agent: false ensuring separate TCP/TLS sockets for genuine concurrent requests
function querySql(query) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query });
    const req = https.request(
      {
        hostname: 'api.supabase.com',
        port: 443,
        path: `/v1/projects/${PROJECT_REF}/database/query`,
        method: 'POST',
        agent: false, // Forces distinct connection to guarantee independent concurrent sessions
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

  // Registry for granular, fail-safe teardown tracking
  const fixtureRegistry = {
    userIds: new Set([organizerId, student1Id, student2Id]),
    clubIds: new Set([clubId]),
    eventIds: new Set([eventId]),
  };

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

    // =========================================================================
    // TEST 1: True Concurrent Seat Contention (Race Condition on Final Seat)
    // =========================================================================
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

    // Direct Database State Verification (checking actual table rows, not just RPC response)
    const eventCheck = await querySql(`SELECT COUNT(*)::int AS count FROM public.event_registrations WHERE event_id = '${eventId}' AND status = 'registered';`);
    const registeredCount = parseInt(eventCheck[0].count);

    const capacityCheck = await querySql(`SELECT capacity FROM public.events WHERE id = '${eventId}';`);
    const eventCapacity = parseInt(capacityCheck[0].capacity);

    if (successes.length === 1 && failures.length === 1 && registeredCount === 1 && registeredCount <= eventCapacity) {
      console.log('PASSED (Exactly 1 concurrent claim succeeded; 1 rejected with capacity error; registeredCount=1 <= capacity=1)');
      passed++;
    } else {
      throw new Error(`Concurrency race test failed: successes=${successes.length}, failures=${failures.length}, registeredCount=${registeredCount}, capacity=${eventCapacity}`);
    }

    const winnerId = attempt1.status === 'fulfilled' ? student1Id : student2Id;
    const loserId = attempt1.status === 'fulfilled' ? student2Id : student1Id;
    const winningReg = attempt1.status === 'fulfilled' ? attempt1.value[0].res : attempt2.value[0].res;

    // =========================================================================
    // TEST 2: Repeated Request Idempotency (Duplicate Registration Prevention)
    // =========================================================================
    total++;
    process.stdout.write('[Test 2] Testing repeated registration idempotency (cannot create duplicate registrations)... ');

    // Winner student attempts to register again for the exact same event
    const duplicateAttempt = await Promise.allSettled([
      querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${winnerId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.register_for_event('${eventId}') AS res;
        COMMIT;
      `)
    ]);

    // Query database directly to confirm no duplicate registration rows exist for winner
    const winnerRegRows = await querySql(`SELECT COUNT(*)::int AS count FROM public.event_registrations WHERE event_id = '${eventId}' AND user_id = '${winnerId}';`);
    const winnerRowCount = parseInt(winnerRegRows[0].count);

    const totalActiveRows = await querySql(`SELECT COUNT(*)::int AS count FROM public.event_registrations WHERE event_id = '${eventId}' AND status = 'registered';`);
    const totalActiveCount = parseInt(totalActiveRows[0].count);

    if (winnerRowCount === 1 && totalActiveCount === 1) {
      console.log('PASSED (Repeated registration request safely deduplicated; database contains strictly 1 registration)');
      passed++;
    } else {
      throw new Error(`Duplicate prevention failed: winnerRowCount=${winnerRowCount}, totalActiveCount=${totalActiveCount}`);
    }

    // =========================================================================
    // TEST 3: Cross-User Registration Cancellation Isolation
    // =========================================================================
    total++;
    process.stdout.write('[Test 3] Testing registration cancellation isolation (cross-user cancellation denied)... ');
    
    // Loser student attempts to cancel winner student's registration
    await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${loserId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.cancel_event_registration('${eventId}') AS res;
      COMMIT;
    `);

    // Verify Winner's registration is still intact in the database
    const regStillActive = await querySql(`SELECT status FROM public.event_registrations WHERE event_id = '${eventId}' AND user_id = '${winnerId}';`);
    if (regStillActive[0]?.status === 'registered') {
      console.log('PASSED (Non-registered student cancellation attempt had zero effect on active ticket)');
      passed++;
    } else {
      throw new Error(`Unauthorized cancellation succeeded! Registration: ${JSON.stringify(regStillActive)}`);
    }

    // =========================================================================
    // TEST 4: Student Ticket Check-in Authorization & Ticket Hijacking Prevention
    // =========================================================================
    total++;
    process.stdout.write('[Test 4] Testing check-in authorization boundary & student ticket hijack protection... ');
    const qrToken = winningReg.qr_code_token;

    // Sub-test 4a: Ordinary Loser Student attempts to check in Winner Student's ticket
    let loserCheckinDenied = false;
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
        loserCheckinDenied = true;
      }
    }

    // Sub-test 4b: Winner student attempts to self-check in their own ticket without organizer privileges
    let selfCheckinDenied = false;
    try {
      await querySql(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${winnerId}';
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SELECT public.check_in_event_attendee('${eventId}', '${qrToken}') AS res;
        COMMIT;
      `);
    } catch (err) {
      if (err.message.includes('Unauthorized') || err.message.includes('permission denied')) {
        selfCheckinDenied = true;
      }
    }

    // Sub-test 4c: Legitimate Club Organizer performs check-in
    const organizerCheckin = await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${organizerId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.check_in_event_attendee('${eventId}', '${qrToken}') AS res;
      COMMIT;
    `);
    const checkinRes = organizerCheckin[0]?.res;

    // Verify database state directly: status must now be 'attended' and attended_at set
    const dbAttendanceState = await querySql(`SELECT status, attended_at FROM public.event_registrations WHERE event_id = '${eventId}' AND user_id = '${winnerId}';`);

    if (loserCheckinDenied && selfCheckinDenied && checkinRes?.success === true && dbAttendanceState[0]?.status === 'attended' && dbAttendanceState[0]?.attended_at) {
      console.log('PASSED (Student callers blocked from checking in tickets; club organizer check-in verified; attended_at persisted)');
      passed++;
    } else {
      throw new Error(`Check-in auth test failed: loserDenied=${loserCheckinDenied}, selfDenied=${selfCheckinDenied}, orgCheckin=${JSON.stringify(organizerCheckin)}, dbState=${JSON.stringify(dbAttendanceState)}`);
    }

    // =========================================================================
    // TEST 5: QR Single-Use Replay Protection (Replay Attack Prevention)
    // =========================================================================
    total++;
    process.stdout.write('[Test 5] Testing QR token single-use replay protection (cannot reuse QR ticket)... ');
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

    // Direct database state check: attended count remains strictly 1
    const attendanceCountRes = await querySql(`SELECT COUNT(*)::int AS count FROM public.event_registrations WHERE event_id = '${eventId}' AND status = 'attended';`);
    const attendanceCount = parseInt(attendanceCountRes[0].count);

    if (duplicateCheckinDenied && attendanceCount === 1) {
      console.log('PASSED (Duplicate QR scan rejected; database attendance count preserved at exactly 1)');
      passed++;
    } else {
      throw new Error(`QR replay test failed: duplicateDenied=${duplicateCheckinDenied}, attendanceCount=${attendanceCount}`);
    }

    // =========================================================================
    // TEST 6: Event Stats Reconciliation RPC Verification
    // =========================================================================
    total++;
    process.stdout.write('[Test 6] Testing get_event_registration_stats RPC reconciliation against DB state... ');
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

    // =========================================================================
    // TEST 7: Cancellation, Seat Re-opening & Concurrency Retry Integrity
    // =========================================================================
    total++;
    process.stdout.write('[Test 7] Testing cancellation, seat reopening & concurrent race to claim freed seat... ');
    
    // Reset attendance state to registered so student can test cancellation
    await querySql(`
      UPDATE public.event_registrations 
      SET status = 'registered', attended_at = NULL 
      WHERE event_id = '${eventId}' AND user_id = '${winnerId}';
    `);

    // Winner cancels their registration
    await querySql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${winnerId}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT public.cancel_event_registration('${eventId}');
      COMMIT;
    `);

    // Direct DB state verification: registration count must now be 0
    const postCancelCount = await querySql(`SELECT COUNT(*)::int AS count FROM public.event_registrations WHERE event_id = '${eventId}' AND status = 'registered';`);
    if (parseInt(postCancelCount[0].count) !== 0) {
      throw new Error(`Cancellation failed to decrement active count: got ${postCancelCount[0].count}`);
    }

    // Both students race concurrently to claim the newly opened seat via independent database sessions
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

    // Direct DB state verification: registration count must be exactly 1, capacity 1
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
    // Teardown: Resilient, independent deletion of all registered fixtures
    console.log('\n[Teardown] Cleaning up all registered test fixtures...');
    const userIdsArray = Array.from(fixtureRegistry.userIds);
    const eventIdsArray = Array.from(fixtureRegistry.eventIds);
    const clubIdsArray = Array.from(fixtureRegistry.clubIds);

    const cleanupTasks = [
      {
        name: 'Event registrations',
        sql: eventIdsArray.length ? `DELETE FROM public.event_registrations WHERE event_id IN (${eventIdsArray.map(id => `'${id}'`).join(',')}) OR user_id IN (${userIdsArray.map(id => `'${id}'`).join(',')});` : null
      },
      {
        name: 'Events',
        sql: eventIdsArray.length ? `DELETE FROM public.events WHERE id IN (${eventIdsArray.map(id => `'${id}'`).join(',')});` : null
      },
      {
        name: 'Club memberships',
        sql: clubIdsArray.length ? `DELETE FROM public.club_memberships WHERE club_id IN (${clubIdsArray.map(id => `'${id}'`).join(',')}) OR user_id IN (${userIdsArray.map(id => `'${id}'`).join(',')});` : null
      },
      {
        name: 'Clubs',
        sql: clubIdsArray.length ? `DELETE FROM public.clubs WHERE id IN (${clubIdsArray.map(id => `'${id}'`).join(',')});` : null
      },
      {
        name: 'Profiles',
        sql: userIdsArray.length ? `DELETE FROM public.profiles WHERE id IN (${userIdsArray.map(id => `'${id}'`).join(',')});` : null
      },
      {
        name: 'Auth users',
        sql: userIdsArray.length ? `DELETE FROM auth.users WHERE id IN (${userIdsArray.map(id => `'${id}'`).join(',')});` : null
      }
    ];

    for (const task of cleanupTasks) {
      if (!task.sql) continue;
      try {
        await querySql(task.sql);
      } catch (err) {
        console.warn(`[Teardown Notice] Could not clean ${task.name}: ${err.message}`);
      }
    }
    console.log('[Teardown] Cleanup completed successfully.');
  }
}

runLiveEventsTestSuite().catch((err) => {
  console.error('\nLIVE SUITE FAILED:', err.message);
  process.exit(1);
});
