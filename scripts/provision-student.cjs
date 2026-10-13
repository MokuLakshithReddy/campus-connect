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

async function verifyDirectoryRecord(roll) {
  const options = {
    hostname: SUPABASE_PROJECT_URL,
    path: `/rest/v1/student_directory?roll_number=eq.${encodeURIComponent(roll)}&select=roll_number,branch_id,admission_year,is_active`,
    method: 'GET',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
    }
  };

  const res = await sendRequest(options);
  if (res.statusCode >= 200 && res.statusCode < 300 && Array.isArray(res.body)) {
    return res.body[0] || null;
  }
  return null;
}

async function provisionStudent() {
  console.log(`[Provisioning] Validating student roll number ${rollNumber}...`);

  // 1. Verify existence in student directory
  try {
    const dirEntry = await verifyDirectoryRecord(rollNumber);
    if (dirEntry) {
      if (dirEntry.is_active === false) {
        console.error(`ERROR: Student directory record for ${rollNumber} is marked inactive.`);
        process.exit(1);
      }
      console.log(`- Verified against official student directory: active record found`);
    } else {
      console.log(`- Notice: Direct student directory record not found via REST (will proceed if directory entry was pre-seeded)`);
    }
  } catch (err) {
    console.warn(`- Warning verifying directory: ${err.message}`);
  }

  console.log(`[Provisioning] Creating account in auth.users...`);
  console.log(`- Identifier: ${rollNumber}`);
  console.log(`- Email mapping: ${email}`);
  console.log(`- Onboarding security: must_change_password enforced (initial credential requires replacement)`);

  const payload = {
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: {
      username: rollNumber,
      student_id: rollNumber,
      full_name: fullName,
      department,
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

  let userId = null;
  const createRes = await sendRequest(createOptions, payload);

  if (createRes.statusCode >= 200 && createRes.statusCode < 300) {
    userId = createRes.body?.id;
    console.log(`- Account created in auth.users (User ID: ${userId})`);
  } else if (createRes.statusCode === 422 && String(createRes.rawBody).includes('already')) {
    console.log(`- Account already exists in auth.users. Validating idempotent profile state...`);
  } else {
    console.error(`ERROR: Failed to create user (HTTP ${createRes.statusCode}):`, createRes.rawBody);
    process.exit(1);
  }

  // 2. Verify profile state idempotently
  const profileOptions = {
    hostname: SUPABASE_PROJECT_URL,
    path: `/rest/v1/profiles?student_id=eq.${encodeURIComponent(rollNumber)}&select=id,username,student_id,college_role,is_verified,must_change_password`,
    method: 'GET',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
    }
  };

  const profRes = await sendRequest(profileOptions);
  if (profRes.statusCode >= 200 && profRes.statusCode < 300 && Array.isArray(profRes.body) && profRes.body.length > 0) {
    const prof = profRes.body[0];
    console.log(`[Verification] Successfully verified public.profiles record:`);
    console.log(`  - Profile ID: ${prof.id}`);
    console.log(`  - Username: ${prof.username}`);
    console.log(`  - College Role: ${prof.college_role}`);
    console.log(`  - Must Change Password: ${prof.must_change_password}`);
    console.log(`\nSUCCESS: Student ${rollNumber} is provisioned and ready for first-time password reset onboarding.`);
  } else {
    console.error(`ERROR: Could not verify profile record for student ${rollNumber}.`);
    process.exit(1);
  }
}

provisionStudent().catch((err) => {
  console.error("Provisioning failed:", err.message);
  process.exit(1);
});
