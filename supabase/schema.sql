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
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true;

-- AUTOMATIC PROFILE CREATION TRIGGER ON AUTH SIGNUP / PROVISIONING
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  base_username TEXT;
  final_username TEXT;
  dept TEXT;
  yr TEXT;
  s_id TEXT;
BEGIN
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

  -- SECURITY HARDENING:
  -- college_role ALWAYS defaults to 'student' (admin must elevate)
  -- is_verified ALWAYS defaults to false (must be verified by admin)
  -- must_change_password ALWAYS defaults to true (untrusted metadata CANNOT override)
  INSERT INTO public.profiles (
    id, 
    username, 
    department, 
    year, 
    student_id, 
    college_role, 
    is_verified, 
    must_change_password
  )
  VALUES (
    NEW.id,
    final_username,
    COALESCE(dept, 'Computer Science & Engineering'),
    COALESCE(yr, '1st Year'),
    s_id,
    'student',
    false,
    true
  )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    department = COALESCE(public.profiles.department, EXCLUDED.department),
    year = COALESCE(public.profiles.year, EXCLUDED.year),
    student_id = COALESCE(public.profiles.student_id, EXCLUDED.student_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- AUTOMATIC PASSWORD CHANGE COMPLETION TRIGGER ON AUTH.USERS
CREATE OR REPLACE FUNCTION public.handle_auth_user_password_changed()
RETURNS TRIGGER AS $$
BEGIN
  -- When password hash changes in auth.users, automatically clear must_change_password in profile
  IF OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password THEN
    UPDATE public.profiles
    SET must_change_password = false
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_auth_user_password_changed ON auth.users;
CREATE TRIGGER trg_auth_user_password_changed
  AFTER UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_auth_user_password_changed();

-- PRIVILEGE PROTECTION TRIGGER ON PUBLIC.PROFILES
CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS TRIGGER AS $$
DECLARE
  caller_role TEXT;
BEGIN
  -- Service role or internal triggers bypass
  IF auth.role() = 'service_role' OR auth.role() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT college_role INTO caller_role
  FROM public.profiles
  WHERE id = auth.uid();

  IF TG_OP = 'INSERT' THEN
    -- When creating/inserting a profile, regular authenticated users cannot self-assign privileged roles or verified status
    IF caller_role IS DISTINCT FROM 'college_admin' THEN
      NEW.college_role := 'student';
      NEW.is_verified := false;
      NEW.must_change_password := true;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- If caller is regular authenticated user (not college_admin), block modifying privileged fields
    IF caller_role IS DISTINCT FROM 'college_admin' THEN
      IF NEW.college_role IS DISTINCT FROM OLD.college_role THEN
        RAISE EXCEPTION 'Unauthorized: Only college admins can modify college roles';
      END IF;
      IF NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
        RAISE EXCEPTION 'Unauthorized: Only college admins can modify verification status';
      END IF;
      IF NEW.must_change_password IS DISTINCT FROM OLD.must_change_password AND NEW.must_change_password = false THEN
        RAISE EXCEPTION 'Unauthorized: Password change flag can only be updated via password reset workflow';
      END IF;
      IF OLD.is_verified = true AND NEW.student_id IS DISTINCT FROM OLD.student_id THEN
        RAISE EXCEPTION 'Unauthorized: Verified student roll number cannot be modified by students';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_profile_privileges ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileges
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_privileges();

-- PRIVILEGE PROTECTION TRIGGER ON PUBLIC.CLUB_MEMBERSHIPS
CREATE OR REPLACE FUNCTION public.protect_club_membership_privileges()
RETURNS TRIGGER AS $$
DECLARE
  caller_role TEXT;
  is_admin BOOLEAN := false;
BEGIN
  -- Service role or internal triggers bypass
  IF auth.role() = 'service_role' OR auth.role() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT college_role INTO caller_role
  FROM public.profiles
  WHERE id = auth.uid();

  IF caller_role = 'college_admin' THEN
    is_admin := true;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Regular students can only request membership as a pending member
    IF NOT is_admin THEN
      NEW.role := 'member';
      NEW.status := 'pending';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only organizer or admin can update membership
    IF NOT is_admin AND NOT public.is_club_organizer_or_admin(OLD.club_id, auth.uid()) THEN
      RAISE EXCEPTION 'Unauthorized: Only club organizers or administrators can modify memberships';
    END IF;

    -- Only president or college_admin can assign president or organizer role
    IF (NEW.role IN ('president', 'organizer') AND NEW.role IS DISTINCT FROM OLD.role) THEN
      IF NOT is_admin AND NOT EXISTS (
        SELECT 1 FROM public.club_memberships
        WHERE club_id = OLD.club_id AND user_id = auth.uid() AND role = 'president' AND status = 'active'
      ) THEN
        RAISE EXCEPTION 'Unauthorized: Only the club president or college administrator can assign leadership roles';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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

DROP TRIGGER IF EXISTS trg_protect_club_membership ON public.club_memberships;
CREATE TRIGGER trg_protect_club_membership
  BEFORE INSERT OR UPDATE ON public.club_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_club_membership_privileges();

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

-- ============================================================================
-- STORED PROCEDURES / SECURE RPCs
-- ===============================================================================

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
  WHERE event_id = p_event_id AND qr_code_token = p_qr_token
  FOR UPDATE;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.check_in_event_attendee(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_in_event_attendee(UUID, TEXT) TO authenticated;

-- 3b. EVENT REGISTRATION STATISTICS RPC
CREATE OR REPLACE FUNCTION public.get_event_registration_stats(p_event_ids UUID[])
RETURNS TABLE (
  event_id UUID,
  registration_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required to view event registration statistics';
  END IF;

  RETURN QUERY
  SELECT 
    ev.id AS event_id,
    COUNT(er.id)::BIGINT AS registration_count
  FROM unnest(p_event_ids) AS req(id)
  JOIN public.events ev ON ev.id = req.id
  LEFT JOIN public.event_registrations er 
    ON er.event_id = ev.id 
    AND er.status IN ('registered', 'attended')
  GROUP BY ev.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_event_registration_stats(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_event_registration_stats(UUID[]) TO authenticated;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.verify_student_account(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_student_account(UUID, BOOLEAN) TO authenticated;

-- 5. COMPLETE FIRST TIME PASSWORD CHANGE RPC
CREATE OR REPLACE FUNCTION public.complete_first_time_password_change()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  PERFORM set_config('campus.in_password_change', 'true', true);

  UPDATE public.profiles
  SET must_change_password = false, updated_at = NOW()
  WHERE id = v_caller_id;

  RETURN jsonb_build_object('success', true, 'message', 'Password change completed successfully');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_first_time_password_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_first_time_password_change() TO authenticated;

-- TRUSTED SERVER-SIDE PASSWORD CHANGE TRIGGER (TAMPER-PROOF)
-- Automatically fires when auth.users.encrypted_password changes in Supabase Auth.
-- Clients never directly clear must_change_password; it only clears upon actual password update.
CREATE OR REPLACE FUNCTION public.on_auth_user_password_changed()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password) THEN
    PERFORM set_config('campus.in_password_change', 'true', true);
    UPDATE public.profiles
    SET must_change_password = false,
        updated_at = now()
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_auth_user_password_changed ON auth.users;
CREATE TRIGGER trg_auth_user_password_changed
  AFTER UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.on_auth_user_password_changed();

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
    auth.uid() = user_id AND
    role = 'member' AND
    status = 'pending'
  );

CREATE POLICY "Admins insert membership" ON public.club_memberships
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
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

CREATE POLICY "Admins insert notifications" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
  );

-- ============================================================================
-- STORAGE BUCKETS INITIALIZATION AND STRICT RLS POLICIES
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars', 
  'avatars', 
  true, 
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET 
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'posts', 
  'posts', 
  true, 
  20971520,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime']
)
ON CONFLICT (id) DO UPDATE SET 
  public = true,
  file_size_limit = 20971520,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'];

-- AVATARS STORAGE POLICIES
DROP POLICY IF EXISTS "Public can view avatars" ON storage.objects;
CREATE POLICY "Public can view avatars" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Users upload own avatar" ON storage.objects;
CREATE POLICY "Users upload own avatar" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] = auth.uid()::text AND
    LOWER(storage.extension(name)) IN ('jpg', 'jpeg', 'png', 'webp', 'gif')
  );

DROP POLICY IF EXISTS "Users update own avatar" ON storage.objects;
CREATE POLICY "Users update own avatar" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] = auth.uid()::text AND
    LOWER(storage.extension(name)) IN ('jpg', 'jpeg', 'png', 'webp', 'gif')
  );

DROP POLICY IF EXISTS "Users delete own avatar" ON storage.objects;
CREATE POLICY "Users delete own avatar" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars' AND
    (
      (storage.foldername(name))[1] = auth.uid()::text OR
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
    )
  );

-- POST MEDIA STORAGE POLICIES
DROP POLICY IF EXISTS "Public can view posts" ON storage.objects;
CREATE POLICY "Public can view posts" ON storage.objects
  FOR SELECT USING (bucket_id = 'posts');

DROP POLICY IF EXISTS "Users upload own post media" ON storage.objects;
CREATE POLICY "Users upload own post media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'posts' AND
    (storage.foldername(name))[1] = auth.uid()::text AND
    LOWER(storage.extension(name)) IN ('jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov')
  );

DROP POLICY IF EXISTS "Users update own post media" ON storage.objects;
CREATE POLICY "Users update own post media" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'posts' AND
    (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'posts' AND
    (storage.foldername(name))[1] = auth.uid()::text AND
    LOWER(storage.extension(name)) IN ('jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov')
  );

DROP POLICY IF EXISTS "Users delete own post media" ON storage.objects;
CREATE POLICY "Users delete own post media" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'posts' AND
    (
      (storage.foldername(name))[1] = auth.uid()::text OR
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
    )
  );

-- ============================================================================
-- MESSAGE READ STATE, NARROW UPDATE PRIVILEGES, & IMMUTABILITY
-- ============================================================================

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_messages_convo_read ON public.messages(conversation_id, sender_id, is_read);

REVOKE UPDATE ON public.messages FROM authenticated;
GRANT UPDATE (is_read, read_at) ON public.messages TO authenticated;

DROP POLICY IF EXISTS "Users can mark messages as read" ON public.messages;
CREATE POLICY "Users can mark messages as read" ON public.messages
  FOR UPDATE TO authenticated
  USING (
    sender_id != auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  )
  WITH CHECK (
    sender_id != auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION public.protect_message_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content OR
     NEW.sender_id IS DISTINCT FROM OLD.sender_id OR
     NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Unauthorized: Message content and metadata are immutable. Only read status can be updated.';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.role() = 'authenticated' AND NEW.sender_id = auth.uid() THEN
    IF NEW.is_read IS DISTINCT FROM OLD.is_read OR NEW.read_at IS DISTINCT FROM OLD.read_at THEN
      RAISE EXCEPTION 'Unauthorized: Only recipients can mark messages as read.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_message_immutability ON public.messages;
CREATE TRIGGER trg_protect_message_immutability
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_message_immutability();

CREATE OR REPLACE FUNCTION public.mark_messages_read(p_conversation_id UUID)
RETURNS INT AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_updated_count INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversations
    WHERE id = p_conversation_id AND (user1_id = v_user_id OR user2_id = v_user_id)
  ) THEN
    RAISE EXCEPTION 'Unauthorized: Caller is not a participant in this conversation';
  END IF;

  UPDATE public.messages
  SET is_read = true, read_at = NOW()
  WHERE conversation_id = p_conversation_id
    AND sender_id != v_user_id
    AND is_read = false;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_unread_messages_count()
RETURNS INT AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_count INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  WHERE (c.user1_id = v_user_id OR c.user2_id = v_user_id)
    AND m.sender_id != v_user_id
    AND m.is_read = false;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================================================
-- CAMPUSCONNECT: ACADEMIC BRANCH REGISTRY & VERIFIED STUDENT DIRECTORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.academic_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course TEXT NOT NULL,
  branch_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course, branch_code)
);

ALTER TABLE public.academic_branches
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.academic_branch_prefixes (
  prefix TEXT PRIMARY KEY,
  branch_id UUID NOT NULL REFERENCES public.academic_branches(id) ON DELETE CASCADE,
  admission_year INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (prefix = upper(trim(prefix))),
  CHECK (admission_year BETWEEN 2000 AND 2100)
);

CREATE TABLE IF NOT EXISTS public.student_directory (
  roll_number TEXT PRIMARY KEY,
  branch_id UUID NOT NULL REFERENCES public.academic_branches(id),
  admission_year INTEGER NOT NULL,
  profile_id UUID UNIQUE REFERENCES public.profiles(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (roll_number = upper(trim(roll_number))),
  CHECK (length(roll_number) = 12),
  CHECK (admission_year BETWEEN 2000 AND 2100)
);

CREATE INDEX IF NOT EXISTS idx_student_directory_branch
  ON public.student_directory(branch_id);

CREATE INDEX IF NOT EXISTS idx_student_directory_active_branch
  ON public.student_directory(branch_id, is_active);

CREATE INDEX IF NOT EXISTS idx_student_directory_profile
  ON public.student_directory(profile_id);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id);

CREATE INDEX IF NOT EXISTS idx_profiles_branch_id
  ON public.profiles(branch_id);

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id);

CREATE INDEX IF NOT EXISTS idx_posts_branch_id
  ON public.posts(branch_id);

UPDATE public.posts p
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE p.user_id = pr.id
  AND p.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_student_directory_prefix()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_matching_prefix RECORD;
BEGIN
  NEW.roll_number := upper(trim(NEW.roll_number));

  IF length(NEW.roll_number) != 12 THEN
    RAISE EXCEPTION 'Roll number must be exactly 12 characters';
  END IF;

  SELECT prefix, branch_id, admission_year INTO v_matching_prefix
  FROM public.academic_branch_prefixes
  WHERE left(NEW.roll_number, length(prefix)) = prefix AND is_active = true
  ORDER BY length(prefix) DESC, prefix ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unconfigured or unknown roll number prefix for %', NEW.roll_number;
  END IF;

  IF v_matching_prefix.branch_id != NEW.branch_id THEN
    RAISE EXCEPTION 'Roll number prefix does not match assigned academic branch';
  END IF;

  IF v_matching_prefix.admission_year != NEW.admission_year THEN
    RAISE EXCEPTION 'Roll number prefix does not match assigned admission year';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_student_directory_prefix ON public.student_directory;
CREATE TRIGGER trg_validate_student_directory_prefix
  BEFORE INSERT OR UPDATE ON public.student_directory
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_student_directory_prefix();

CREATE OR REPLACE FUNCTION public.protect_profile_academic_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_is_admin BOOLEAN := false;
BEGIN
  IF v_caller_id IS NOT NULL THEN
    SELECT (college_role = 'college_admin') INTO v_is_admin
    FROM public.profiles
    WHERE id = v_caller_id;
  END IF;

  IF NOT COALESCE(v_is_admin, false) THEN
    IF OLD.student_id IS NOT NULL AND NEW.student_id IS DISTINCT FROM OLD.student_id THEN
      RAISE EXCEPTION 'Unauthorized: Student roll number cannot be modified';
    END IF;

    IF OLD.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
      RAISE EXCEPTION 'Unauthorized: Academic branch cannot be modified by student';
    END IF;

    IF NEW.college_role IS DISTINCT FROM OLD.college_role THEN
      RAISE EXCEPTION 'Unauthorized: College role cannot be self-modified';
    END IF;

    IF OLD.is_verified IS TRUE AND NEW.is_verified IS NOT TRUE THEN
      RAISE EXCEPTION 'Unauthorized: Verified status cannot be altered';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_academic_fields ON public.profiles;
CREATE TRIGGER trg_protect_profile_academic_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_academic_fields();

CREATE OR REPLACE FUNCTION public.resolve_student_branch(p_roll_number TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_roll TEXT := upper(trim(p_roll_number));
  v_result RECORD;
BEGIN
  IF length(v_clean_roll) != 12 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Roll number must be exactly 12 characters');
  END IF;

  SELECT 
    ab.id AS branch_id,
    ab.course,
    ab.branch_code,
    ab.display_name,
    abp.admission_year,
    abp.prefix
  INTO v_result
  FROM public.academic_branch_prefixes abp
  JOIN public.academic_branches ab ON ab.id = abp.branch_id
  WHERE left(v_clean_roll, length(abp.prefix)) = abp.prefix AND abp.is_active = true
  ORDER BY length(abp.prefix) DESC, abp.prefix ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Roll number prefix is not configured in the academic directory'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'branch_id', v_result.branch_id,
    'course', v_result.course,
    'branch_code', v_result.branch_code,
    'display_name', v_result.display_name,
    'admission_year', v_result.admission_year,
    'prefix', v_result.prefix
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_student_branch(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_student_branch(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_authenticated_student_directory()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_profile RECORD;
  v_dir RECORD;
  v_branch RECORD;
  v_rows_updated INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 1. Load caller's profile
  SELECT * INTO v_profile FROM public.profiles WHERE id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile record not found';
  END IF;

  IF v_profile.student_id IS NULL OR trim(v_profile.student_id) = '' THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'No student roll number on profile');
  END IF;

  -- 2. Lock directory record with FOR UPDATE
  SELECT * INTO v_dir
  FROM public.student_directory
  WHERE roll_number = upper(trim(v_profile.student_id)) AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'Student roll number not found in active directory');
  END IF;

  -- 3. Check ownership: record must be unclaimed OR belong to current user
  IF v_dir.profile_id IS NOT NULL AND v_dir.profile_id != v_user_id THEN
    RAISE EXCEPTION 'Directory record already linked to another account'
      USING HINT = 'Contact campus administration if you believe this is an error.';
  END IF;

  -- 4. Atomically link directory row to profile and verify exactly 1 row updated
  UPDATE public.student_directory
  SET profile_id = v_user_id
  WHERE roll_number = v_dir.roll_number
    AND (profile_id IS NULL OR profile_id = v_user_id);

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated != 1 THEN
    RAISE EXCEPTION 'Directory link failed: expected 1 row updated, got %', v_rows_updated
      USING HINT = 'This may indicate a concurrent claim attempt. Please retry.';
  END IF;

  -- 5. Only after link succeeds, update profile
  SELECT * INTO v_branch FROM public.academic_branches WHERE id = v_dir.branch_id;

  UPDATE public.profiles
  SET branch_id = v_dir.branch_id,
      department = v_branch.display_name,
      is_verified = true,
      updated_at = NOW()
  WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'linked', true,
    'roll_number', v_dir.roll_number,
    'branch_id', v_dir.branch_id,
    'course', v_branch.course,
    'branch_code', v_branch.branch_code,
    'display_name', v_branch.display_name,
    'admission_year', v_dir.admission_year
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_authenticated_student_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_authenticated_student_directory() TO authenticated;

CREATE OR REPLACE FUNCTION public.search_campus_students(
  p_query TEXT DEFAULT '',
  p_branch_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 20
)
RETURNS TABLE(
  id UUID,
  username TEXT,
  avatar_url TEXT,
  department TEXT,
  student_id TEXT,
  branch_id UUID,
  course TEXT,
  branch_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sanitized TEXT := trim(COALESCE(p_query, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  SELECT 
    p.id,
    p.username,
    p.avatar_url,
    p.department,
    -- Mask roll number for student privacy: expose only last 4 digits
    CASE
      WHEN p.student_id IS NOT NULL AND length(p.student_id) > 4
        THEN repeat('*', length(p.student_id) - 4) || right(p.student_id, 4)
      ELSE p.student_id
    END AS student_id,
    p.branch_id,
    ab.course,
    ab.branch_code
  FROM public.profiles p
  LEFT JOIN public.academic_branches ab ON ab.id = p.branch_id
  WHERE (
    v_sanitized = '' OR
    p.username ILIKE ('%' || v_sanitized || '%') OR
    p.student_id ILIKE ('%' || v_sanitized || '%') OR
    p.department ILIKE ('%' || v_sanitized || '%')
  )
  AND (p_branch_id IS NULL OR p.branch_id = p_branch_id)
  LIMIT LEAST(p_limit, 50);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.search_campus_students(TEXT, UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_campus_students(TEXT, UUID, INT) TO authenticated;

ALTER TABLE public.academic_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.academic_branch_prefixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_directory ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.academic_branches FROM anon;
REVOKE ALL ON public.academic_branch_prefixes FROM anon;
REVOKE ALL ON public.student_directory FROM anon;

GRANT SELECT ON public.academic_branches TO authenticated;
GRANT SELECT ON public.academic_branch_prefixes TO authenticated;
GRANT SELECT ON public.student_directory TO authenticated;

DROP POLICY IF EXISTS "Academic branches viewable by authenticated users" ON public.academic_branches;
CREATE POLICY "Academic branches viewable by authenticated users"
  ON public.academic_branches
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Prefixes viewable by authenticated users" ON public.academic_branch_prefixes;
CREATE POLICY "Prefixes viewable by authenticated users"
  ON public.academic_branch_prefixes
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Active directory records viewable by authenticated users" ON public.student_directory;
DROP POLICY IF EXISTS "Students view own directory record" ON public.student_directory;
CREATE POLICY "Students view own directory record"
  ON public.student_directory
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
  );

DROP POLICY IF EXISTS "Admins can manage student directory" ON public.student_directory;
CREATE POLICY "Admins can manage student directory"
  ON public.student_directory
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin'));



