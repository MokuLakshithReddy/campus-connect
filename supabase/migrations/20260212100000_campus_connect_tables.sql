-- ============================================================================
-- CAMPUSCONNECT CORE TABLES EXTENSION
-- Adds campus identity attributes, clubs, channels, events, and notifications
-- ============================================================================

-- 1. EXTEND PROFILES FOR CAMPUS IDENTITY
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS year TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS student_id TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS college_role TEXT NOT NULL DEFAULT 'student' CHECK (college_role IN ('student', 'faculty', 'college_admin'));
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true;

-- 2. CLUBS TABLE
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

-- 3. CLUB MEMBERSHIPS TABLE
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

-- 4. CLUB CHANNELS TABLE
CREATE TABLE IF NOT EXISTS public.club_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general' CHECK (type IN ('announcements', 'general', 'project', 'events')),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (club_id, name)
);

-- 5. CHANNEL MESSAGES TABLE
CREATE TABLE IF NOT EXISTS public.channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES public.club_channels(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  attachments JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6. EVENTS TABLE
CREATE TABLE IF NOT EXISTS public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  cover_url TEXT,
  venue TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  capacity INT NOT NULL CHECK (capacity > 0),
  is_published BOOLEAN DEFAULT true,
  registered_count INT DEFAULT 0,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CHECK (end_time > start_time)
);

-- 7. EVENT REGISTRATIONS TABLE
CREATE TABLE IF NOT EXISTS public.event_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'attended', 'cancelled')),
  qr_code_token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  registered_at TIMESTAMPTZ DEFAULT now(),
  attended_at TIMESTAMPTZ,
  UNIQUE (event_id, user_id)
);

-- 8. NOTIFICATIONS TABLE
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('membership_requested', 'membership_approved', 'announcement', 'event_reminder', 'broadcast', 'system')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_profiles_student_id ON public.profiles(student_id);
CREATE INDEX IF NOT EXISTS idx_clubs_slug ON public.clubs(slug);
CREATE INDEX IF NOT EXISTS idx_clubs_category ON public.clubs(category);
CREATE INDEX IF NOT EXISTS idx_club_memberships_club_user ON public.club_memberships(club_id, user_id);
CREATE INDEX IF NOT EXISTS idx_club_memberships_user_status ON public.club_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS idx_club_channels_club ON public.club_channels(club_id);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created ON public.channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_club_start ON public.events(club_id, start_time);
CREATE INDEX IF NOT EXISTS idx_events_start_time ON public.events(start_time);
CREATE INDEX IF NOT EXISTS idx_event_reg_user ON public.event_registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_event_reg_qr ON public.event_registrations(qr_code_token);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON public.notifications(user_id, is_read, created_at DESC);

-- 10. REALTIME PUBLICATION
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.channel_messages;
  EXCEPTION WHEN duplicate_object THEN END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  EXCEPTION WHEN duplicate_object THEN END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.club_memberships;
  EXCEPTION WHEN duplicate_object THEN END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.event_registrations;
  EXCEPTION WHEN duplicate_object THEN END;
END $$;
