/**
 * Provision a student account in Supabase
 * Usage: node scripts/provision-student.js <ROLL_NUMBER> [DEPARTMENT] [YEAR] [FULL_NAME]
 * Example: node scripts/provision-student.js 24CS0142 "Computer Science & Engineering" "1st Year" "Alex Chen"
 */
const https = require('https');

const SUPABASE_PROJECT_URL = process.env.VITE_SUPABASE_URL
  ? process.env.VITE_SUPABASE_URL.replace(/^https?:\/\//, '')
  : 'gtkvujspajcelzufpggr.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is required.");
  console.error("Usage: SUPABASE_SERVICE_ROLE_KEY=<secret> node scripts/provision-student.cjs <ROLL_NUMBER>");
  process.exit(1);
}

const rollNumber = (process.argv[2] || '24CS0142').trim().toUpperCase();
const department = process.argv[3] || 'Computer Science & Engineering';
const year = process.argv[4] || '1st Year';
const fullName = process.argv[5] || rollNumber;

const email = `${rollNumber.toLowerCase()}@campus.internal`;
const temporaryPassword = rollNumber; // Initial password is the roll number

console.log(`Provisioning student ${rollNumber}...`);
console.log(`- Email mapping: ${email}`);
console.log(`- Initial Password: ${temporaryPassword}`);
console.log(`- Must Change Password: true`);

const payload = JSON.stringify({
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
});

const options = {
  hostname: SUPABASE_PROJECT_URL,
  path: '/auth/v1/admin/users',
  method: 'POST',
  headers: {
    'apikey': SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const user = JSON.parse(body);
      console.log(`✅ Successfully provisioned ${rollNumber} (User ID: ${user.id})`);
    } else {
      console.error(`❌ Failed with status ${res.statusCode}:`, body);
    }
  });
});

req.on('error', (err) => {
  console.error('Request error:', err);
});

req.write(payload);
req.end();
