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

-- 2.1 SOCIAL TABLES (POSTS, LIKES, COMMENTS, FOLLOWERS)
CREATE TABLE IF NOT EXISTS public.posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  caption TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, post_id)
);
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.followers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(follower_id, following_id),
  CHECK (follower_id != following_id)
);
ALTER TABLE public.followers ENABLE ROW LEVEL SECURITY;

-- 2.2 DIRECT MESSAGING (CONVERSATIONS & MESSAGES)
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user1_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user2_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_message_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user1_id, user2_id)
);
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- BASELINE CONVERSATION AND MESSAGE POLICIES
DROP POLICY IF EXISTS "Users can view own conversations" ON public.conversations;
CREATE POLICY "Users can view own conversations"
  ON public.conversations FOR SELECT
  USING (auth.uid() = user1_id OR auth.uid() = user2_id);

DROP POLICY IF EXISTS "Auth users can create conversations" ON public.conversations;
CREATE POLICY "Auth users can create conversations"
  ON public.conversations FOR INSERT
  WITH CHECK (auth.uid() = user1_id OR auth.uid() = user2_id);

DROP POLICY IF EXISTS "Users can update own conversations" ON public.conversations;
CREATE POLICY "Users can update own conversations"
  ON public.conversations FOR UPDATE
  USING (auth.uid() = user1_id OR auth.uid() = user2_id);

DROP POLICY IF EXISTS "Users can view messages in their conversations" ON public.messages;
CREATE POLICY "Users can view messages in their conversations"
  ON public.messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can send messages in their conversations" ON public.messages;
CREATE POLICY "Users can send messages in their conversations"
  ON public.messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );

-- BASELINE SOCIAL POLICIES
DROP POLICY IF EXISTS "Auth users can create posts" ON public.posts;
CREATE POLICY "Auth users can create posts" ON public.posts FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own posts" ON public.posts;
CREATE POLICY "Users can update own posts" ON public.posts FOR UPDATE TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own posts" ON public.posts;
CREATE POLICY "Users can delete own posts" ON public.posts FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Anyone can view likes" ON public.likes;
DROP POLICY IF EXISTS "Likes are viewable by authenticated users" ON public.likes;
CREATE POLICY "Likes are viewable by authenticated users" ON public.likes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Auth users can like" ON public.likes;
CREATE POLICY "Auth users can like" ON public.likes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can unlike" ON public.likes;
CREATE POLICY "Users can unlike" ON public.likes FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Anyone can view comments" ON public.comments;
DROP POLICY IF EXISTS "Comments are viewable by authenticated users" ON public.comments;
CREATE POLICY "Comments are viewable by authenticated users" ON public.comments FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Auth users can comment" ON public.comments;
CREATE POLICY "Auth users can comment" ON public.comments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own comments" ON public.comments;
CREATE POLICY "Users can delete own comments" ON public.comments FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Anyone can view followers" ON public.followers;
DROP POLICY IF EXISTS "Followers are viewable by authenticated users" ON public.followers;
CREATE POLICY "Followers are viewable by authenticated users" ON public.followers FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Auth users can follow" ON public.followers;
CREATE POLICY "Auth users can follow" ON public.followers FOR INSERT TO authenticated WITH CHECK (auth.uid() = follower_id);
DROP POLICY IF EXISTS "Users can unfollow" ON public.followers;
CREATE POLICY "Users can unfollow" ON public.followers FOR DELETE TO authenticated USING (auth.uid() = follower_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.posts TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.likes TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.comments TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.followers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.conversations TO authenticated;
GRANT SELECT, INSERT ON public.messages TO authenticated;

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
CREATE OR REPLACE FUNCTION public.generate_qr_token()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    RETURN encode(public.gen_random_bytes(16), 'hex');
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      RETURN encode(extensions.gen_random_bytes(16), 'hex');
    EXCEPTION WHEN OTHERS THEN
      RETURN replace(pg_catalog.gen_random_uuid()::text, '-', '');
    END;
  END;
END;
$$;

CREATE TABLE IF NOT EXISTS public.event_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'waitlist', 'attended', 'cancelled')),
  qr_code_token TEXT NOT NULL UNIQUE DEFAULT public.generate_qr_token(),
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
DROP FUNCTION IF EXISTS public.cancel_event_registration(UUID);
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
  v_must_change BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT must_change_password INTO v_must_change
  FROM public.profiles
  WHERE id = v_caller_id;

  -- Security rule: The flag is automatically cleared server-side by public.handle_auth_user_password_changed() trigger on auth.users.
  -- Direct client invocations without updating the password in auth.users are rejected.
  IF COALESCE(v_must_change, true) THEN
    RAISE EXCEPTION 'Password has not been updated yet. You must complete a password update via the auth service before this requirement can be cleared.';
  END IF;

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
DROP POLICY IF EXISTS "Anyone can view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users view profiles" ON public.profiles;
CREATE POLICY "Authenticated users view profiles" ON public.profiles
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
  ON public.student_directory(profile_id);ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id);

CREATE INDEX IF NOT EXISTS idx_profiles_branch_id
  ON public.profiles(branch_id);

-- Posts
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id),
  ADD COLUMN IF NOT EXISTS content_visibility TEXT NOT NULL DEFAULT 'college'
  CHECK (content_visibility IN ('college', 'branch', 'club_members'));

CREATE INDEX IF NOT EXISTS idx_posts_branch_id
  ON public.posts(branch_id);

-- Events
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id),
  ADD COLUMN IF NOT EXISTS content_visibility TEXT NOT NULL DEFAULT 'college'
  CHECK (content_visibility IN ('college', 'branch', 'club_members'));

CREATE INDEX IF NOT EXISTS idx_events_branch_id
  ON public.events(branch_id);

-- Clubs
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id),
  ADD COLUMN IF NOT EXISTS content_visibility TEXT NOT NULL DEFAULT 'college'
  CHECK (content_visibility IN ('college', 'branch', 'club_members'));

CREATE INDEX IF NOT EXISTS idx_clubs_branch_id
  ON public.clubs(branch_id);

-- Channel messages (announcements)
ALTER TABLE public.channel_messages
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id),
  ADD COLUMN IF NOT EXISTS content_visibility TEXT NOT NULL DEFAULT 'college'
  CHECK (content_visibility IN ('college', 'branch', 'club_members'));

CREATE INDEX IF NOT EXISTS idx_channel_messages_branch_id
  ON public.channel_messages(branch_id);

-- 5. VALIDATION TRIGGER: LITERAL PREFIX MATCHING WITH LONGEST-PREFIX PRECEDENCE
CREATE OR REPLACE FUNCTION public.validate_student_directory_prefix()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_matching_prefix RECORD;
BEGIN
  NEW.roll_number := pg_catalog.upper(pg_catalog.btrim(NEW.roll_number));

  IF pg_catalog.length(NEW.roll_number) != 12 THEN
    RAISE EXCEPTION 'Roll number must be exactly 12 characters';
  END IF;

  SELECT prefix, branch_id, admission_year INTO v_matching_prefix
  FROM public.academic_branch_prefixes
  WHERE pg_catalog.left(NEW.roll_number, pg_catalog.length(prefix)) = prefix AND is_active = true
  ORDER BY pg_catalog.length(prefix) DESC, prefix ASC
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

REVOKE ALL ON FUNCTION public.validate_student_directory_prefix() FROM PUBLIC;

-- DEDICATED PRIVILEGED ACADEMIC LINKING OPERATION
-- Narrowly scoped procedure callable only by verified internal routines.
CREATE SCHEMA IF NOT EXISTS internal;
REVOKE ALL ON SCHEMA internal FROM PUBLIC, authenticated, anon;
GRANT ALL ON SCHEMA internal TO postgres;

DROP TABLE IF EXISTS internal.active_sync_authorizations CASCADE;
CREATE TABLE internal.active_sync_authorizations (
  authorization_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL,
  target_branch_id UUID NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  consumed BOOLEAN NOT NULL DEFAULT false
);
REVOKE ALL ON TABLE internal.active_sync_authorizations FROM PUBLIC, authenticated, anon;
GRANT ALL ON TABLE internal.active_sync_authorizations TO postgres;

CREATE OR REPLACE FUNCTION public.internal_apply_directory_verification(
  p_user_id UUID,
  p_branch_id UUID,
  p_department TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth_id UUID := pg_catalog.gen_random_uuid();
BEGIN
  -- Set transaction-local operation id for this specific invocation
  PERFORM pg_catalog.set_config('internal.active_sync_op_id', v_auth_id::text, true);

  -- Register single-use authorization entry in private internal table
  INSERT INTO internal.active_sync_authorizations (authorization_id, user_id, target_branch_id, authorized_at, consumed)
  VALUES (v_auth_id, p_user_id, p_branch_id, pg_catalog.clock_timestamp(), false);

  UPDATE public.profiles
  SET branch_id = p_branch_id,
      department = p_department,
      is_verified = true,
      updated_at = pg_catalog.now()
  WHERE id = p_user_id;

  -- Clear authorization record immediately after update
  DELETE FROM internal.active_sync_authorizations WHERE authorization_id = v_auth_id;

  -- Clear session parameter
  PERFORM pg_catalog.set_config('internal.active_sync_op_id', '', true);
END;
$$;

-- Revoke all permissions from ordinary callers
REVOKE ALL ON FUNCTION public.internal_apply_directory_verification(UUID, UUID, TEXT) FROM PUBLIC, authenticated, anon;

-- 6. PROFILE ACADEMIC INTEGRITY & ROLE ESCALATION PROTECTION TRIGGER
-- Hardened with SET search_path = '' and covers BOTH INSERT and UPDATE.
-- Ensures no caller can self-grant college_admin or tamper with verified academic fields.
-- Permits academic field modifications only for college_admin or via internal_apply_directory_verification.
CREATE OR REPLACE FUNCTION public.protect_profile_academic_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

  -- ENFORCE ON INSERT: Ordinary users or new signups cannot self-grant college_admin or pre-verify
  IF TG_OP = 'INSERT' THEN
    IF NOT COALESCE(v_is_admin, false) THEN
      NEW.college_role := 'student';
      NEW.is_verified := false;
      NEW.must_change_password := true;
      NEW.branch_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- ENFORCE ON UPDATE: Non-admins cannot alter verified academic fields, branch, or self-escalate role
  IF TG_OP = 'UPDATE' THEN
    IF NOT COALESCE(v_is_admin, false) THEN
      IF OLD.student_id IS NOT NULL AND NEW.student_id IS DISTINCT FROM OLD.student_id THEN
        RAISE EXCEPTION 'Unauthorized: Student roll number cannot be modified';
      END IF;

      IF (OLD.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM OLD.branch_id) OR
         (NEW.is_verified IS DISTINCT FROM OLD.is_verified) THEN
        DECLARE
          v_op_id_str TEXT := pg_catalog.current_setting('internal.active_sync_op_id', true);
          v_op_id UUID;
          v_valid_auth BOOLEAN := false;
        BEGIN
          IF v_op_id_str IS NOT NULL AND v_op_id_str != '' THEN
            BEGIN
              v_op_id := v_op_id_str::uuid;
            EXCEPTION WHEN OTHERS THEN
              v_op_id := NULL;
            END;
          END IF;

          IF v_op_id IS NOT NULL THEN
            -- Atomically consume the specific authorization record tied to this operation
            UPDATE internal.active_sync_authorizations
            SET consumed = true
            WHERE authorization_id = v_op_id
              AND user_id = NEW.id
              AND target_branch_id = NEW.branch_id
              AND consumed = false
              AND authorized_at >= pg_catalog.clock_timestamp() - INTERVAL '5 seconds'
            RETURNING true INTO v_valid_auth;
          END IF;

          IF NOT COALESCE(v_valid_auth, false) THEN
            RAISE EXCEPTION 'Unauthorized: Academic status can only be modified through verified directory synchronization';
          END IF;
        END;
      END IF;

      IF NEW.college_role IS DISTINCT FROM OLD.college_role THEN
        RAISE EXCEPTION 'Unauthorized: College role cannot be self-modified';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_privileges ON public.profiles;

DROP TRIGGER IF EXISTS trg_protect_profile_academic_fields ON public.profiles;
CREATE TRIGGER trg_protect_profile_academic_fields
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_academic_fields();

REVOKE ALL ON FUNCTION public.protect_profile_academic_fields() FROM PUBLIC;

-- Defense-in-depth: Column-level permissions prevent authenticated users from directly updating sensitive academic fields
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (username, bio, avatar_url, updated_at) ON public.profiles TO authenticated;

-- Privacy protection: Prevent direct reading of sensitive student roll numbers (student_id) across all profiles
REVOKE ALL ON public.profiles FROM PUBLIC, anon;
REVOKE SELECT ON public.profiles FROM authenticated, anon;
GRANT SELECT (
  id,
  username,
  bio,
  avatar_url,
  college_role,
  department,
  year,
  branch_id,
  is_verified,
  created_at,
  updated_at
) ON public.profiles TO authenticated;

-- Dedicated secure RPC for authenticated users to view their own full profile including student_id
DROP FUNCTION IF EXISTS public.get_my_profile();
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS TABLE (
  id UUID,
  username TEXT,
  student_id TEXT,
  college_role TEXT,
  is_verified BOOLEAN,
  must_change_password BOOLEAN,
  department TEXT,
  year TEXT,
  branch_id UUID,
  bio TEXT,
  avatar_url TEXT,
  activation_expires_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT 
    p.id,
    p.username,
    p.student_id,
    p.college_role,
    p.is_verified,
    p.must_change_password,
    p.department,
    p.year,
    p.branch_id,
    p.bio,
    p.avatar_url,
    p.activation_expires_at,
    p.activated_at,
    p.created_at,
    p.updated_at
  FROM public.profiles p
  WHERE p.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_my_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;

-- Safe public profiles view exposing only authorized non-sensitive fields
CREATE OR REPLACE VIEW public.public_profiles AS
SELECT 
  id,
  username,
  bio,
  avatar_url,
  college_role,
  department,
  year,
  branch_id,
  is_verified,
  created_at
FROM public.profiles;

REVOKE ALL ON public.public_profiles FROM PUBLIC, anon;
GRANT SELECT ON public.public_profiles TO authenticated;

-- 7. SEED ACADEMIC BRANCHES & CONFIRMED PREFIXES
DO $$
DECLARE
  v_aiml_id UUID;
  v_cse_id UUID;
BEGIN
  INSERT INTO public.academic_branches (course, branch_code, display_name, is_active)
  VALUES
    ('B.Tech', 'CSE-AIML', 'Computer Science and Engineering (AI & ML)', true),
    ('B.Tech', 'CSE', 'Computer Science and Engineering', true),
    ('B.Tech', 'CSE-DS', 'Computer Science and Engineering (Data Science)', true),
    ('B.Tech', 'CSE-AI', 'Computer Science and Engineering (Artificial Intelligence)', true),
    ('B.Tech', 'CSE-AIDS', 'Computer Science and Engineering (AI & Data Science)', true),
    ('B.Tech', 'CSE-CS', 'Computer Science and Engineering (Cyber Security)', true),
    ('B.Tech', 'CSIT', 'Computer Science and Information Technology', true),
    ('B.Tech', 'ECE', 'Electronics and Communication Engineering', true),
    ('B.Tech', 'CSE-ICB', 'Computer Science and Engineering (IoT & Cyber Security including Blockchain)', true),
    ('B.Tech', 'RAI', 'Robotics and Artificial Intelligence', true),
    ('BBA', 'BBA', 'Bachelor of Business Administration', true),
    ('M.Tech', 'CSE', 'Master of Technology (Computer Science)', true),
    ('M.Tech', 'CSE-AIML', 'Master of Technology (CSE - AI & ML)', true)
  ON CONFLICT (course, branch_code) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        is_active = EXCLUDED.is_active;

  SELECT id INTO v_aiml_id FROM public.academic_branches WHERE course = 'B.Tech' AND branch_code = 'CSE-AIML';
  SELECT id INTO v_cse_id FROM public.academic_branches WHERE course = 'B.Tech' AND branch_code = 'CSE';

  INSERT INTO public.academic_branch_prefixes (prefix, branch_id, admission_year, is_active)
  VALUES ('25MVCSMR', v_aiml_id, 2025, true)
  ON CONFLICT (prefix) DO UPDATE
    SET branch_id = EXCLUDED.branch_id,
        admission_year = EXCLUDED.admission_year,
        is_active = EXCLUDED.is_active;

  INSERT INTO public.academic_branch_prefixes (prefix, branch_id, admission_year, is_active)
  VALUES ('25MVCSER', v_cse_id, 2025, true)
  ON CONFLICT (prefix) DO UPDATE
    SET branch_id = EXCLUDED.branch_id,
        admission_year = EXCLUDED.admission_year,
        is_active = EXCLUDED.is_active;
END $$;

-- 8. RPC: RESOLVE STUDENT BRANCH
CREATE OR REPLACE FUNCTION public.resolve_student_branch(p_roll_number TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_clean_roll TEXT := pg_catalog.upper(pg_catalog.btrim(p_roll_number));
  v_result RECORD;
BEGIN
  IF pg_catalog.length(v_clean_roll) != 12 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'Roll number must be exactly 12 characters');
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
  WHERE pg_catalog.left(v_clean_roll, pg_catalog.length(abp.prefix)) = abp.prefix AND abp.is_active = true
  ORDER BY pg_catalog.length(abp.prefix) DESC, abp.prefix ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'Roll number prefix is not configured in the academic directory'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
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

REVOKE ALL ON FUNCTION public.resolve_student_branch(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_student_branch(TEXT) TO authenticated;

-- 9. RPC: TRUSTED SERVER-SIDE DIRECTORY ACCOUNT SYNCHRONIZATION
CREATE OR REPLACE FUNCTION public.sync_authenticated_student_directory()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile record not found';
  END IF;

  IF v_profile.student_id IS NULL OR pg_catalog.btrim(v_profile.student_id) = '' THEN
    RETURN pg_catalog.jsonb_build_object('linked', false, 'reason', 'No student roll number on profile');
  END IF;

  SELECT * INTO v_dir
  FROM public.student_directory
  WHERE roll_number = pg_catalog.upper(pg_catalog.btrim(v_profile.student_id)) AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('linked', false, 'reason', 'Student roll number not found in active directory');
  END IF;

  IF v_dir.profile_id IS NOT NULL AND v_dir.profile_id != v_user_id THEN
    RAISE EXCEPTION 'Directory record already linked to another account'
      USING HINT = 'Contact campus administration if you believe this is an error.';
  END IF;

  UPDATE public.student_directory
  SET profile_id = v_user_id
  WHERE roll_number = v_dir.roll_number
    AND (profile_id IS NULL OR profile_id = v_user_id);

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated != 1 THEN
    RAISE EXCEPTION 'Directory link failed: expected 1 row updated, got %', v_rows_updated
      USING HINT = 'This may indicate a concurrent claim attempt. Please retry.';
  END IF;

  SELECT * INTO v_branch FROM public.academic_branches WHERE id = v_dir.branch_id;

  PERFORM public.internal_apply_directory_verification(v_user_id, v_dir.branch_id, v_branch.display_name);

  RETURN pg_catalog.jsonb_build_object(
    'linked', true,
    'verified', true,
    'roll_number', v_dir.roll_number,
    'branch_id', v_dir.branch_id,
    'course', v_branch.course,
    'branch_code', v_branch.branch_code,
    'display_name', v_branch.display_name,
    'admission_year', v_dir.admission_year
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_authenticated_student_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_authenticated_student_directory() TO authenticated;

-- 10. RPC: CONTROLLED STUDENT DISCOVERY SEARCH (PRIVACY-PRESERVING & SCOPED)
-- Enforces branch scoping, excludes unverified profiles, requires query length for cross-branch searches.
DROP FUNCTION IF EXISTS public.search_campus_students(TEXT, UUID, INT);

CREATE OR REPLACE FUNCTION public.search_campus_students(
  p_query TEXT DEFAULT '',
  p_branch_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
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
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_role TEXT;
  v_caller_verified BOOLEAN;
  v_caller_branch_id UUID;
  v_effective_branch_id UUID;
  v_sanitized TEXT := pg_catalog.btrim(COALESCE(p_query, ''));
  -- Escape SQL wildcards (%, _, \) to prevent query expansion attacks
  v_escaped TEXT := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(v_sanitized, '\', '\\'), '%', '\%'), '_', '\_');
  -- Measure alphanumeric content length excluding wildcards and spaces
  v_clean_len INT := pg_catalog.length(pg_catalog.regexp_replace(v_sanitized, '[%_\\s\\]', '', 'g'));
  v_effective_limit INT;
  v_effective_offset INT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT p.college_role, p.is_verified, p.branch_id
  INTO v_caller_role, v_caller_verified, v_caller_branch_id
  FROM public.profiles p
  WHERE p.id = v_caller_id;

  -- Only verified members or college administrators can discover campus students
  IF COALESCE(v_caller_role, '') != 'college_admin' AND NOT COALESCE(v_caller_verified, false) THEN
    RAISE EXCEPTION 'Access restricted: Only verified students or college administrators can search student directory';
  END IF;

  -- Branch scoping rules:
  IF COALESCE(v_caller_role, '') = 'college_admin' THEN
    v_effective_branch_id := p_branch_id;
  ELSE
    -- For ordinary students:
    IF p_branch_id IS NULL THEN
      -- Default to caller's verified branch if non-wildcard query is short
      IF v_clean_len < 3 THEN
        v_effective_branch_id := v_caller_branch_id;
      ELSE
        -- If query >= 3 non-wildcard characters, allow targeted cross-college discovery
        v_effective_branch_id := NULL;
      END IF;
    ELSIF p_branch_id = v_caller_branch_id THEN
      v_effective_branch_id := v_caller_branch_id;
    ELSE
      -- Specific other branch selected: require non-wildcard query length >= 3 to prevent broad enumeration
      IF v_clean_len < 3 THEN
        RAISE EXCEPTION 'Cross-branch search requires at least 3 search characters';
      END IF;
      v_effective_branch_id := p_branch_id;
    END IF;
  END IF;

  -- Bound limit and offset to prevent unbounded database scraping
  v_effective_limit := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_effective_offset := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 200);

  RETURN QUERY
  SELECT 
    p.id,
    p.username,
    p.avatar_url,
    p.department,
    -- Mask roll number: show only last 4 characters for privacy
    CASE
      WHEN p.student_id IS NOT NULL AND pg_catalog.length(p.student_id) > 4
        THEN pg_catalog.repeat('*', pg_catalog.length(p.student_id) - 4) || pg_catalog.right(p.student_id, 4)
      ELSE p.student_id
    END AS student_id,
    p.branch_id,
    ab.course,
    ab.branch_code
  FROM public.profiles p
  LEFT JOIN public.academic_branches ab ON ab.id = p.branch_id
  WHERE p.is_verified = true
    AND p.college_role = 'student'
    AND (
      v_sanitized = '' OR
      p.username ILIKE ('%' || v_escaped || '%') ESCAPE '\' OR
      p.student_id ILIKE ('%' || v_escaped || '%') ESCAPE '\' OR
      p.department ILIKE ('%' || v_escaped || '%') ESCAPE '\'
    )
    AND (v_effective_branch_id IS NULL OR p.branch_id = v_effective_branch_id)
  ORDER BY p.username ASC
  LIMIT v_effective_limit
  OFFSET v_effective_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.search_campus_students(TEXT, UUID, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_campus_students(TEXT, UUID, INT, INT) TO authenticated;

-- 10.B. RPC: GET CLUB MEMBER STATS (AGGREGATE WITHOUT EXPOSING FULL ROSTERS)
CREATE OR REPLACE FUNCTION public.get_club_member_stats(p_club_ids UUID[])
RETURNS TABLE (
  club_id UUID,
  member_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    cm.club_id,
    pg_catalog.count(*)::BIGINT AS member_count
  FROM public.club_memberships cm
  WHERE cm.club_id = ANY(p_club_ids)
    AND cm.status = 'active'
  GROUP BY cm.club_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_club_member_stats(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_club_member_stats(UUID[]) TO authenticated;

-- 11. STRICT ROW LEVEL SECURITY FOR REGISTRIES
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

-- 12. DATABASE-LEVEL CONTENT AUDIENCE AND VISIBILITY RLS POLICIES
DROP POLICY IF EXISTS "Anyone can view posts" ON public.posts;
DROP POLICY IF EXISTS "Authenticated users view posts" ON public.posts;
DROP POLICY IF EXISTS "Audience can view posts" ON public.posts;
CREATE POLICY "Audience can view posts" ON public.posts
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin') OR
    content_visibility = 'college' OR
    (content_visibility = 'branch' AND branch_id IS NOT NULL AND branch_id = (SELECT p.branch_id FROM public.profiles p WHERE p.id = auth.uid()))
  );

DROP POLICY IF EXISTS "View published events or club organizers" ON public.events;
DROP POLICY IF EXISTS "View published events or organizer drafts" ON public.events;
DROP POLICY IF EXISTS "Audience can view events" ON public.events;
CREATE POLICY "Audience can view events" ON public.events
  FOR SELECT TO authenticated
  USING (
    created_by = auth.uid() OR
    public.is_club_organizer_or_admin(club_id, auth.uid()) OR
    (is_published = true AND (
      content_visibility = 'college' OR
      (content_visibility = 'branch' AND branch_id IS NOT NULL AND branch_id = (SELECT p.branch_id FROM public.profiles p WHERE p.id = auth.uid())) OR
      (content_visibility = 'club_members' AND EXISTS (
        SELECT 1 FROM public.club_memberships cm WHERE cm.club_id = events.club_id AND cm.user_id = auth.uid() AND cm.status = 'active'
      ))
    ))
  );

DROP POLICY IF EXISTS "View active clubs or own proposals" ON public.clubs;
DROP POLICY IF EXISTS "View active clubs or own pending clubs" ON public.clubs;
DROP POLICY IF EXISTS "Audience can view clubs" ON public.clubs;
CREATE POLICY "Audience can view clubs" ON public.clubs
  FOR SELECT TO authenticated
  USING (
    created_by = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin') OR
    (status = 'active' AND (
      content_visibility = 'college' OR
      (content_visibility = 'branch' AND branch_id IS NOT NULL AND branch_id = (SELECT p.branch_id FROM public.profiles p WHERE p.id = auth.uid())) OR
      EXISTS (
        SELECT 1 FROM public.club_memberships cm WHERE cm.club_id = clubs.id AND cm.user_id = auth.uid() AND cm.status = 'active'
      )
    ))
  );

-- D. CLUB CHANNELS AUDIENCE POLICY
DROP POLICY IF EXISTS "Active members view channels" ON public.club_channels;
DROP POLICY IF EXISTS "Audience can view channels" ON public.club_channels;
CREATE POLICY "Audience can view channels" ON public.club_channels
  FOR SELECT TO authenticated
  USING (
    type = 'announcements' OR
    EXISTS (
      SELECT 1 FROM public.club_memberships cm
      WHERE cm.club_id = club_channels.club_id AND cm.user_id = auth.uid() AND cm.status = 'active'
    ) OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
  );

-- E. CHANNEL MESSAGES AUDIENCE POLICY (ANNOUNCEMENTS & DISCUSSIONS)
DROP POLICY IF EXISTS "Active members view messages" ON public.channel_messages;
DROP POLICY IF EXISTS "Active members view channel messages" ON public.channel_messages;
DROP POLICY IF EXISTS "Audience can view channel messages" ON public.channel_messages;
CREATE POLICY "Audience can view channel messages" ON public.channel_messages
  FOR SELECT TO authenticated
  USING (
    sender_id = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin') OR
    EXISTS (
      SELECT 1 FROM public.club_channels cc
      JOIN public.club_memberships cm ON cm.club_id = cc.club_id
      WHERE cc.id = channel_messages.channel_id AND cm.user_id = auth.uid() AND cm.status = 'active'
    ) OR
    (EXISTS (
      SELECT 1 FROM public.club_channels cc
      WHERE cc.id = channel_messages.channel_id AND cc.type = 'announcements'
    ) AND (
      content_visibility = 'college' OR
      (content_visibility = 'branch' AND branch_id IS NOT NULL AND branch_id = (SELECT p.branch_id FROM public.profiles p WHERE p.id = auth.uid()))
    ))
  );

-- 13. ENFORCE AUTHOR/CREATOR BRANCH OWNERSHIP ON CONTENT (ANTI-SPOOFING)
-- Strictly derives branch_id from verified user profile. Non-admins cannot supply mismatched branch or reassign branch on update.

CREATE OR REPLACE FUNCTION public.enforce_post_branch_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_is_admin BOOLEAN := false;
  v_author_branch_id UUID;
BEGIN
  IF v_caller_id IS NOT NULL THEN
    SELECT (college_role = 'college_admin') INTO v_is_admin
    FROM public.profiles
    WHERE id = v_caller_id;
  END IF;

  IF COALESCE(v_is_admin, false) THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_author_branch_id
  FROM public.profiles
  WHERE id = NEW.user_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_author_branch_id THEN
      RAISE EXCEPTION 'Unauthorized: Supplied branch_id does not match author verified branch';
    END IF;
    NEW.branch_id := v_author_branch_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
      RAISE EXCEPTION 'Unauthorized: branch_id on posts cannot be modified by non-administrators';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_post_branch_ownership ON public.posts;
DROP TRIGGER IF EXISTS trg_auto_set_post_branch ON public.posts;
CREATE TRIGGER trg_enforce_post_branch_ownership
  BEFORE INSERT OR UPDATE ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_post_branch_ownership();

REVOKE ALL ON FUNCTION public.enforce_post_branch_ownership() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_event_branch_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_is_admin BOOLEAN := false;
  v_creator_branch_id UUID;
BEGIN
  IF v_caller_id IS NOT NULL THEN
    SELECT (college_role = 'college_admin') INTO v_is_admin
    FROM public.profiles
    WHERE id = v_caller_id;
  END IF;

  IF COALESCE(v_is_admin, false) THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_creator_branch_id
  FROM public.profiles
  WHERE id = NEW.created_by;

  IF TG_OP = 'INSERT' THEN
    IF NEW.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_creator_branch_id THEN
      RAISE EXCEPTION 'Unauthorized: Supplied branch_id does not match creator verified branch';
    END IF;
    NEW.branch_id := v_creator_branch_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
      RAISE EXCEPTION 'Unauthorized: branch_id on events cannot be modified by non-administrators';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_event_branch_ownership ON public.events;
DROP TRIGGER IF EXISTS trg_auto_set_event_branch ON public.events;
CREATE TRIGGER trg_enforce_event_branch_ownership
  BEFORE INSERT OR UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_event_branch_ownership();

REVOKE ALL ON FUNCTION public.enforce_event_branch_ownership() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_club_branch_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_is_admin BOOLEAN := false;
  v_creator_branch_id UUID;
BEGIN
  IF v_caller_id IS NOT NULL THEN
    SELECT (college_role = 'college_admin') INTO v_is_admin
    FROM public.profiles
    WHERE id = v_caller_id;
  END IF;

  IF COALESCE(v_is_admin, false) THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_creator_branch_id
  FROM public.profiles
  WHERE id = NEW.created_by;

  IF TG_OP = 'INSERT' THEN
    IF NEW.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_creator_branch_id THEN
      RAISE EXCEPTION 'Unauthorized: Supplied branch_id does not match creator verified branch';
    END IF;
    NEW.branch_id := v_creator_branch_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
      RAISE EXCEPTION 'Unauthorized: branch_id on clubs cannot be modified by non-administrators';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_club_branch_ownership ON public.clubs;
DROP TRIGGER IF EXISTS trg_auto_set_club_branch ON public.clubs;
CREATE TRIGGER trg_enforce_club_branch_ownership
  BEFORE INSERT OR UPDATE ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_club_branch_ownership();

REVOKE ALL ON FUNCTION public.enforce_club_branch_ownership() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_message_branch_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_is_admin BOOLEAN := false;
  v_sender_branch_id UUID;
BEGIN
  IF v_caller_id IS NOT NULL THEN
    SELECT (college_role = 'college_admin') INTO v_is_admin
    FROM public.profiles
    WHERE id = v_caller_id;
  END IF;

  IF COALESCE(v_is_admin, false) THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_sender_branch_id
  FROM public.profiles
  WHERE id = NEW.sender_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_sender_branch_id THEN
      RAISE EXCEPTION 'Unauthorized: Supplied branch_id does not match sender verified branch';
    END IF;
    NEW.branch_id := v_sender_branch_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
      RAISE EXCEPTION 'Unauthorized: branch_id on messages cannot be modified by non-administrators';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_message_branch_ownership ON public.channel_messages;
DROP TRIGGER IF EXISTS trg_auto_set_message_branch ON public.channel_messages;
CREATE TRIGGER trg_enforce_message_branch_ownership
  BEFORE INSERT OR UPDATE ON public.channel_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_message_branch_ownership();

REVOKE ALL ON FUNCTION public.enforce_message_branch_ownership() FROM PUBLIC;

-- 14. COMPREHENSIVE BACKFILL: ENFORCE VERIFIED ENROLLMENT AGAINST STUDENT DIRECTORY
-- Profiles without an active directory record remain unverified and branchless.
DO $$
DECLARE
  v_rec RECORD;
BEGIN
  -- A. Backfill profiles ONLY when an exact active directory entry exists
  FOR v_rec IN 
    SELECT p.id, sd.roll_number, sd.branch_id, ab.display_name
    FROM public.profiles p
    JOIN public.student_directory sd
      ON sd.roll_number = pg_catalog.upper(pg_catalog.btrim(p.student_id))
     AND sd.is_active = true
     AND (sd.profile_id IS NULL OR sd.profile_id = p.id)
    JOIN public.academic_branches ab ON ab.id = sd.branch_id
    WHERE p.student_id IS NOT NULL 
      AND pg_catalog.btrim(p.student_id) != ''
      AND p.branch_id IS NULL
  LOOP
    -- Claim directory entry
    UPDATE public.student_directory
    SET profile_id = v_rec.id
    WHERE roll_number = v_rec.roll_number;

    -- Update profile verified status via dedicated internal updater
    PERFORM public.internal_apply_directory_verification(v_rec.id, v_rec.branch_id, v_rec.display_name);
  END LOOP;
END $$;

-- B. Backfill posts from verified author profiles
UPDATE public.posts p
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE p.user_id = pr.id
  AND p.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;

-- C. Backfill events from verified creator profiles
UPDATE public.events e
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE e.created_by = pr.id
  AND e.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;

-- D. Backfill clubs from verified creator profiles
UPDATE public.clubs c
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE c.created_by = pr.id
  AND c.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;

-- E. Backfill channel messages from verified sender profiles
UPDATE public.channel_messages m
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE m.sender_id = pr.id
  AND m.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;

-- F. Administrative Review View for unlinked or unverified student profiles
CREATE OR REPLACE VIEW public.unverified_students_needing_review AS
SELECT 
  p.id AS profile_id,
  p.username,
  p.student_id,
  p.created_at,
  CASE
    WHEN p.student_id IS NULL OR pg_catalog.btrim(p.student_id) = '' THEN 'missing_student_id'
    WHEN NOT EXISTS (SELECT 1 FROM public.student_directory sd WHERE sd.roll_number = pg_catalog.upper(pg_catalog.btrim(p.student_id))) THEN 'not_in_student_directory'
    WHEN EXISTS (SELECT 1 FROM public.student_directory sd WHERE sd.roll_number = pg_catalog.upper(pg_catalog.btrim(p.student_id)) AND sd.is_active = false) THEN 'directory_entry_inactive'
    WHEN EXISTS (SELECT 1 FROM public.student_directory sd WHERE sd.roll_number = pg_catalog.upper(pg_catalog.btrim(p.student_id)) AND sd.profile_id IS NOT NULL AND sd.profile_id != p.id) THEN 'directory_claimed_by_other_profile'
    ELSE 'pending_claim'
  END AS review_reason
FROM public.profiles p
WHERE p.college_role = 'student'
  AND (p.is_verified = false OR p.branch_id IS NULL);

GRANT SELECT ON public.unverified_students_needing_review TO authenticated;

-- G. Reconciliation & Audit Function for Student Directory Records
-- Reconciles all student directory rows against official configured branch prefixes
CREATE OR REPLACE FUNCTION public.audit_student_directory_integrity()
RETURNS TABLE(
  roll_number TEXT,
  branch_id UUID,
  admission_year INT,
  issue TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    sd.roll_number,
    sd.branch_id,
    sd.admission_year,
    CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM public.academic_branch_prefixes abp
        WHERE pg_catalog.left(sd.roll_number, pg_catalog.length(abp.prefix)) = abp.prefix
      ) THEN 'unknown_prefix'
      WHEN EXISTS (
        SELECT 1 FROM public.academic_branch_prefixes abp
        WHERE pg_catalog.left(sd.roll_number, pg_catalog.length(abp.prefix)) = abp.prefix
          AND (abp.branch_id != sd.branch_id OR abp.admission_year != sd.admission_year)
      ) THEN 'prefix_mismatch_with_branch_or_year'
      WHEN pg_catalog.length(sd.roll_number) != 12 THEN 'invalid_roll_length'
      ELSE 'valid'
    END AS issue
  FROM public.student_directory sd
  WHERE NOT EXISTS (
    SELECT 1 FROM public.academic_branch_prefixes abp
    WHERE pg_catalog.left(sd.roll_number, pg_catalog.length(abp.prefix)) = abp.prefix
      AND abp.branch_id = sd.branch_id
      AND abp.admission_year = sd.admission_year
      AND abp.is_active = true
  ) OR pg_catalog.length(sd.roll_number) != 12;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_student_directory_integrity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_student_directory_integrity() TO authenticated;

-- Ensure enforce_club_membership_defaults safely accommodates service role and administrative test fixtures
CREATE OR REPLACE FUNCTION public.enforce_club_membership_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_role TEXT;
BEGIN
  IF auth.uid() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();

  IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
    NEW.user_id := auth.uid();
    NEW.role := 'member';
    NEW.status := 'pending';
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- PROFILE FALLBACK RPC, MY_PROFILE VIEW & ACTIVATION SECURITY
-- =============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS activation_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.get_my_profile_fallback()
RETURNS TABLE (
  id UUID,
  username TEXT,
  student_id TEXT,
  college_role TEXT,
  is_verified BOOLEAN,
  must_change_password BOOLEAN,
  department TEXT,
  year TEXT,
  branch_id UUID,
  bio TEXT,
  avatar_url TEXT,
  activation_expires_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT 
    p.id,
    p.username,
    p.student_id,
    p.college_role,
    p.is_verified,
    p.must_change_password,
    p.department,
    p.year,
    p.branch_id,
    p.bio,
    p.avatar_url,
    p.activation_expires_at,
    p.activated_at,
    p.created_at,
    p.updated_at
  FROM public.profiles p
  WHERE p.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_my_profile_fallback() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_profile_fallback() TO authenticated;

CREATE OR REPLACE VIEW public.my_profile AS
SELECT 
  p.id,
  p.username,
  p.student_id,
  p.college_role,
  p.is_verified,
  p.must_change_password,
  p.department,
  p.year,
  p.branch_id,
  p.bio,
  p.avatar_url,
  p.activation_expires_at,
  p.activated_at,
  p.created_at,
  p.updated_at
FROM public.profiles p
WHERE p.id = auth.uid();

REVOKE ALL ON public.my_profile FROM PUBLIC, anon;
GRANT SELECT ON public.my_profile TO authenticated;

CREATE TABLE IF NOT EXISTS public.auth_login_audit (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  identifier TEXT NOT NULL,
  attempt_time TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  success BOOLEAN NOT NULL,
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_login_audit_identifier_time 
  ON public.auth_login_audit(identifier, attempt_time DESC);

ALTER TABLE public.auth_login_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_login_audit FROM PUBLIC, anon;
GRANT ALL ON public.auth_login_audit TO postgres;

CREATE OR REPLACE FUNCTION public.audit_login_attempt(
  p_identifier TEXT,
  p_success BOOLEAN,
  p_failure_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.auth_login_audit (identifier, attempt_time, success, failure_reason)
  VALUES (
    pg_catalog.lower(pg_catalog.btrim(p_identifier)),
    pg_catalog.clock_timestamp(),
    p_success,
    p_failure_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.audit_login_attempt(TEXT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_login_attempt(TEXT, BOOLEAN, TEXT) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.check_login_rate_limit(
  p_identifier TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  v_recent_failures INT;
BEGIN
  SELECT count(*) INTO v_recent_failures
  FROM public.auth_login_audit
  WHERE identifier = pg_catalog.lower(pg_catalog.btrim(p_identifier))
    AND success = false
    AND attempt_time > pg_catalog.clock_timestamp() - interval '15 minutes';
  
  RETURN (v_recent_failures < 5);
END;
$$;

REVOKE ALL ON FUNCTION public.check_login_rate_limit(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_login_rate_limit(TEXT) TO authenticated, anon;




