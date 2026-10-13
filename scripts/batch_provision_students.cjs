const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const CSV_FILE = 'students_to_provision.csv';
const OUTPUT_CREDENTIALS_FILE = 'provisioned_credentials.csv';
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'gtkvujspajcelzufpggr';
const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const BRANCH_ID = '49483211-3e1a-4cbc-a2b1-937fe2dfbabf'; // B.Tech CSE-AIML
const ADMISSION_YEAR = 2025;
const DEPARTMENT = 'Computer Science and Engineering (AI & ML)';
const YEAR = '1st Year';

function generateActivationPassword() {
  // Generate random token format: CC-XXXX-XXXX-XXXX with high entropy (A-Z, 0-9)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Base32 unambiguous
  function getChunk(len) {
    const bytes = crypto.randomBytes(len);
    let str = '';
    for (let i = 0; i < len; i++) {
      str += chars[bytes[i] % chars.length];
    }
    return str;
  }
  return `CC-${getChunk(4)}-${getChunk(4)}-${getChunk(4)}`;
}

function executeSqlQuery(sql) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query: sql });
    const req = https.request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${SUPABASE_PROJECT_REF}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('================================================================');
  console.log('CAMPUS CONNECT: BULK STUDENT PROVISIONING');
  console.log('================================================================\n');

  if (!fs.existsSync(CSV_FILE)) {
    console.error(`ERROR: CSV file ${CSV_FILE} not found.`);
    process.exit(1);
  }

  const rawLines = fs.readFileSync(CSV_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = rawLines[0].split(',').map(s => s.trim().toUpperCase());
  const rollIndex = header.indexOf('ROLL NO');
  const nameIndex = header.indexOf('NAME');

  if (rollIndex === -1 || nameIndex === -1) {
    console.error('ERROR: CSV must contain "ROLL NO" and "NAME" columns.');
    process.exit(1);
  }

  const students = [];
  for (let i = 1; i < rawLines.length; i++) {
    const parts = rawLines[i].split(',');
    if (parts.length >= 2) {
      const rollNumber = parts[rollIndex].trim().toUpperCase();
      const name = parts.slice(nameIndex).join(',').trim(); // Handle commas in name
      if (rollNumber && rollNumber.startsWith('25MVCSMR')) {
        students.push({
          rollNumber,
          name,
          email: `${rollNumber.toLowerCase()}@campus.internal`,
          activationPassword: generateActivationPassword()
        });
      }
    }
  }

  console.log(`Parsed ${students.length} valid students from ${CSV_FILE}.\n`);

  // First, fetch existing users and profiles from live database to avoid overwriting existing active accounts
  console.log('Checking existing accounts in database...');
  const existingRecords = await executeSqlQuery(`
    SELECT u.id, u.email, p.student_id, p.must_change_password, p.is_verified
    FROM auth.users u
    LEFT JOIN public.profiles p ON u.id = p.id;
  `);

  const existingByRoll = new Map();
  const existingByEmail = new Map();
  if (Array.isArray(existingRecords)) {
    for (const r of existingRecords) {
      if (r.student_id) existingByRoll.set(r.student_id.toUpperCase(), r);
      if (r.email) existingByEmail.set(r.email.toLowerCase(), r);
    }
  }
  console.log(`Found ${existingByRoll.size} existing roll numbers registered.\n`);

  const results = [];
  const BATCH_SIZE = 20;

  for (let b = 0; b < students.length; b += BATCH_SIZE) {
    const batch = students.slice(b, b + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(b / BATCH_SIZE) + 1}/${Math.ceil(students.length / BATCH_SIZE)} (students ${b + 1} to ${Math.min(b + BATCH_SIZE, students.length)})...`);

    // Build SQL transaction for this batch
    let batchSql = 'DO $$\nDECLARE\n  v_user_id UUID;\n  v_branch_id UUID := \'' + BRANCH_ID + '\';\nBEGIN\n';

    for (const s of batch) {
      const existingUser = existingByRoll.get(s.rollNumber) || existingByEmail.get(s.email);

      if (existingUser && existingUser.must_change_password === false) {
        // Student already active and finished password change - preserve account
        s.status = 'ALREADY_ACTIVE_PRESERVED';
        s.activationPassword = '[ACTIVE - PASSWORD SET BY STUDENT]';
        results.push(s);
        continue;
      }

      // Safe escaping
      const escapedName = s.name.replace(/'/g, "''");
      const escapedPw = s.activationPassword.replace(/'/g, "''");
      const escapedRoll = s.rollNumber.replace(/'/g, "''");
      const escapedEmail = s.email.replace(/'/g, "''");

      batchSql += `
        -- Ensure student directory entry
        INSERT INTO public.student_directory (roll_number, branch_id, admission_year, is_active)
        VALUES ('${escapedRoll}', v_branch_id, ${ADMISSION_YEAR}, true)
        ON CONFLICT (roll_number) DO UPDATE
          SET branch_id = v_branch_id, admission_year = ${ADMISSION_YEAR}, is_active = true;

        SELECT id INTO v_user_id FROM auth.users WHERE email = '${escapedEmail}';

        IF v_user_id IS NULL THEN
          v_user_id := gen_random_uuid();

          INSERT INTO auth.users (
            id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
            confirmation_token, recovery_token, email_change_token_new,
            email_change, phone_change, phone_change_token, email_change_token_current,
            reauthentication_token, is_sso_user, is_anonymous,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at
          ) VALUES (
            v_user_id,
            '00000000-0000-0000-0000-000000000000',
            'authenticated',
            'authenticated',
            '${escapedEmail}',
            extensions.crypt('${escapedPw}', extensions.gen_salt('bf')),
            clock_timestamp(),
            '', '', '', '', '', '', '', '', false, false,
            '{"provider":"email","providers":["email"]}',
            json_build_object('username', '${escapedRoll}', 'student_id', '${escapedRoll}', 'name', '${escapedName}', 'department', '${DEPARTMENT}', 'year', '${YEAR}'),
            clock_timestamp(),
            clock_timestamp()
          );

          INSERT INTO auth.identities (
            provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at, id
          ) VALUES (
            v_user_id,
            v_user_id,
            json_build_object('sub', v_user_id, 'email', '${escapedEmail}', 'email_verified', true, 'phone_verified', false),
            'email',
            clock_timestamp(),
            clock_timestamp(),
            clock_timestamp(),
            gen_random_uuid()
          ) ON CONFLICT (provider_id, provider) DO NOTHING;

          INSERT INTO public.profiles (
            id, username, student_id, college_role, is_verified, must_change_password,
            department, year, branch_id, activation_expires_at, created_at, updated_at
          ) VALUES (
            v_user_id,
            '${escapedRoll}',
            '${escapedRoll}',
            'student',
            false,
            true,
            '${DEPARTMENT}',
            '${YEAR}',
            NULL,
            clock_timestamp() + interval '72 hours',
            clock_timestamp(),
            clock_timestamp()
          ) ON CONFLICT (id) DO UPDATE SET
            username = '${escapedRoll}',
            student_id = '${escapedRoll}',
            must_change_password = true,
            activation_expires_at = clock_timestamp() + interval '72 hours',
            activated_at = NULL;
        ELSE
          UPDATE auth.users
          SET encrypted_password = extensions.crypt('${escapedPw}', extensions.gen_salt('bf')),
              email_confirmed_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE id = v_user_id;

          UPDATE public.profiles
          SET must_change_password = true,
              activation_expires_at = clock_timestamp() + interval '72 hours',
              activated_at = NULL
          WHERE id = v_user_id;
        END IF;

        -- Apply verified academic directory status
        PERFORM public.internal_apply_directory_verification(v_user_id, v_branch_id, '${DEPARTMENT}');

        -- Link directory row
        UPDATE public.student_directory
        SET profile_id = v_user_id
        WHERE roll_number = '${escapedRoll}';
      `;

      s.status = existingUser ? 'CREDENTIAL_ROTATED' : 'PROVISIONED';
      results.push(s);
    }

    batchSql += 'END $$;';

    try {
      await executeSqlQuery(batchSql);
      console.log(`  -> Batch ${Math.floor(b / BATCH_SIZE) + 1} successfully executed.`);
    } catch (err) {
      console.error(`  -> ERROR executing batch ${Math.floor(b / BATCH_SIZE) + 1}:`, err.message);
      throw err;
    }
  }

  // Write provisioned credentials report to CSV
  const csvRows = ['ROLL NO,NAME,EMAIL,ACTIVATION_PASSWORD,EXPIRES_AT,STATUS'];
  const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();

  for (const r of results) {
    csvRows.push(`"${r.rollNumber}","${r.name.replace(/"/g, '""')}","${r.email}","${r.activationPassword}","${expiresAt}","${r.status}"`);
  }

  fs.writeFileSync(OUTPUT_CREDENTIALS_FILE, csvRows.join('\n'), 'utf8');
  console.log(`\n================================================================`);
  console.log(`PROVISIONING COMPLETE!`);
  console.log(`Total students processed: ${results.length}`);
  console.log(`Newly provisioned: ${results.filter(r => r.status === 'PROVISIONED').length}`);
  console.log(`Rotated / Updated: ${results.filter(r => r.status === 'CREDENTIAL_ROTATED').length}`);
  console.log(`Already active: ${results.filter(r => r.status === 'ALREADY_ACTIVE_PRESERVED').length}`);
  console.log(`Credentials saved to: ${OUTPUT_CREDENTIALS_FILE}`);
  console.log(`================================================================\n`);
}

main().catch(err => {
  console.error('FATAL PROVISIONING ERROR:', err);
  process.exit(1);
});
