const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://gtkvujspajcelzufpggr.supabase.co';
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_fr0wwYVpS66JH1qHwbUxbA_QJ8uNjMk';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceKey) {
  console.log("Skipping admin tests: SUPABASE_SERVICE_ROLE_KEY not set in environment.");
  process.exit(0);
}

const adminClient = createClient(supabaseUrl, serviceKey);
const client = createClient(supabaseUrl, publishableKey);

async function test() {
  console.log('1. Setting initial password for 24CS0142 to 24CS0142...');
  const { error: adminErr } = await adminClient.auth.admin.updateUserById(
    '4d6afbac-7160-42c1-bef7-ce173d7778dd',
    { password: '24CS0142' }
  );
  if (adminErr) {
    console.error('Admin set password error:', adminErr);
    return;
  }
  console.log('Admin set password: SUCCESS');

  console.log('2. Signing in as 24CS0142 with temporary password...');
  const { data: signData, error: signErr } = await client.auth.signInWithPassword({
    email: '24cs0142@campus.internal',
    password: '24CS0142'
  });
  if (signErr) {
    console.error('Sign in error:', signErr);
    return;
  }
  console.log('Signed in as:', signData.user.email);

  console.log('3. Testing client.auth.updateUser({ password: "NewSecurePassword123" })...');
  const updateStart = Date.now();
  const { data: updateData, error: updateErr } = await client.auth.updateUser({
    password: 'NewSecurePassword123'
  });
  console.log('updateUser took:', Date.now() - updateStart, 'ms');
  if (updateErr) {
    console.error('updateUser ERROR:', updateErr);
  } else {
    console.log('updateUser SUCCESS:', updateData.user.email);
  }

  console.log('4. Testing client.rpc("complete_first_time_password_change")...');
  const { data: rpcData, error: rpcErr } = await client.rpc('complete_first_time_password_change');
  if (rpcErr) {
    console.error('RPC ERROR:', rpcErr);
  } else {
    console.log('RPC SUCCESS:', rpcData);
  }
}

test();
