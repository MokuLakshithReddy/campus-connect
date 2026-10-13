const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://gtkvujspajcelzufpggr.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_fr0wwYVpS66JH1qHwbUxbA_QJ8uNjMk';

const supabase = createClient(SUPABASE_URL, PUBLISHABLE_KEY);

async function runFullApplicationInspection() {
  const issues = [];
  console.log('================================================================');
  console.log('CAMPUS CONNECT: END-TO-END SYSTEM INSPECTION');
  console.log('================================================================\n');

  // STEP 1: AUTHENTICATION - WRONG CREDENTIALS & AUDITING
  console.log('--- [Step 1] Authentication: Wrong Password & Auditing ---');
  const { data: badAuth, error: badAuthErr } = await supabase.auth.signInWithPassword({
    email: '25mvcsmr0001@campus.internal',
    password: 'CompletelyWrongPassword!'
  });
  if (badAuthErr && badAuthErr.message.includes('Invalid login credentials')) {
    console.log('  PASSED: Wrong password correctly rejected with Invalid login credentials.');
  } else {
    issues.push(`Step 1: Expected invalid login credentials error, got: ${badAuthErr?.message}`);
    console.error('  FAILED: Unexpected response on wrong password:', badAuthErr);
  }

  // STEP 2: AUTHENTICATION - VALID INITIAL ACTIVATION CREDENTIALS
  console.log('\n--- [Step 2] Authentication: Initial Activation Login ---');
  const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
    email: '25mvcsmr0001@campus.internal',
    password: 'ActivationPass123!'
  });
  if (!authErr && authData.user) {
    console.log(`  PASSED: Logged in successfully as test student (${authData.user.id}).`);
  } else {
    issues.push(`Step 2: Activation login failed: ${authErr?.message}`);
    console.error('  FAILED: Activation login failed:', authErr);
    return issues;
  }

  // STEP 3: PROFILE RETRIEVAL & MUST_CHANGE_PASSWORD
  console.log('\n--- [Step 3] Profile Retrieval & Fallback RPCs ---');
  const { data: profileRows, error: profileErr } = await supabase.rpc('get_my_profile');
  const profile = profileRows?.[0];
  if (!profileErr && profile) {
    console.log(`  PASSED: Primary get_my_profile() returned profile:`, {
      username: profile.username,
      student_id: profile.student_id,
      college_role: profile.college_role,
      is_verified: profile.is_verified,
      must_change_password: profile.must_change_password
    });
    if (!profile.must_change_password) {
      issues.push('Step 3: Initial account should have must_change_password = true');
    }
  } else {
    issues.push(`Step 3: get_my_profile() RPC failed: ${profileErr?.message}`);
    console.error('  FAILED: get_my_profile failed:', profileErr);
  }

  // Fallback RPC check
  const { data: fallbackRows, error: fallbackErr } = await supabase.rpc('get_my_profile_fallback');
  if (!fallbackErr && fallbackRows?.[0]) {
    console.log('  PASSED: get_my_profile_fallback() RPC works correctly.');
  } else {
    issues.push(`Step 3b: Fallback RPC failed: ${fallbackErr?.message}`);
    console.error('  FAILED: Fallback RPC failed:', fallbackErr);
  }

  // STEP 4: FIRST-TIME MANDATORY PASSWORD CHANGE
  console.log('\n--- [Step 4] Mandatory Password Change Flow ---');
  const { error: updatePwErr } = await supabase.auth.updateUser({
    password: 'NewSecurePass2026!'
  });
  if (!updatePwErr) {
    console.log('  PASSED: Auth password updated to NewSecurePass2026!');
  } else {
    issues.push(`Step 4: Password update failed: ${updatePwErr.message}`);
    console.error('  FAILED: Password update failed:', updatePwErr);
  }

  // Verify trigger cleared must_change_password
  const { data: postPwProfile } = await supabase.rpc('get_my_profile');
  const updatedFlag = postPwProfile?.[0]?.must_change_password;
  if (updatedFlag === false) {
    console.log('  PASSED: Database trigger cleared must_change_password to false.');
  } else {
    issues.push(`Step 4: must_change_password flag was not cleared by trigger: ${updatedFlag}`);
    console.error('  FAILED: must_change_password flag is still:', updatedFlag);
  }

  // STEP 5: HOME FEED & POSTS
  console.log('\n--- [Step 5] Home Feed & Posts Creation ---');
  const { data: posts, error: postsErr } = await supabase
    .from('posts')
    .select('id, caption, image_url, user_id, content_visibility, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (!postsErr) {
    console.log(`  PASSED: Feed query succeeded (retrieved ${posts.length} visible posts).`);
  } else {
    issues.push(`Step 5: Posts fetch failed: ${postsErr.message}`);
    console.error('  FAILED: Feed query failed:', postsErr);
  }

  // Test creating a post
  const testPostCaption = `Automated validation post at ${new Date().toISOString()}`;
  const { data: createdPost, error: createPostErr } = await supabase
    .from('posts')
    .insert({
      caption: testPostCaption,
      image_url: 'https://placehold.co/600x400.png',
      user_id: authData.user.id,
      content_visibility: 'college'
    })
    .select()
    .single();

  if (!createPostErr && createdPost) {
    console.log('  PASSED: Created new post in feed:', createdPost.id);
    // Cleanup created post
    await supabase.from('posts').delete().eq('id', createdPost.id);
    console.log('  PASSED: Cleaned up test post.');
  } else {
    issues.push(`Step 5: Post creation failed: ${createPostErr?.message}`);
    console.error('  FAILED: Post creation failed:', createPostErr);
  }

  // STEP 6: EXPLORE & STUDENT SEARCH
  console.log('\n--- [Step 6] Explore: Student Search & Privacy Scoping ---');
  const { data: searchResults, error: searchErr } = await supabase.rpc('search_campus_students', {
    p_query: '25MVCSMR'
  });
  if (!searchErr) {
    console.log(`  PASSED: search_campus_students executed cleanly (found ${searchResults?.length || 0} students).`);
  } else {
    issues.push(`Step 6: search_campus_students RPC error: ${searchErr.message}`);
    console.error('  FAILED: Student search RPC failed:', searchErr);
  }

  // STEP 7: CLUBS & CHANNELS
  console.log('\n--- [Step 7] Clubs & Announcements ---');
  const { data: clubs, error: clubsErr } = await supabase
    .from('clubs')
    .select('id, name, description, category')
    .limit(5);
  if (!clubsErr) {
    console.log(`  PASSED: Clubs fetch succeeded (${clubs.length} clubs found).`);
  } else {
    issues.push(`Step 7: Clubs fetch failed: ${clubsErr.message}`);
    console.error('  FAILED: Clubs query failed:', clubsErr);
  }

  // STEP 8: EVENTS & REGISTRATIONS
  console.log('\n--- [Step 8] Events & Calendar ---');
  const { data: events, error: eventsErr } = await supabase
    .from('events')
    .select('id, title, start_time, venue, is_published')
    .limit(5);
  if (!eventsErr) {
    console.log(`  PASSED: Events fetch succeeded (${events.length} events found).`);
  } else {
    issues.push(`Step 8: Events fetch failed: ${eventsErr.message}`);
    console.error('  FAILED: Events query failed:', eventsErr);
  }

  // STEP 9: MESSAGING & UNREAD TRACKING
  console.log('\n--- [Step 9] Messaging & Unread Counts ---');
  const { data: unreadCount, error: unreadErr } = await supabase.rpc('get_unread_messages_count');
  if (!unreadErr) {
    console.log(`  PASSED: get_unread_messages_count RPC returned count: ${unreadCount}`);
  } else {
    issues.push(`Step 9: get_unread_messages_count RPC failed: ${unreadErr.message}`);
    console.error('  FAILED: Unread count RPC failed:', unreadErr);
  }

  const { data: conversations, error: convoErr } = await supabase
    .from('conversations')
    .select('id, user1_id, user2_id, last_message_at, created_at')
    .limit(5);
  if (!convoErr) {
    console.log(`  PASSED: Conversations list loaded (${conversations.length} conversations).`);
  } else {
    issues.push(`Step 9: Conversations fetch failed: ${convoErr.message}`);
    console.error('  FAILED: Conversations fetch failed:', convoErr);
  }

  // STEP 10: PROFILE EDITING
  console.log('\n--- [Step 10] Profile Editing ---');
  const newBio = `Computer Science & Engineering Student (Verified AIML 2025) - Updated ${new Date().toLocaleTimeString()}`;
  const { error: editProfileErr } = await supabase
    .from('profiles')
    .update({ bio: newBio, updated_at: new Date().toISOString() })
    .eq('id', authData.user.id);

  if (!editProfileErr) {
    console.log('  PASSED: Successfully updated student bio in profile.');
  } else {
    issues.push(`Step 10: Profile update failed: ${editProfileErr.message}`);
    console.error('  FAILED: Profile bio update failed:', editProfileErr);
  }

  // STEP 11: SIGN OUT & RE-AUTHENTICATION WITH NEW PASSWORD
  console.log('\n--- [Step 11] Sign Out & Re-Login with New Password ---');
  await supabase.auth.signOut();
  const { data: reAuthData, error: reAuthErr } = await supabase.auth.signInWithPassword({
    email: '25mvcsmr0001@campus.internal',
    password: 'NewSecurePass2026!'
  });
  if (!reAuthErr && reAuthData.user) {
    console.log('  PASSED: Re-authenticated with NewSecurePass2026! directly.');
  } else {
    issues.push(`Step 11: Re-authentication with new password failed: ${reAuthErr?.message}`);
    console.error('  FAILED: Re-authentication failed:', reAuthErr);
  }

  console.log('\n================================================================');
  if (issues.length === 0) {
    console.log('ALL FUNCTIONALITIES PASSED WITH ZERO ISSUES!');
  } else {
    console.log(`FOUND ${issues.length} ISSUE(S):`);
    issues.forEach((iss, i) => console.log(`  ${i + 1}. ${iss}`));
  }
  console.log('================================================================');
}

runFullApplicationInspection();
