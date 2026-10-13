-- Seed script for CampusConnect (College Clubs, Channels, Events, Registrations)

-- 1. Official Student Directory Roster Seeding (Confirmed 2025 Cohorts)
DO $$
DECLARE
  v_aiml_branch UUID;
  v_cse_branch UUID;
BEGIN
  SELECT id INTO v_aiml_branch FROM public.academic_branches WHERE course = 'B.Tech' AND branch_code = 'CSE-AIML';
  SELECT id INTO v_cse_branch FROM public.academic_branches WHERE course = 'B.Tech' AND branch_code = 'CSE';

  -- Seed verified roster records for official cohorts (25MVCSMR and 25MVCSER prefixes)
  INSERT INTO public.student_directory (roll_number, branch_id, admission_year, is_active, profile_id)
  VALUES
    ('25MVCSMR0001', v_aiml_branch, 2025, true, '73195cf7-df24-49e8-9f09-07bf6eb81c11'),
    ('25MVCSMR0002', v_aiml_branch, 2025, true, '39b1d5b2-eabc-4bf3-ad7a-0af0b303114d'),
    ('25MVCSMR0003', v_aiml_branch, 2025, true, NULL),
    ('25MVCSMR0004', v_aiml_branch, 2025, true, NULL),
    ('25MVCSER0001', v_cse_branch, 2025, true, 'a8817ef0-18c9-4ab8-9d07-a027caa4eba2'),
    ('25MVCSER0002', v_cse_branch, 2025, true, NULL),
    ('25MVCSER0003', v_cse_branch, 2025, true, NULL)
  ON CONFLICT (roll_number) DO UPDATE SET
    branch_id = EXCLUDED.branch_id,
    admission_year = EXCLUDED.admission_year,
    is_active = EXCLUDED.is_active;

  -- Synchronize seed profile records with their official branches and roll numbers
  UPDATE public.profiles
  SET department = 'Computer Science & Engineering (AI & ML)',
      year = '1st Year',
      student_id = '25MVCSMR0001',
      branch_id = v_aiml_branch,
      branch_name = 'B.Tech Computer Science and Engineering (AI & ML)',
      is_verified = true
  WHERE id = '73195cf7-df24-49e8-9f09-07bf6eb81c11';

  UPDATE public.profiles
  SET department = 'Computer Science & Engineering',
      year = '1st Year',
      student_id = '25MVCSER0001',
      branch_id = v_cse_branch,
      branch_name = 'B.Tech Computer Science and Engineering',
      is_verified = true
  WHERE id = 'a8817ef0-18c9-4ab8-9d07-a027caa4eba2';

  UPDATE public.profiles
  SET department = 'Computer Science & Engineering (AI & ML)',
      year = '1st Year',
      student_id = '25MVCSMR0002',
      branch_id = v_aiml_branch,
      branch_name = 'B.Tech Computer Science and Engineering (AI & ML)',
      is_verified = true
  WHERE id = '39b1d5b2-eabc-4bf3-ad7a-0af0b303114d';
END $$;

-- 2. Insert Clubs
INSERT INTO public.clubs (id, name, slug, description, category, faculty_coordinator, status, created_by)
VALUES 
  (
    '11111111-1111-1111-1111-111111111111',
    'AI & Robotics Club',
    'ai-robotics',
    'Innovating autonomous rovers, computer vision systems, drone tech, and generative AI research for real-world campus and industry solutions.',
    'Robotics & AI',
    'Dr. Ramesh Sharma',
    'active',
    '73195cf7-df24-49e8-9f09-07bf6eb81c11'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'Developer Student Club',
    'developer-club',
    'Empowering university students with hands-on web, mobile, cloud computing, and open-source software development workshops.',
    'Technical',
    'Prof. Ananya Sen',
    'active',
    '73195cf7-df24-49e8-9f09-07bf6eb81c11'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    'Entrepreneurship & Innovation Cell',
    'e-cell',
    'Fostering student startups, investor pitch summits, venture incubators, and leadership masterclasses for student founders.',
    'Entrepreneurship',
    'Dr. K. V. Rao',
    'active',
    'a8817ef0-18c9-4ab8-9d07-a027caa4eba2'
  ),
  (
    '44444444-4444-4444-4444-444444444444',
    'PixelCraft Photography & Media',
    'pixelcraft',
    'The official visual media and journalism community documenting campus fests, sports, street photography, and short filmmaking.',
    'Arts & Media',
    'Prof. Sneha Verma',
    'active',
    '39b1d5b2-eabc-4bf3-ad7a-0af0b303114d'
  ),
  (
    '55555555-5555-5555-5555-555555555555',
    'Design & UI/UX Society',
    'design-society',
    'Dedicated to digital product design, visual identity systems, human-computer interaction, and campus design sprints.',
    'Design & Product',
    'Dr. Arvind Patel',
    'active',
    '73195cf7-df24-49e8-9f09-07bf6eb81c11'
  )
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  faculty_coordinator = EXCLUDED.faculty_coordinator;

-- 3. Insert Memberships
INSERT INTO public.club_memberships (club_id, user_id, role, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', '73195cf7-df24-49e8-9f09-07bf6eb81c11', 'president', 'active'),
  ('11111111-1111-1111-1111-111111111111', 'a8817ef0-18c9-4ab8-9d07-a027caa4eba2', 'organizer', 'active'),
  ('11111111-1111-1111-1111-111111111111', '39b1d5b2-eabc-4bf3-ad7a-0af0b303114d', 'member', 'active'),
  ('22222222-2222-2222-2222-222222222222', '73195cf7-df24-49e8-9f09-07bf6eb81c11', 'organizer', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'a8817ef0-18c9-4ab8-9d07-a027caa4eba2', 'president', 'active'),
  ('33333333-3333-3333-3333-333333333333', 'a8817ef0-18c9-4ab8-9d07-a027caa4eba2', 'president', 'active'),
  ('44444444-4444-4444-4444-444444444444', '39b1d5b2-eabc-4bf3-ad7a-0af0b303114d', 'president', 'active')
ON CONFLICT (club_id, user_id) DO NOTHING;

-- 4. Insert Default Channels for AI & Robotics Club
INSERT INTO public.club_channels (id, club_id, name, type, description)
VALUES
  ('c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'announcements', 'announcements', 'Official notifications, schedules, and club updates from coordinators.'),
  ('c1111111-1111-1111-1111-222222222222', '11111111-1111-1111-1111-111111111111', 'general-discussion', 'general', 'Open space for members to ask questions, share insights, and discuss tech.'),
  ('c1111111-1111-1111-1111-333333333333', '11111111-1111-1111-1111-111111111111', 'project-rover-team', 'project', 'Working room for students developing the campus autonomous rover.')
ON CONFLICT DO NOTHING;

-- Insert Channels for Developer Club
INSERT INTO public.club_channels (id, club_id, name, type, description)
VALUES
  ('c2222222-2222-2222-2222-111111111111', '22222222-2222-2222-2222-222222222222', 'announcements', 'announcements', 'Official hackathons, workshop notices, and meeting announcements.'),
  ('c2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'general', 'general', 'Chat about web dev, system design, algorithms, and bug fixes.')
ON CONFLICT DO NOTHING;

-- 5. Insert Sample Announcements and Messages
INSERT INTO public.channel_messages (channel_id, sender_id, content, is_pinned)
VALUES
  (
    'c1111111-1111-1111-1111-111111111111',
    '73195cf7-df24-49e8-9f09-07bf6eb81c11',
    '🎉 Welcome all new members to the AI & Robotics Club! Our initial orientation and hardware kit distribution will be held this Friday in Lab 402. Don''t forget to bring your student ID card.',
    true
  ),
  (
    'c1111111-1111-1111-1111-222222222222',
    'a8817ef0-18c9-4ab8-9d07-a027caa4eba2',
    'Hey everyone! Who is working on ROS 2 Humble simulation? We have configured a Gazebo test environment on the lab workstation.',
    false
  ),
  (
    'c2222222-2222-2222-2222-111111111111',
    'a8817ef0-18c9-4ab8-9d07-a027caa4eba2',
    '📢 Registrations are now OPEN for the Full-Stack AI Workshop! Limited to 120 seats. Register via the Events tab.',
    true
  );

-- 6. Insert Events
INSERT INTO public.events (id, club_id, title, description, venue, start_time, end_time, capacity, is_published, created_by)
VALUES
  (
    'e1111111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'Autonomous Rover & Drone Hackathon 2026',
    'A 24-hour hands-on robotics challenge where teams build obstacle-avoidance rovers and micro-drone navigation scripts. Hardware kits and sensor modules provided on-site.',
    'Robotics Advanced Lab, Block C',
    NOW() + INTERVAL '5 days',
    NOW() + INTERVAL '6 days',
    60,
    true,
    '73195cf7-df24-49e8-9f09-07bf6eb81c11'
  ),
  (
    'e2222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222222',
    'Full-Stack AI Workshop: Building with LLMs & Supabase',
    'Deep-dive into building real-time production web & mobile apps powered by Supabase, React, Vector Embeddings, and modern AI APIs. Open to all branches.',
    'Main Seminar Auditorium 2',
    NOW() + INTERVAL '2 days',
    NOW() + INTERVAL '2 days 4 hours',
    120,
    true,
    'a8817ef0-18c9-4ab8-9d07-a027caa4eba2'
  ),
  (
    'e3333333-3333-3333-3333-333333333333',
    '33333333-3333-3333-3333-333333333333',
    'Campus Startup Pitch Night 2026',
    'Pitch your startup or product idea in front of alumni angel investors and startup mentors. Winning teams receive $1,500 proof-of-concept seed grants.',
    'Incubation Centre, 3rd Floor',
    NOW() + INTERVAL '9 days',
    NOW() + INTERVAL '9 days 3 hours',
    80,
    true,
    'a8817ef0-18c9-4ab8-9d07-a027caa4eba2'
  ),
  (
    'e4444444-4444-4444-4444-444444444444',
    '44444444-4444-4444-4444-444444444444',
    'LensCraft: Golden Hour Campus Photo Walk',
    'Explore composition, portrait framing, and lighting across campus iconic architectural spots with veteran student photographers.',
    'North Campus Amphitheater',
    NOW() + INTERVAL '4 days',
    NOW() + INTERVAL '4 days 2 hours',
    40,
    true,
    '39b1d5b2-eabc-4bf3-ad7a-0af0b303114d'
  )
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  venue = EXCLUDED.venue;

-- 7. Insert Event Registrations for testing
INSERT INTO public.event_registrations (event_id, user_id, status)
VALUES
  ('e1111111-1111-1111-1111-111111111111', '73195cf7-df24-49e8-9f09-07bf6eb81c11', 'registered'),
  ('e2222222-2222-2222-2222-222222222222', '73195cf7-df24-49e8-9f09-07bf6eb81c11', 'registered')
ON CONFLICT (event_id, user_id) DO NOTHING;
