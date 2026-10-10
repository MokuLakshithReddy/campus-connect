-- ============================================================================
-- CAMPUSCONNECT: CONSOLIDATED MASTER DATABASE SCHEMA & SECURITY ENGINE
-- Single Source of Truth for Database Schema, RLS, Triggers, and Stored Procedures
-- ============================================================================

-- 1. BASE EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. PUBLIC PROFILES
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  bio TEXT,
  avatar_url TEXT,
  department TEXT,
  year TEXT,
  student_id TEXT,
  college_role TEXT NOT NULL DEFAULT 'student' CHECK (college_role IN ('student', 'faculty', 'college_admin')),
  is_verified BOOLEAN NOT NULL DEFAULT false,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. CLUBS TABLE
CREATE TABLE IF NOT EXISTS public.clubs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'Technical',
  logo_url TEXT,
  cover_url TEXT,
  faculty_coordinator TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('active', 'pending_approval', 'inactive')),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. CLUB MEMBERSHIPS TABLE
CREATE TABLE IF NOT EXISTS public.club_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('president', 'organizer', 'member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'pending', 'rejected', 'banned')),
  joined_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (club_id, user_id)
);

-- 5. CLUB CHANNELS TABLE
CREATE TABLE IF NOT EXISTS public.club_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general' CHECK (type IN ('announcements', 'general', 'project', 'events')),
  description TEXT,
  is_private BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. CHANNEL MESSAGES TABLE
CREATE TABLE IF NOT EXISTS public.channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES public.club_channels(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  attachments JSONB DEFAULT '[]'::jsonb,
  is_pinned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. EVENTS TABLE
CREATE TABLE IF NOT EXISTS public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  poster_url TEXT,
  venue TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  is_published BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. EVENT REGISTRATIONS TABLE
CREATE TABLE IF NOT EXISTS public.event_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'waitlist', 'attended', 'cancelled')),
  qr_code_token TEXT UNIQUE DEFAULT gen_random_uuid()::text,
  checked_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (event_id, user_id)
);

-- 9. NOTIFICATIONS TABLE
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('announcement', 'event_created', 'event_reminder', 'membership_requested', 'membership_approved')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- CRITICAL SECURITY TRIGGERS (DATABASE LEVEL INTEGRITY)
-- ============================================================================

-- 1. PROTECT PROFILE PRIVILEGES (Anti-Escalation)
CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS TRIGGER AS $$
DECLARE
  v_caller_role TEXT;
BEGIN
  -- Allow direct migration/database administration session where auth.uid() is null
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- If modifying college_role or is_verified:
  IF (OLD.college_role IS DISTINCT FROM NEW.college_role OR OLD.is_verified IS DISTINCT FROM NEW.is_verified) THEN
    SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();

    IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
      -- Silently reset privilege columns to existing values
      NEW.college_role := OLD.college_role;
      NEW.is_verified := OLD.is_verified;
    END IF;
  END IF;

  -- Protect must_change_password from unauthorized direct manipulation
  IF (OLD.must_change_password IS DISTINCT FROM NEW.must_change_password) THEN
    IF current_setting('campus.in_password_change', true) IS DISTINCT FROM 'true' THEN
      SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();
      IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
        NEW.must_change_password := OLD.must_change_password;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_profile_privileges ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileges
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_privileges();

-- 2. ENFORCE CLUB APPROVAL RULES (Anti-Tampering)
CREATE OR REPLACE FUNCTION public.enforce_club_approval_rules()
RETURNS TRIGGER AS $$
DECLARE
  v_caller_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
    -- Non-admins CANNOT create active clubs directly
    IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
      NEW.status := 'pending_approval';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Non-admins CANNOT approve clubs or alter approval status
    IF (OLD.status IS DISTINCT FROM NEW.status) THEN
      IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
        NEW.status := OLD.status;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_club_approval_rules ON public.clubs;
CREATE TRIGGER trg_enforce_club_approval_rules
  BEFORE INSERT OR UPDATE ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_club_approval_rules();

-- 3. ENFORCE MEMBERSHIP STATE MACHINE (Anti-Self-Promotion)
CREATE OR REPLACE FUNCTION public.enforce_membership_state_machine()
RETURNS TRIGGER AS $$
DECLARE
  v_caller_role TEXT;
  v_caller_club_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();

  IF TG_OP = 'INSERT' THEN
    -- If non-admin, force defaults: role = member, status = pending
    IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
      NEW.user_id := auth.uid();
      NEW.role := 'member';
      NEW.status := 'pending';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- If non-admin, verify allowed transitions
    IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
      SELECT role INTO v_caller_club_role
      FROM public.club_memberships
      WHERE club_id = OLD.club_id AND user_id = auth.uid() AND status = 'active';

      -- Student cannot modify their own status or role
      IF auth.uid() = OLD.user_id AND (OLD.role IS DISTINCT FROM NEW.role OR OLD.status IS DISTINCT FROM NEW.status) THEN
        IF v_caller_club_role IS DISTINCT FROM 'president' THEN
          RAISE EXCEPTION 'Students cannot approve their own membership or elevate their own roles';
        END IF;
      END IF;

      -- Changing role to organizer requires president
      IF OLD.role IS DISTINCT FROM NEW.role THEN
        IF v_caller_club_role IS DISTINCT FROM 'president' THEN
          RAISE EXCEPTION 'Only the club president can assign organizer roles';
        END IF;
        IF NEW.role = 'president' THEN
          RAISE EXCEPTION 'President role cannot be assigned through standard updates';
        END IF;
      END IF;

      -- Approving membership requires organizer or president
      IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF v_caller_club_role NOT IN ('president', 'organizer') THEN
          RAISE EXCEPTION 'Only club organizers can approve or reject membership requests';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_membership_state_machine ON public.club_memberships;
CREATE TRIGGER trg_enforce_membership_state_machine
  BEFORE INSERT OR UPDATE ON public.club_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_membership_state_machine();

-- 4. AUTO-NOTIFICATIONS TRIGGERS
CREATE OR REPLACE FUNCTION public.handle_membership_notifications()
RETURNS TRIGGER AS $$
DECLARE
  v_club_name TEXT;
  v_user_name TEXT;
  v_organizer RECORD;
BEGIN
  SELECT name INTO v_club_name FROM public.clubs WHERE id = NEW.club_id;
  SELECT username INTO v_user_name FROM public.profiles WHERE id = NEW.user_id;

  -- On INSERT with status 'pending': Notify club organizers/presidents
  IF (TG_OP = 'INSERT' AND NEW.status = 'pending') THEN
    FOR v_organizer IN 
      SELECT user_id FROM public.club_memberships 
      WHERE club_id = NEW.club_id AND role IN ('president', 'organizer') AND status = 'active'
    LOOP
      INSERT INTO public.notifications (user_id, type, title, message, resource_type, resource_id)
      VALUES (
        v_organizer.user_id,
        'membership_requested',
        'New Club Membership Request',
        v_user_name || ' requested to join ' || v_club_name,
        'club',
        NEW.club_id::text
      );
    END LOOP;
  END IF;

  -- On UPDATE from 'pending' to 'active': Notify student
  IF (TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'active') THEN
    INSERT INTO public.notifications (user_id, type, title, message, resource_type, resource_id)
    VALUES (
      NEW.user_id,
      'membership_approved',
      'Membership Approved! 🎉',
      'You are now an active member of ' || v_club_name,
      'club',
      NEW.club_id::text
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_handle_membership_notifications ON public.club_memberships;
CREATE TRIGGER trg_handle_membership_notifications
  AFTER INSERT OR UPDATE ON public.club_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_membership_notifications();

-- 5. ANNOUNCEMENTS BROADCAST TRIGGER
CREATE OR REPLACE FUNCTION public.handle_announcement_broadcast()
RETURNS TRIGGER AS $$
DECLARE
  v_ch_type TEXT;
  v_club_id UUID;
  v_club_name TEXT;
  v_member RECORD;
BEGIN
  SELECT type, club_id INTO v_ch_type, v_club_id
  FROM public.club_channels
  WHERE id = NEW.channel_id;

  IF v_ch_type = 'announcements' THEN
    SELECT name INTO v_club_name FROM public.clubs WHERE id = v_club_id;

    FOR v_member IN
      SELECT user_id FROM public.club_memberships
      WHERE club_id = v_club_id AND status = 'active' AND user_id != NEW.sender_id
    LOOP
      INSERT INTO public.notifications (user_id, type, title, message, resource_type, resource_id)
      VALUES (
        v_member.user_id,
        'announcement',
        'Notice from ' || v_club_name,
        SUBSTRING(NEW.content FROM 1 FOR 120),
        'club',
        v_club_id::text
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_handle_announcement_broadcast ON public.channel_messages;
CREATE TRIGGER trg_handle_announcement_broadcast
  AFTER INSERT ON public.channel_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_announcement_broadcast();

-- 6. COLLEGE USER ONBOARDING & VERIFICATION TRIGGER
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  base_username TEXT;
  final_username TEXT;
  dept TEXT;
  yr TEXT;
  s_id TEXT;
  user_email TEXT;
  is_edu_domain BOOLEAN := false;
BEGIN
  user_email := LOWER(COALESCE(NEW.email, ''));
  base_username := TRIM(COALESCE(NEW.raw_user_meta_data->>'username', 'student_' || LEFT(NEW.id::text, 6)));
  IF base_username = '' THEN
    base_username := 'student_' || LEFT(NEW.id::text, 6);
  END IF;

  final_username := base_username;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE username = final_username AND id != NEW.id) THEN
    final_username := base_username || '_' || LEFT(NEW.id::text, 4);
  END IF;

  dept := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'department', '')), '');
  yr := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'year', '')), '');
  s_id := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'student_id', '')), '');

  -- Verification: Check for institutional .edu or college email domain
  IF user_email LIKE '%.edu' OR user_email LIKE '%college%' OR user_email LIKE '%campus%' OR user_email LIKE '%univ%' THEN
    is_edu_domain := true;
  END IF;

  INSERT INTO public.profiles (id, username, department, year, student_id, college_role, is_verified, must_change_password)
  VALUES (
    NEW.id,
    final_username,
    COALESCE(dept, 'Computer Science & Engineering'),
    COALESCE(yr, '1st Year'),
    s_id,
    'student',
    is_edu_domain,
    COALESCE((NEW.raw_user_meta_data->>'must_change_password')::boolean, true)
  )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    department = COALESCE(public.profiles.department, EXCLUDED.department),
    year = COALESCE(public.profiles.year, EXCLUDED.year),
    student_id = COALESCE(public.profiles.student_id, EXCLUDED.student_id);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- STORED PROCEDURES / SECURE RPCs
-- ============================================================================

-- MEMBERSHIP APPROVAL RPC
CREATE OR REPLACE FUNCTION public.approve_club_membership(p_membership_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_mem RECORD;
  v_is_authorized BOOLEAN;
BEGIN
  SELECT * INTO v_mem FROM public.club_memberships WHERE id = p_membership_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership record not found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = v_mem.club_id AND user_id = v_caller_id AND role IN ('president', 'organizer') AND status = 'active'
    UNION
    SELECT 1 FROM public.profiles
    WHERE id = v_caller_id AND college_role = 'college_admin'
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Unauthorized: Only club organizers or college administrators can approve memberships';
  END IF;

  UPDATE public.club_memberships
  SET status = 'active'
  WHERE id = p_membership_id;

  RETURN jsonb_build_object('success', true, 'membership_id', p_membership_id, 'status', 'active');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- MEMBERSHIP REJECTION RPC
CREATE OR REPLACE FUNCTION public.reject_club_membership(p_membership_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_mem RECORD;
  v_is_authorized BOOLEAN;
BEGIN
  SELECT * INTO v_mem FROM public.club_memberships WHERE id = p_membership_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership record not found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = v_mem.club_id AND user_id = v_caller_id AND role IN ('president', 'organizer') AND status = 'active'
    UNION
    SELECT 1 FROM public.profiles
    WHERE id = v_caller_id AND college_role = 'college_admin'
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Unauthorized: Only club organizers or college administrators can reject memberships';
  END IF;

  DELETE FROM public.club_memberships WHERE id = p_membership_id;

  RETURN jsonb_build_object('success', true, 'membership_id', p_membership_id, 'status', 'rejected');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- APPOINT ORGANIZER RPC
CREATE OR REPLACE FUNCTION public.appoint_club_organizer(p_membership_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_mem RECORD;
  v_is_authorized BOOLEAN;
BEGIN
  SELECT * INTO v_mem FROM public.club_memberships WHERE id = p_membership_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership record not found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = v_mem.club_id AND user_id = v_caller_id AND role = 'president' AND status = 'active'
    UNION
    SELECT 1 FROM public.profiles
    WHERE id = v_caller_id AND college_role = 'college_admin'
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Unauthorized: Only the club president or college administrator can appoint organizers';
  END IF;

  UPDATE public.club_memberships
  SET role = 'organizer'
  WHERE id = p_membership_id;

  RETURN jsonb_build_object('success', true, 'membership_id', p_membership_id, 'role', 'organizer');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1. ATOMIC EVENT REGISTRATION
CREATE OR REPLACE FUNCTION public.register_for_event(p_event_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_event RECORD;
  v_current_count INT;
  v_existing_reg RECORD;
  v_new_reg RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required to register for events';
  END IF;

  -- Lock event row to prevent concurrent race conditions
  SELECT id, club_id, title, capacity, is_published, start_time
  INTO v_event
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  IF NOT v_event.is_published THEN
    RAISE EXCEPTION 'Event is not published';
  END IF;

  IF v_event.start_time < NOW() THEN
    RAISE EXCEPTION 'Cannot register for past events';
  END IF;

  -- Check existing registration
  SELECT id, status INTO v_existing_reg
  FROM public.event_registrations
  WHERE event_id = p_event_id AND user_id = v_user_id;

  IF FOUND THEN
    IF v_existing_reg.status = 'registered' THEN
      RAISE EXCEPTION 'Already registered for this event';
    ELSIF v_existing_reg.status = 'cancelled' THEN
      UPDATE public.event_registrations
      SET status = 'registered', checked_in_at = NULL
      WHERE id = v_existing_reg.id
      RETURNING * INTO v_new_reg;

      RETURN jsonb_build_object('success', true, 'registration_id', v_new_reg.id, 'qr_code_token', v_new_reg.qr_code_token);
    END IF;
  END IF;

  -- Verify capacity atomically
  IF v_event.capacity IS NOT NULL THEN
    SELECT COUNT(*) INTO v_current_count
    FROM public.event_registrations
    WHERE event_id = p_event_id AND status = 'registered';

    IF v_current_count >= v_event.capacity THEN
      RAISE EXCEPTION 'Event has reached maximum capacity (% seats)', v_event.capacity;
    END IF;
  END IF;

  INSERT INTO public.event_registrations (event_id, user_id, status)
  VALUES (p_event_id, v_user_id, 'registered')
  RETURNING * INTO v_new_reg;

  RETURN jsonb_build_object(
    'success', true,
    'registration_id', v_new_reg.id,
    'qr_code_token', v_new_reg.qr_code_token
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. CONTROLLED CANCELLATION
CREATE OR REPLACE FUNCTION public.cancel_event_registration(p_event_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  DELETE FROM public.event_registrations
  WHERE event_id = p_event_id AND user_id = v_user_id;

  RETURN jsonb_build_object('success', true, 'message', 'Registration cancelled successfully');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. SERVER-VALIDATED ATTENDANCE CHECK-IN
CREATE OR REPLACE FUNCTION public.check_in_event_attendee(p_event_id UUID, p_qr_token TEXT)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_event RECORD;
  v_is_authorized BOOLEAN;
  v_reg RECORD;
  v_attendee_name TEXT;
BEGIN
  SELECT ev.id, ev.club_id, ev.title INTO v_event
  FROM public.events ev
  WHERE ev.id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  -- Verify caller is organizer or admin
  SELECT EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = v_event.club_id AND user_id = v_caller_id AND role IN ('president', 'organizer') AND status = 'active'
    UNION
    SELECT 1 FROM public.profiles
    WHERE id = v_caller_id AND college_role = 'college_admin'
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Unauthorized: Only event organizers can scan tickets';
  END IF;

  SELECT * INTO v_reg
  FROM public.event_registrations
  WHERE event_id = p_event_id AND qr_code_token = p_qr_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid ticket pass or QR code';
  END IF;

  IF v_reg.status = 'cancelled' THEN
    RAISE EXCEPTION 'This registration was cancelled';
  END IF;

  IF v_reg.checked_in_at IS NOT NULL THEN
    RAISE EXCEPTION 'Attendee already checked in at %', v_reg.checked_in_at;
  END IF;

  UPDATE public.event_registrations
  SET checked_in_at = NOW(), status = 'attended'
  WHERE id = v_reg.id;

  SELECT username INTO v_attendee_name FROM public.profiles WHERE id = v_reg.user_id;

  RETURN jsonb_build_object(
    'success', true,
    'attendee_name', v_attendee_name,
    'checked_in_at', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. VERIFY STUDENT ACCOUNT (Admin Only)
CREATE OR REPLACE FUNCTION public.verify_student_account(p_user_id UUID, p_is_verified BOOLEAN)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_is_admin BOOLEAN;
BEGIN
  SELECT (college_role = 'college_admin') INTO v_is_admin
  FROM public.profiles WHERE id = v_caller_id;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Unauthorized: Only college administrators can verify accounts';
  END IF;

  UPDATE public.profiles
  SET is_verified = p_is_verified, updated_at = NOW()
  WHERE id = p_user_id;

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id, 'is_verified', p_is_verified);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- FIRST TIME PASSWORD CHANGE COMPLETION RPC
CREATE OR REPLACE FUNCTION public.complete_first_time_password_change()
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM set_config('campus.in_password_change', 'true', true);

  UPDATE public.profiles
  SET must_change_password = false,
      updated_at = now()
  WHERE id = v_user_id;

  RETURN jsonb_build_object('success', true, 'message', 'Password change completed successfully');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- STRICT ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Clean existing policies to ensure zero permissive leakage
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN (
      'clubs', 'club_memberships', 'club_channels', 'channel_messages',
      'events', 'event_registrations', 'notifications', 'profiles'
    )
  ) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- PROFILES POLICIES
CREATE POLICY "Anyone can view profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- CLUBS POLICIES
CREATE POLICY "View active clubs or own pending clubs" ON public.clubs
  FOR SELECT TO authenticated
  USING (
    status = 'active' OR
    created_by = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
  );

CREATE POLICY "Propose clubs" ON public.clubs
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = created_by
  );

CREATE POLICY "Admins or presidents update clubs" ON public.clubs
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_memberships
      WHERE club_id = clubs.id AND user_id = auth.uid() AND role = 'president' AND status = 'active'
    ) OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
  );

-- HELPER FUNCTIONS FOR NON-RECURSIVE RLS EVALUATION
CREATE OR REPLACE FUNCTION public.is_club_organizer_or_admin(p_club_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND college_role = 'college_admin') THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = p_club_id AND user_id = p_user_id AND role IN ('president', 'organizer') AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_active_club_member_or_admin(p_club_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND college_role = 'college_admin') THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- CLUB MEMBERSHIPS POLICIES
CREATE POLICY "View active memberships or own request" ON public.club_memberships
  FOR SELECT TO authenticated
  USING (
    status = 'active' OR
    user_id = auth.uid() OR
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

CREATE POLICY "Request club membership" ON public.club_memberships
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
  );

CREATE POLICY "Organizers or admins update membership" ON public.club_memberships
  FOR UPDATE TO authenticated
  USING (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

CREATE POLICY "Leave club or remove membership" ON public.club_memberships
  FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id OR
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

-- CLUB CHANNELS POLICIES
CREATE POLICY "Active members view channels" ON public.club_channels
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_memberships cm
      WHERE cm.club_id = club_channels.club_id AND cm.user_id = auth.uid() AND cm.status = 'active'
    ) OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
  );

CREATE POLICY "Organizers create channels" ON public.club_channels
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

-- CHANNEL MESSAGES POLICIES
CREATE POLICY "Active members view channel messages" ON public.channel_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_channels cc
      WHERE cc.id = channel_messages.channel_id
        AND public.is_active_club_member_or_admin(cc.club_id, auth.uid())
    )
  );

CREATE POLICY "Authorized members post messages" ON public.channel_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id AND
    EXISTS (
      SELECT 1 FROM public.club_channels cc
      WHERE cc.id = channel_messages.channel_id
        AND public.is_active_club_member_or_admin(cc.club_id, auth.uid())
        AND (cc.type != 'announcements' OR public.is_club_organizer_or_admin(cc.club_id, auth.uid()))
    )
  );

-- EVENTS POLICIES
CREATE POLICY "View published events or organizer drafts" ON public.events
  FOR SELECT TO authenticated
  USING (
    is_published = true OR
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

CREATE POLICY "Organizers create events" ON public.events
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

CREATE POLICY "Organizers update events" ON public.events
  FOR UPDATE TO authenticated
  USING (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

-- EVENT REGISTRATIONS POLICIES (Strict Privacy)
CREATE POLICY "Attendee or organizer views registration" ON public.event_registrations
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM public.events ev
      WHERE ev.id = event_registrations.event_id
        AND public.is_club_organizer_or_admin(ev.club_id, auth.uid())
    )
  );

CREATE POLICY "User inserts own registration" ON public.event_registrations
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
  );

CREATE POLICY "User or organizer updates registration" ON public.event_registrations
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM public.events ev
      WHERE ev.id = event_registrations.event_id
        AND public.is_club_organizer_or_admin(ev.club_id, auth.uid())
    )
  );

CREATE POLICY "User cancels own registration" ON public.event_registrations
  FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
  );

-- NOTIFICATIONS POLICIES
CREATE POLICY "Users view own notifications" ON public.notifications
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users update own notifications" ON public.notifications
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authorized system inserts notifications" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (true);
