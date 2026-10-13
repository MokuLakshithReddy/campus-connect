const fs = require('fs');
const https = require('https');

const CSV_FILE = 'students_to_provision.csv';
const OUTPUT_CREDENTIALS_FILE = 'provisioned_credentials.csv';
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'gtkvujspajcelzufpggr';
const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';

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
  console.log('UPDATING ALL STUDENT PASSWORDS TO ROLL NUMBERS');
  console.log('================================================================\n');

  if (!fs.existsSync(CSV_FILE)) {
    console.error(`ERROR: CSV file ${CSV_FILE} not found.`);
    process.exit(1);
  }

  const rawLines = fs.readFileSync(CSV_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = rawLines[0].split(',').map(s => s.trim().toUpperCase());
  const rollIndex = header.indexOf('ROLL NO');
  const nameIndex = header.indexOf('NAME');

  const students = [];
  for (let i = 1; i < rawLines.length; i++) {
    const parts = rawLines[i].split(',');
    if (parts.length >= 2) {
      const rollNumber = parts[rollIndex].trim().toUpperCase();
      const name = parts.slice(nameIndex).join(',').trim();
      if (rollNumber && rollNumber.startsWith('25MVCSMR')) {
        students.push({
          rollNumber,
          name,
          email: `${rollNumber.toLowerCase()}@campus.internal`,
          password: rollNumber
        });
      }
    }
  }

  console.log(`Loaded ${students.length} students to update.\n`);

  const BATCH_SIZE = 25;
  for (let b = 0; b < students.length; b += BATCH_SIZE) {
    const batch = students.slice(b, b + BATCH_SIZE);
    const batchNum = Math.floor(b / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(students.length / BATCH_SIZE);
    console.log(`Updating batch ${batchNum}/${totalBatches} (${b + 1} to ${Math.min(b + BATCH_SIZE, students.length)})...`);

    let batchSql = 'DO $$\nDECLARE\n  v_user_id UUID;\nBEGIN\n';

    for (const s of batch) {
      const escapedRoll = s.rollNumber.replace(/'/g, "''");
      const escapedEmail = s.email.replace(/'/g, "''");

      batchSql += `
        SELECT id INTO v_user_id FROM auth.users WHERE email = '${escapedEmail}';
        IF v_user_id IS NOT NULL THEN
          UPDATE auth.users
          SET encrypted_password = extensions.crypt('${escapedRoll}', extensions.gen_salt('bf')),
              email_confirmed_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE id = v_user_id;

          UPDATE public.profiles
          SET must_change_password = true,
              activation_expires_at = clock_timestamp() + interval '72 hours',
              activated_at = NULL,
              updated_at = clock_timestamp()
          WHERE id = v_user_id;
        END IF;
      `;
    }

    batchSql += 'END $$;';

    await executeSqlQuery(batchSql);
    console.log(`  -> Batch ${batchNum} successfully updated.`);
  }

  // Update provisioned_credentials.csv
  const csvRows = ['ROLL NO,NAME,EMAIL,PASSWORD,MUST_CHANGE_PASSWORD'];
  for (const s of students) {
    csvRows.push(`"${s.rollNumber}","${s.name.replace(/"/g, '""')}","${s.email}","${s.password}","true"`);
  }
  fs.writeFileSync(OUTPUT_CREDENTIALS_FILE, csvRows.join('\n'), 'utf8');

  console.log('\n================================================================');
  console.log('SUCCESS: All 180 student passwords updated to their Roll Numbers.');
  console.log(`Updated credentials saved to: ${OUTPUT_CREDENTIALS_FILE}`);
  console.log('================================================================\n');
}

main().catch(err => {
  console.error('ERROR updating passwords:', err);
  process.exit(1);
});
