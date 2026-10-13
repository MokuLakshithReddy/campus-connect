/**
 * AUDIT AND ROTATE LEGACY ONBOARDING CREDENTIALS
 * 
 * Inspects all provisioned student accounts where must_change_password = true
 * to ensure no account remains with a predictable roll-number password.
 * Generates high-entropy one-time activation credentials and sets activation_expires_at.
 * 
 * Usage:
 *   SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<secret> node scripts/audit_and_rotate_legacy_credentials.cjs
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const rawSupabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
if (!rawSupabaseUrl || !rawSupabaseUrl.trim()) {
  console.error("ERROR: SUPABASE_URL (or VITE_SUPABASE_URL) environment variable is required.");
  process.exit(1);
}

let parsedUrl;
try {
  const normalized = rawSupabaseUrl.startsWith('http://') || rawSupabaseUrl.startsWith('https://')
    ? rawSupabaseUrl
    : `https://${rawSupabaseUrl}`;
  parsedUrl = new URL(normalized);
} catch (e) {
  console.error(`ERROR: Malformed SUPABASE_URL: '${rawSupabaseUrl}'`);
  process.exit(1);
}

const SUPABASE_PROJECT_URL = parsedUrl.hostname;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is required.");
  process.exit(1);
}

function sendRequest(options, data) {
  const isHttp = parsedUrl.protocol === 'http:';
  const client = isHttp ? http : https;
  const reqOptions = {
    ...options,
    port: options.port || (parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttp ? 80 : 443))
  };
  return new Promise((resolve, reject) => {
    const req = client.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (body) {
          try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
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

function generateHighEntropyPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#$*';
  let token = 'CC-';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) token += '-';
    token += chars[bytes[i] % chars.length];
  }
  return token;
}

async function runAuditAndRotation() {
  console.log(`[Credential Audit] Scanning provisioned student accounts requiring initial activation...`);

  // Query un-onboarded profiles
  const profilesRes = await sendRequest({
    hostname: SUPABASE_PROJECT_URL,
    path: `/rest/v1/profiles?must_change_password=eq.true&select=id,username,student_id,college_role,is_verified,activation_expires_at`,
    method: 'GET',
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
    }
  });

  if (profilesRes.statusCode < 200 || profilesRes.statusCode >= 300 || !Array.isArray(profilesRes.body)) {
    console.error("Failed to query un-onboarded profiles:", profilesRes.rawBody);
    process.exit(1);
  }

  const unactivatedProfiles = profilesRes.body;
  console.log(`- Found ${unactivatedProfiles.length} un-onboarded student account(s) requiring password change.`);

  if (unactivatedProfiles.length === 0) {
    console.log(`All accounts have already completed onboarding or no pending accounts exist.`);
    return;
  }

  const expiration = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  let rotatedCount = 0;

  for (const prof of unactivatedProfiles) {
    const roll = prof.student_id || prof.username;
    const newActivationKey = generateHighEntropyPassword();

    console.log(`- Hardening credential for student ${roll} (User ID: ${prof.id})...`);

    // Rotate password in auth.users
    const updateRes = await sendRequest({
      hostname: SUPABASE_PROJECT_URL,
      path: `/auth/v1/admin/users/${prof.id}`,
      method: 'PUT',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      }
    }, {
      password: newActivationKey,
      user_metadata: {
        must_change_password: true,
        activation_expires_at: expiration
      }
    });

    if (updateRes.statusCode >= 200 && updateRes.statusCode < 300) {
      // Update profile activation window
      await sendRequest({
        hostname: SUPABASE_PROJECT_URL,
        path: `/rest/v1/profiles?id=eq.${encodeURIComponent(prof.id)}`,
        method: 'PATCH',
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json'
        }
      }, {
        activation_expires_at: expiration
      });

      console.log(`  ✓ Rotated: Student ${roll} assigned secure activation key: ${newActivationKey} (Expires: ${expiration})`);
      rotatedCount++;
    } else {
      console.error(`  ✗ Failed to update student ${roll}:`, updateRes.rawBody);
    }
  }

  console.log(`\nAUDIT COMPLETE: Successfully audited and rotated ${rotatedCount}/${unactivatedProfiles.length} unactivated accounts.`);
}

if (require.main === module) {
  runAuditAndRotation().catch((err) => {
    console.error("Audit failed:", err.message);
    process.exit(1);
  });
}

module.exports = { runAuditAndRotation, generateHighEntropyPassword };
