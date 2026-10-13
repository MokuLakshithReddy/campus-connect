/**
 * ISOLATED FULL PASSWORD ONBOARDING FLOW TEST SUITE
 * 
 * Safety Rules Enforced:
 * 1. Requires explicit TEST_SUPABASE_PROJECT_REF and rejects production project by default.
 * 2. Never touches real student accounts, IDs, or roll numbers.
 * 3. Uses a 100% disposable test account created specifically for this run.
 * 4. Verifies the complete first-time password reset lifecycle:
 *    - Creation with must_change_password: true
 *    - Sign-in with temporary password
 *    - Rejection of complete_first_time_password_change prior to password change
 *    - Password update via client.auth.updateUser
 *    - Successful first-time password completion RPC
 *    - Verification of updated must_change_password: false flag
 * 5. Guarantees safe cleanup of the disposable test account in a finally block.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PROJECT_REF = process.env.TEST_SUPABASE_PROJECT_REF;
const KNOWN_PRODUCTION_PROJECT_REF = 'gtkvujspajcelzufpggr';
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLISHABLE_KEY = process.env.TEST_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SERVICE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY (or TEST_SUPABASE_SERVICE_ROLE_KEY) is required.');
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

if (!PUBLISHABLE_KEY) {
  console.error('ERROR: TEST_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY) is required.');
  process.exit(1);
}

const supabaseUrl = process.env.TEST_SUPABASE_URL || `https://${PROJECT_REF}.supabase.co`;
const adminClient = createClient(supabaseUrl, SERVICE_KEY, { auth: { persistSession: false } });
const userClient = createClient(supabaseUrl, PUBLISHABLE_KEY, { auth: { persistSession: false } });

async function runPasswordFlowTest() {
  const testRunId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const testEmail = `disposable_pwd_${testRunId.toLowerCase()}@campus.internal`;
  const initialPassword = `TempPass#${testRunId}!`;
  const newPassword = `NewSecurePass#${testRunId}!`;
  let testUserId = null;

  console.log('================================================================================');
  console.log(`RUNNING ISOLATED PASSWORD ONBOARDING FLOW TEST (Run ID: ${testRunId})`);
  console.log(`Target Project: ${PROJECT_REF}`);
  console.log(`Disposable User: ${testEmail}`);
  console.log('================================================================================\n');

  try {
    // 1. Create a dedicated disposable student account
    console.log('[Step 1] Creating disposable test account with must_change_password=true...');
    const { data: createData, error: createErr } = await adminClient.auth.admin.createUser({
      email: testEmail,
      password: initialPassword,
      email_confirm: true,
      user_metadata: {
        username: `disp_${testRunId.toLowerCase()}`,
        must_change_password: true
      }
    });

    if (createErr || !createData?.user?.id) {
      throw new Error(`Failed to create disposable test user: ${createErr?.message || 'No user ID returned'}`);
    }

    testUserId = createData.user.id;
    console.log(`- Created disposable test user: ${testUserId}`);

    // Verify initial profile state has must_change_password=true
    const { data: initialProfile, error: profErr } = await adminClient
      .from('profiles')
      .select('id, must_change_password')
      .eq('id', testUserId)
      .maybeSingle();

    if (profErr || !initialProfile) {
      throw new Error(`Failed to query initial profile for disposable user: ${profErr?.message || 'Profile not found'}`);
    }

    if (initialProfile.must_change_password !== true) {
      throw new Error(`Initial must_change_password invariant violation: expected true, got ${initialProfile.must_change_password}`);
    }
    console.log('- Verified: initial must_change_password is true');

    // 2. Sign in as disposable student with temporary password
    console.log('\n[Step 2] Signing in as disposable student with temporary password...');
    const { data: signData, error: signErr } = await userClient.auth.signInWithPassword({
      email: testEmail,
      password: initialPassword
    });

    if (signErr || !signData?.session) {
      throw new Error(`Sign in with temporary password failed: ${signErr?.message}`);
    }
    console.log(`- Signed in successfully as ${signData.user.email}`);

    // 3. Attempt to bypass password change by calling completion RPC prematurely
    console.log('\n[Step 3] Testing bypass prevention: calling complete_first_time_password_change before password update...');
    const { data: prematureRpcData, error: prematureRpcErr } = await userClient.rpc('complete_first_time_password_change');
    if (!prematureRpcErr) {
      throw new Error('SECURITY VIOLATION: complete_first_time_password_change succeeded without changing password!');
    }
    console.log('- PASSED: Premature completion RPC was rejected as expected:', prematureRpcErr.message);

    // 4. Update password via auth service
    console.log('\n[Step 4] Updating password via client.auth.updateUser...');
    const { data: updateData, error: updateErr } = await userClient.auth.updateUser({
      password: newPassword
    });

    if (updateErr) {
      throw new Error(`Password update failed: ${updateErr.message}`);
    }
    console.log('- Password updated successfully in auth service');

    // 5. Invoke completion RPC after genuine password update
    console.log('\n[Step 5] Calling complete_first_time_password_change after password update...');
    const { data: rpcData, error: rpcErr } = await userClient.rpc('complete_first_time_password_change');
    if (rpcErr) {
      throw new Error(`complete_first_time_password_change failed after valid update: ${rpcErr.message}`);
    }
    console.log('- PASSED: Completion RPC succeeded:', rpcData);

    // 6. Verify profile now reflects must_change_password=false
    console.log('\n[Step 6] Verifying updated profile must_change_password flag...');
    const { data: finalProfile, error: finalProfErr } = await adminClient
      .from('profiles')
      .select('id, must_change_password')
      .eq('id', testUserId)
      .maybeSingle();

    if (finalProfErr || !finalProfile) {
      throw new Error(`Failed to query final profile: ${finalProfErr?.message}`);
    }

    if (finalProfile.must_change_password !== false) {
      throw new Error(`Expected must_change_password to be false, got ${finalProfile.must_change_password}`);
    }
    console.log('- PASSED: must_change_password flag successfully updated to false');

    console.log('\n================================================================================');
    console.log('ALL TESTS PASSED: Full password onboarding flow verified safely.');
    console.log('================================================================================\n');

  } finally {
    if (testUserId) {
      try {
        console.log(`[Cleanup] Deleting disposable test user ${testUserId}...`);
        await adminClient.auth.admin.deleteUser(testUserId);
        console.log('- Disposable test user deleted successfully.');
      } catch (cleanErr) {
        console.warn('Warning during test cleanup:', cleanErr.message);
      }
    }
  }
}

runPasswordFlowTest().catch(err => {
  console.error('\nPASSWORD FLOW TEST FAILED:', err.message);
  process.exit(1);
});
