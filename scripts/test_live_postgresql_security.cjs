const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'gtkvujspajcelzufpggr';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_PAT || '';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || `https://${SUPABASE_PROJECT_REF}.supabase.co`;
const PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_fr0wwYVpS66JH1qHwbUxbA_QJ8uNjMk';

// Helper to run SQL via Management API
function runSql(query) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query });
    const req = https.request(
      {
        hostname: 'api.supabase.com',
        port: 443,
        path: `/v1/projects/${SUPABASE_PROJECT_REF}/database/query`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: body ? JSON.parse(body) : null });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runSecurityIntegrationSuite() {
  if (!ACCESS_TOKEN) {
    console.log('Skipping live DB setup: SUPABASE_ACCESS_TOKEN or SUPABASE_PAT environment variable not set.');
    process.exit(0);
  }

  console.log('================================================================');
  console.log('STARTING POSTGRESQL LIVE DATABASE SECURITY INTEGRATION TEST SUITE');
  console.log('================================================================');

  // Step 0: Ensure test student user 24CS0142 has known credentials
  console.log('\n[Setup] Setting password for 24cs0142@campus.internal...');
  await runSql(`
    UPDATE auth.users 
    SET encrypted_password = crypt('24CS0142', gen_salt('bf'))
    WHERE email = '24cs0142@campus.internal';

    UPDATE public.profiles
    SET college_role = 'student', is_verified = false, must_change_password = true
    WHERE id = (SELECT id FROM auth.users WHERE email = '24cs0142@campus.internal');
  `);

  const studentClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY);

  const { data: authData, error: authErr } = await studentClient.auth.signInWithPassword({
    email: '24cs0142@campus.internal',
    password: '24CS0142',
  });

  if (authErr || !authData.user) {
    console.error('Failed to authenticate test student:', authErr);
    process.exit(1);
  }

  const studentId = authData.user.id;
  console.log(`Authenticated as student: ${authData.user.email} (${studentId})`);

  // Ensure a test club exists
  await runSql(`
    INSERT INTO public.clubs (name, slug, category, description, status)
    VALUES ('Security Testing Club', 'security-testing-club', 'Technical', 'Automated security validation', 'active')
    ON CONFLICT (name) DO NOTHING;
  `);

  const { data: clubs } = await studentClient
    .from('clubs')
    .select('id')
    .eq('slug', 'security-testing-club')
    .single();

  const clubId = clubs?.id;
  console.log(`Using test club ID: ${clubId}`);

  let passedTests = 0;
  let totalTests = 0;

  // TEST 1: Privilege Escalation via Club Membership Insertion
  totalTests++;
  console.log('\n--- Test 1: Malicious Club Membership Insertion (Attempting role="president", status="active") ---');
  // First clear any existing membership
  await runSql(`DELETE FROM public.club_memberships WHERE user_id = '${studentId}' AND club_id = '${clubId}';`);

  const { data: memInsert, error: memErr } = await studentClient
    .from('club_memberships')
    .insert({
      club_id: clubId,
      user_id: studentId,
      role: 'president',
      status: 'active',
    })
    .select()
    .maybeSingle();

  if (memErr) {
    // If rejected by RLS WITH CHECK, that's secure!
    console.log('Result: REJECTED by PostgreSQL RLS Policy (Secure!):', memErr.message);
    passedTests++;
  } else if (memInsert) {
    // If allowed through, trigger MUST have forced role='member' and status='pending'
    if (memInsert.role === 'member' && memInsert.status === 'pending') {
      console.log('Result: SANITIZED by PostgreSQL Trigger to role="member" and status="pending" (Secure!)');
      passedTests++;
    } else {
      console.error('CRITICAL FAILURE: Student self-assigned leadership role!', memInsert);
    }
  }

  // TEST 2: Notification Forging by Student
  totalTests++;
  console.log('\n--- Test 2: Malicious Notification Forging (Student attempting client INSERT) ---');
  const { data: notifData, error: notifErr } = await studentClient
    .from('notifications')
    .insert({
      user_id: studentId,
      type: 'announcement',
      title: 'Forged Administrative Announcement',
      message: 'This notification should be rejected by PostgreSQL RLS',
    })
    .select();

  if (notifErr) {
    console.log('Result: REJECTED by PostgreSQL RLS Policy (Secure!):', notifErr.message);
    passedTests++;
  } else {
    console.error('CRITICAL FAILURE: Student successfully inserted arbitrary notification!', notifData);
  }

  // TEST 3: Self-Elevation of Privileges in Profiles (college_role / is_verified)
  totalTests++;
  console.log('\n--- Test 3: Self-Elevation of Privileges in Profile UPDATE (Attempting college_role="college_admin", is_verified=true) ---');
  const { data: profUpdate, error: profErr } = await studentClient
    .from('profiles')
    .update({
      college_role: 'college_admin',
      is_verified: true,
    })
    .eq('id', studentId)
    .select();

  if (profErr) {
    console.log('Result: REJECTED by PostgreSQL Trigger (Secure!):', profErr.message);
    passedTests++;
  } else {
    // Verify whether the values actually changed in the database
    const { data: currentProf } = await studentClient
      .from('profiles')
      .select('college_role, is_verified')
      .eq('id', studentId)
      .single();

    if (currentProf.college_role !== 'college_admin' && !currentProf.is_verified) {
      console.log('Result: Blocked/Ignored by PostgreSQL (Secure!)');
      passedTests++;
    } else {
      console.error('CRITICAL FAILURE: Student self-elevated to college_admin / verified!', currentProf);
    }
  }

  // TEST 4: Storage Avatar Upload to Another Student's Directory
  totalTests++;
  console.log('\n--- Test 4: Cross-User Storage Access (Attempting upload to another user ID path) ---');
  const foreignUserId = '00000000-0000-0000-0000-000000000000';
  const dummyBuffer = Buffer.from('fake image content');

  const { error: storageErr } = await studentClient.storage
    .from('avatars')
    .upload(`${foreignUserId}/unauthorized.png`, dummyBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (storageErr) {
    console.log('Result: REJECTED by PostgreSQL Storage Policy (Secure!):', storageErr.message);
    passedTests++;
  } else {
    console.error('CRITICAL FAILURE: Student uploaded to another user\'s avatar directory!');
  }

  // TEST 5: Legitimate Storage Avatar Upload to Own Directory
  totalTests++;
  console.log('\n--- Test 5: Legitimate Storage Upload (Uploading to own user ID path) ---');
  const ownPath = `${studentId}/avatar_${Date.now()}.png`;
  const { data: ownUpload, error: ownStorageErr } = await studentClient.storage
    .from('avatars')
    .upload(ownPath, dummyBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (ownStorageErr) {
    console.error('FAILURE: Legitimate upload to own folder failed:', ownStorageErr);
  } else {
    console.log('Result: SUCCESS: Legitimate avatar uploaded successfully to own path:', ownUpload.path);
    passedTests++;
    // Clean up uploaded test artifact
    await studentClient.storage.from('avatars').remove([ownPath]);
  }

  console.log('\n================================================================');
  console.log(`INTEGRATION SUITE COMPLETED: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('================================================================');

  if (passedTests === totalTests) {
    console.log('ALL POSTGRESQL SECURITY CONSTRAINTS VERIFIED DIRECTLY ON LIVE DATABASE!');
  } else {
    process.exit(1);
  }
}

runSecurityIntegrationSuite().catch((err) => {
  console.error('Suite error:', err);
  process.exit(1);
});
