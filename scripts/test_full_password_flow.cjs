const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://gtkvujspajcelzufpggr.supabase.co';
const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0a3Z1anNwYWpjZWx6dWZwZ2dyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNTk2ODcsImV4cCI6MjA5ODkzNTY4N30.xLVJ7azzc2RmVRT8pFocHfL745nzBk6PU3HXPbiMR60';
const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0a3Z1anNwYWpjZWx6dWZwZ2dyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzM1OTY4NywiZXhwIjoyMDk4OTM1Njg3fQ.ROTATED_SERVICE_ROLE_KEY';

const adminClient = createClient(supabaseUrl, serviceKey);
const client = createClient(supabaseUrl, anonKey);

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
