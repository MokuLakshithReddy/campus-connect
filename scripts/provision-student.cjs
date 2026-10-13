/**
 * Provision a student account in Supabase
 * Usage: SUPABASE_SERVICE_ROLE_KEY=<secret> node scripts/provision-student.cjs <ROLL_NUMBER> [DEPARTMENT] [YEAR] [FULL_NAME]
 * Example: SUPABASE_SERVICE_ROLE_KEY=<secret> node scripts/provision-student.cjs 25MVCSMR9A1B "CSE-AIML" "1st Year" "Student Name"
 */
const https = require('https');

const SUPABASE_PROJECT_URL = process.env.VITE_SUPABASE_URL
  ? process.env.VITE_SUPABASE_URL.replace(/^https?:\/\//, '')
  : 'gtkvujspajcelzufpggr.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is required.");
  console.error("Usage: SUPABASE_SERVICE_ROLE_KEY=<secret> node scripts/provision-student.cjs <ROLL_NUMBER> [DEPARTMENT] [YEAR] [FULL_NAME]");
  process.exit(1);
}

// Roll number is strictly required — no misleading fallback defaults
const rawRollNumber = process.argv[2];
if (!rawRollNumber || rawRollNumber.trim().length === 0) {
  console.error("ERROR: Roll number is required as the first argument.");
  console.error("Usage: node scripts/provision-student.cjs <ROLL_NUMBER> [DEPARTMENT] [YEAR] [FULL_NAME]");
  process.exit(1);
}

const rollNumber = rawRollNumber.trim().toUpperCase();

// Roll numbers must match the canonical 12-character format
const ROLL_REGEX = /^[0-9]{2}[A-Z]{4,6}[0-9A-Z]{4,6}$/;
if (rollNumber.length !== 12 || !ROLL_REGEX.test(rollNumber)) {
  console.error(`ERROR: Invalid roll number format '${rollNumber}'. Expected 12-character alphanumeric roll number.`);
  process.exit(1);
}

const department = process.argv[3] || 'Computer Science & Engineering';
const year = process.argv[4] || '1st Year';
const fullName = process.argv[5] || rollNumber;
const email = `${rollNumber.toLowerCase()}@campus.internal`;
const temporaryPassword = rollNumber; // Initial onboarding credential set to roll number

function sendRequest(options, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (body) {
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            parsed = body;
          }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed, rawBody: body });
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

/**
 * Distinguishes an HTTP/API transport error from a genuine missing record in student_directory.
 * Throws on API/HTTP failure; returns null ONLY when query succeeds with 0 matching rows.
 */
async function verifyDirectoryRecord(roll) {
  const options = {
    hostname: SUPABASE_PROJECT_URL,
    path: `/rest/v1/student_directory?roll_number=eq.${encodeURIComponent(roll)}&select=roll_number,branch_id,admission_year,is_active,profile_id`,
    method: 'GET',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
    }
  };

  const res = await sendRequest(options);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const errorDetails = typeof res.body === 'object' && res.body?.message 
      ? res.body.message 
      : res.rawBody || `HTTP ${res.statusCode}`;
    throw new Error(`Student directory API query failed (HTTP ${res.statusCode}): ${errorDetails}`);
  }
  if (!Array.isArray(res.body)) {
    throw new Error(`Unexpected Directory API response payload format: ${res.rawBody}`);
  }
  return res.body[0] || null;
}

/**
 * Resolves the roll number's official academic branch via database RPC resolve_student_branch.
 * Validates that the roll number has a recognized active academic branch prefix.
 */
async function resolveBranchForRoll(roll) {
  const options = {
    hostname: SUPABASE_PROJECT_URL,
    path: '/rest/v1/rpc/resolve_student_branch',
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  const res = await sendRequest(options, { p_roll_number: roll });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const errorDetails = typeof res.body === 'object' && res.body?.message 
      ? res.body.message 
      : res.rawBody || `HTTP ${res.statusCode}`;
    throw new Error(`Branch resolution RPC failed (HTTP ${res.statusCode}): ${errorDetails}`);
  }
  return res.body;
}

async function provisionStudent() {
  console.log(`[Provisioning] Validating student roll number ${rollNumber}...`);

  // Step 1: Verify existence in student directory — fail closed if missing, inactive, or API error
  let dirEntry = null;
  try {
    dirEntry = await verifyDirectoryRecord(rollNumber);
  } catch (err) {
    console.error(`ERROR: Directory API communication failure: ${err.message}`);
    console.error(`Provisioning aborted. Cannot proceed without verified roster connection.`);
    process.exit(1);
  }

  if (!dirEntry) {
    console.error(`ERROR: Cannot provision student ${rollNumber}. No record found in the official student roster (public.student_directory).`);
    console.error(`Before creating an authentication account, the student must be officially enrolled in student_directory by campus administration.`);
    process.exit(1);
  }

  if (dirEntry.is_active !== true) {
    console.error(`ERROR: Cannot provision student ${rollNumber}. The student directory record is marked inactive.`);
    console.error(`Provisioning aborted for inactive student record.`);
    process.exit(1);
  }

  // Step 2: Verify that the record's branch and admission year agree with the submitted roll number
  let branchResolution = null;
  try {
    branchResolution = await resolveBranchForRoll(rollNumber);
  } catch (err) {
    console.error(`ERROR: Failed to resolve academic branch for roll number ${rollNumber}: ${err.message}`);
    process.exit(1);
  }

  if (!branchResolution || branchResolution.success !== true) {
    console.error(`ERROR: Roll number ${rollNumber} could not be resolved against configured academic prefixes: ${branchResolution?.error || 'Unknown error'}`);
    process.exit(1);
  }

  if (branchResolution.branch_id !== dirEntry.branch_id) {
    console.error(`ERROR: Integrity mismatch for ${rollNumber}:`);
    console.error(`  - Roster branch_id:    ${dirEntry.branch_id}`);
    console.error(`  - Resolved branch_id:  ${branchResolution.branch_id} (${branchResolution.display_name})`);
    console.error(`Provisioning aborted: directory record branch does not match roll number academic prefix.`);
    process.exit(1);
  }

  if (branchResolution.admission_year !== dirEntry.admission_year) {
    console.error(`ERROR: Admission year mismatch for ${rollNumber}:`);
    console.error(`  - Roster admission_year:   ${dirEntry.admission_year}`);
    console.error(`  - Resolved admission_year: ${branchResolution.admission_year}`);
    console.error(`Provisioning aborted: directory admission year does not match roll number admission year.`);
    process.exit(1);
  }

  const expectedYearDigits = String(dirEntry.admission_year).slice(-2);
  if (rollNumber.slice(0, 2) !== expectedYearDigits) {
    console.error(`ERROR: Roll number prefix mismatch: ${rollNumber} does not begin with admission year suffix '${expectedYearDigits}'.`);
    process.exit(1);
  }

  console.log(`- Verified against official student directory: active record found`);
  console.log(`  - Branch: ${branchResolution.display_name} (${branchResolution.branch_code})`);
  console.log(`  - Admission Year: ${dirEntry.admission_year}`);
  console.log(`  - Roster integrity validated against roll number prefix '${branchResolution.prefix}'`);

  // Step 3: Check existing directory ownership and profile existence BEFORE creating an auth account
  console.log(`[Ownership Check] Validating directory ownership and checking for account conflicts...`);
  let expectedUserId = dirEntry.profile_id || null;

  // 3a. If directory record is already linked to a profile_id
  if (dirEntry.profile_id) {
    console.log(`- Directory record is already linked to profile ${dirEntry.profile_id}. Verifying account ownership...`);
    const linkedProfileOptions = {
      hostname: SUPABASE_PROJECT_URL,
      path: `/rest/v1/profiles?id=eq.${encodeURIComponent(dirEntry.profile_id)}&select=id,username,student_id,college_role,is_verified,must_change_password`,
      method: 'GET',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      }
    };

    const linkedProfRes = await sendRequest(linkedProfileOptions);
    if (linkedProfRes.statusCode < 200 || linkedProfRes.statusCode >= 300 || !Array.isArray(linkedProfRes.body) || linkedProfRes.body.length === 0) {
      console.error(`ERROR: Directory record points to non-existent or inaccessible profile ${dirEntry.profile_id}.`);
      console.error(`Provisioning aborted to prevent orphaned or misattributed accounts.`);
      process.exit(1);
    }

    const linkedProf = linkedProfRes.body[0];
    const matchesRoll = (linkedProf.student_id && linkedProf.student_id.toUpperCase() === rollNumber.toUpperCase()) ||
                        (linkedProf.username && linkedProf.username.toUpperCase() === rollNumber.toUpperCase());

    if (!matchesRoll) {
      console.error(`ERROR: Directory conflict! Directory record for ${rollNumber} is already linked to a different account:`);
      console.error(`  - Linked Profile ID: ${linkedProf.id}`);
      console.error(`  - Linked Username:   ${linkedProf.username}`);
      console.error(`  - Linked Student ID: ${linkedProf.student_id}`);
      console.error(`Provisioning aborted before creating or modifying any authentication account.`);
      process.exit(1);
    }
    console.log(`- Verified: Existing linked profile ${linkedProf.id} matches roll number ${rollNumber}.`);
  }

  // 3b. Verify whether any existing profile already claims this student_id or username
  const existingProfileOptions = {
    hostname: SUPABASE_PROJECT_URL,
    path: `/rest/v1/profiles?or=(student_id.eq.${encodeURIComponent(rollNumber)},username.eq.${encodeURIComponent(rollNumber)})&select=id,username,student_id,college_role,is_verified,must_change_password`,
    method: 'GET',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
    }
  };

  const existingProfRes = await sendRequest(existingProfileOptions);
  if (existingProfRes.statusCode >= 200 && existingProfRes.statusCode < 300 && Array.isArray(existingProfRes.body) && existingProfRes.body.length > 0) {
    const existingProf = existingProfRes.body[0];
    if (!dirEntry.profile_id) {
      console.error(`ERROR: Ownership conflict! Profile ${existingProf.id} already exists for roll number ${rollNumber}, but official directory entry has profile_id = NULL.`);
      console.error(`Provisioning aborted without creating or modifying any authentication accounts.`);
      process.exit(1);
    }
    if (dirEntry.profile_id !== existingProf.id) {
      console.error(`ERROR: Ownership conflict! Directory record is linked to ${dirEntry.profile_id}, but existing profile for ${rollNumber} is ${existingProf.id}.`);
      console.error(`Provisioning aborted without creating or modifying any authentication accounts.`);
      process.exit(1);
    }
    expectedUserId = existingProf.id;
    console.log(`- Verified: Profile ${existingProf.id} is uniquely and consistently associated with directory record.`);
  }

  // Step 4: Account provisioning in auth.users
  console.log(`[Provisioning] Ensuring account in auth.users...`);
  console.log(`- Identifier: ${rollNumber}`);
  console.log(`- Email mapping: ${email}`);
  console.log(`- Onboarding security: must_change_password enforced`);

  const payload = {
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: {
      username: rollNumber,
      student_id: rollNumber,
      full_name: fullName,
      department: branchResolution.display_name || department,
      year,
      must_change_password: true
    }
  };

  const createOptions = {
    hostname: SUPABASE_PROJECT_URL,
    path: '/auth/v1/admin/users',
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  let userId = expectedUserId;
  let isNewlyCreatedUser = false;
  const createRes = await sendRequest(createOptions, payload);

  if (createRes.statusCode >= 200 && createRes.statusCode < 300) {
    userId = createRes.body?.id;
    isNewlyCreatedUser = true;
    console.log(`- Account created in auth.users (User ID: ${userId})`);
  } else if (createRes.statusCode === 422 && String(createRes.rawBody).includes('already')) {
    console.log(`- Account already exists in auth.users. Validating idempotent profile state...`);
  } else {
    console.error(`ERROR: Failed to create user in auth.users (HTTP ${createRes.statusCode}):`, createRes.rawBody);
    process.exit(1);
  }

  // Step 5: Full Invariant Validation on Profile State
  if (!userId) {
    const fallbackLookup = await sendRequest({
      hostname: SUPABASE_PROJECT_URL,
      path: `/rest/v1/profiles?student_id=eq.${encodeURIComponent(rollNumber)}&select=id`,
      method: 'GET',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      }
    });
    if (fallbackLookup.body && Array.isArray(fallbackLookup.body) && fallbackLookup.body[0]?.id) {
      userId = fallbackLookup.body[0].id;
    }
  }

  if (!userId) {
    console.error(`ERROR: Could not resolve auth or profile user ID for ${rollNumber}.`);
    process.exit(1);
  }

  const profileOptions = {
    hostname: SUPABASE_PROJECT_URL,
    path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,username,student_id,college_role,is_verified,must_change_password`,
    method: 'GET',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
    }
  };

  const profRes = await sendRequest(profileOptions);
  if (profRes.statusCode < 200 || profRes.statusCode >= 300 || !Array.isArray(profRes.body) || profRes.body.length === 0) {
    console.error(`ERROR: Could not verify profile record for student ${rollNumber}.`);
    if (isNewlyCreatedUser && userId) {
      await rollbackAuthUser(userId);
    }
    process.exit(1);
  }

  const prof = profRes.body[0];

  // Invariant 1: Profile ID must match newly created user or existing directory link
  if (userId && prof.id !== userId) {
    console.error(`ERROR: Invariant violation! Profile ID ${prof.id} does not match auth User ID ${userId}.`);
    if (isNewlyCreatedUser) await rollbackAuthUser(userId);
    process.exit(1);
  }

  if (dirEntry.profile_id && dirEntry.profile_id !== prof.id) {
    console.error(`ERROR: Invariant violation! Directory record linked to ${dirEntry.profile_id} but profile ID is ${prof.id}.`);
    if (isNewlyCreatedUser) await rollbackAuthUser(userId);
    process.exit(1);
  }

  // Invariant 2: Username must match roll number
  if (prof.username.toUpperCase() !== rollNumber.toUpperCase()) {
    console.error(`ERROR: Invariant violation! Profile username (${prof.username}) does not match roll number (${rollNumber}).`);
    if (isNewlyCreatedUser) await rollbackAuthUser(userId);
    process.exit(1);
  }

  // Invariant 3: Student ID must match roll number
  if (!prof.student_id || prof.student_id.toUpperCase() !== rollNumber.toUpperCase()) {
    console.error(`ERROR: Invariant violation! Profile student_id (${prof.student_id}) does not match roll number (${rollNumber}).`);
    if (isNewlyCreatedUser) await rollbackAuthUser(userId);
    process.exit(1);
  }

  // Invariant 4: College role must be student
  if (prof.college_role !== 'student') {
    console.error(`ERROR: Invariant violation! Expected college_role 'student', got '${prof.college_role}'.`);
    if (isNewlyCreatedUser) await rollbackAuthUser(userId);
    process.exit(1);
  }

  // Invariant 5: must_change_password must be true for un-onboarded provisioned account
  if (prof.must_change_password !== true) {
    console.error(`ERROR: Invariant violation! must_change_password must be true for initial onboarding.`);
    if (isNewlyCreatedUser) await rollbackAuthUser(userId);
    process.exit(1);
  }

  console.log(`[Verification] Successfully validated all profile invariants:`);
  console.log(`  - Profile ID:           ${prof.id}`);
  console.log(`  - Username:             ${prof.username}`);
  console.log(`  - Student ID:           ${prof.student_id}`);
  console.log(`  - College Role:         ${prof.college_role}`);
  console.log(`  - Must Change Password: ${prof.must_change_password}`);

  // Final confirmation ONLY when all validation steps have passed
  console.log(`\nSUCCESS: Student ${rollNumber} is verified, provisioned, and ready for first-time password reset onboarding.`);
}

async function rollbackAuthUser(userId) {
  try {
    console.warn(`[Rollback] Recovering from partial failure: deleting newly created auth user ${userId}...`);
    const delOptions = {
      hostname: SUPABASE_PROJECT_URL,
      path: `/auth/v1/admin/users/${userId}`,
      method: 'DELETE',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
      }
    };
    await sendRequest(delOptions);
    console.warn(`[Rollback] Auth user ${userId} cleanly removed.`);
  } catch (err) {
    console.error(`[Rollback Error] Could not remove auth user ${userId}:`, err.message);
  }
}

provisionStudent().catch((err) => {
  console.error("Provisioning failed:", err.message);
  process.exit(1);
});
