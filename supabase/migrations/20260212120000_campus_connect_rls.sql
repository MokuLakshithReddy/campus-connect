-- ============================================================================
-- CAMPUSCONNECT ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

-- 1. ENABLE RLS ON ALL TABLES
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- 2. HELPER FUNCTIONS FOR RLS (SECURITY DEFINER STABLE)
CREATE OR REPLACE FUNCTION public.is_college_admin(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_user_id AND college_role = 'college_admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.is_college_admin(UUID) TO authenticated, anon, service_role, public;

CREATE OR REPLACE FUNCTION public.is_club_organizer_or_admin(p_club_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF public.is_college_admin(p_user_id) THEN
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

  IF public.is_college_admin(p_user_id) THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 3. PROFILES POLICIES
DROP POLICY IF EXISTS "Anyone can view profiles" ON public.profiles;
CREATE POLICY "Anyone can view profiles" ON public.profiles
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

GRANT INSERT ON public.profiles TO authenticated;

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Admins manage all profiles" ON public.profiles;
CREATE POLICY "Admins manage all profiles" ON public.profiles
  FOR ALL TO authenticated
  USING (public.is_college_admin(auth.uid()))
  WITH CHECK (public.is_college_admin(auth.uid()));

-- 4. CLUBS POLICIES
DROP POLICY IF EXISTS "View active clubs or own proposals" ON public.clubs;
CREATE POLICY "View active clubs or own proposals" ON public.clubs
  FOR SELECT USING (
    status = 'active' OR
    created_by = auth.uid() OR
    public.is_college_admin(auth.uid())
  );

DROP POLICY IF EXISTS "Auth users submit club proposal" ON public.clubs;
CREATE POLICY "Auth users submit club proposal" ON public.clubs
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = created_by);

DROP POLICY IF EXISTS "Organizers or admins update club" ON public.clubs;
CREATE POLICY "Organizers or admins update club" ON public.clubs
  FOR UPDATE TO authenticated
  USING (
    public.is_club_organizer_or_admin(id, auth.uid())
  );

DROP POLICY IF EXISTS "Admins delete clubs" ON public.clubs;
CREATE POLICY "Admins delete clubs" ON public.clubs
  FOR DELETE TO authenticated
  USING (
    public.is_college_admin(auth.uid())
  );

-- 5. CLUB MEMBERSHIPS POLICIES
DROP POLICY IF EXISTS "View active memberships or own request" ON public.club_memberships;
CREATE POLICY "View active memberships or own request" ON public.club_memberships
  FOR SELECT TO authenticated
  USING (
    status = 'active' OR
    user_id = auth.uid() OR
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

DROP POLICY IF EXISTS "Request club membership" ON public.club_memberships;
CREATE POLICY "Request club membership" ON public.club_memberships
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id AND
    role = 'member' AND
    status = 'pending'
  );

DROP POLICY IF EXISTS "Admins insert membership" ON public.club_memberships;
CREATE POLICY "Admins insert membership" ON public.club_memberships
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_college_admin(auth.uid())
  );

DROP POLICY IF EXISTS "Organizers or admins update membership" ON public.club_memberships;
CREATE POLICY "Organizers or admins update membership" ON public.club_memberships
  FOR UPDATE TO authenticated
  USING (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

DROP POLICY IF EXISTS "Leave club or remove membership" ON public.club_memberships;
CREATE POLICY "Leave club or remove membership" ON public.club_memberships
  FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id OR
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

-- 6. CLUB CHANNELS POLICIES
DROP POLICY IF EXISTS "Active members view channels" ON public.club_channels;
CREATE POLICY "Active members view channels" ON public.club_channels
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_memberships cm
      WHERE cm.club_id = club_channels.club_id AND cm.user_id = auth.uid() AND cm.status = 'active'
    ) OR
    public.is_college_admin(auth.uid())
  );

DROP POLICY IF EXISTS "Organizers create channels" ON public.club_channels;
CREATE POLICY "Organizers create channels" ON public.club_channels
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

DROP POLICY IF EXISTS "Organizers update channels" ON public.club_channels;
CREATE POLICY "Organizers update channels" ON public.club_channels
  FOR UPDATE TO authenticated
  USING (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

DROP POLICY IF EXISTS "Organizers delete channels" ON public.club_channels;
CREATE POLICY "Organizers delete channels" ON public.club_channels
  FOR DELETE TO authenticated
  USING (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

-- 7. CHANNEL MESSAGES POLICIES
DROP POLICY IF EXISTS "Active members view messages" ON public.channel_messages;
CREATE POLICY "Active members view messages" ON public.channel_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.club_channels cc
      JOIN public.club_memberships cm ON cm.club_id = cc.club_id
      WHERE cc.id = channel_messages.channel_id AND cm.user_id = auth.uid() AND cm.status = 'active'
    ) OR
    public.is_college_admin(auth.uid())
  );

DROP POLICY IF EXISTS "Active members send messages" ON public.channel_messages;
CREATE POLICY "Active members send messages" ON public.channel_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id AND
    (
      EXISTS (
        SELECT 1 FROM public.club_channels cc
        JOIN public.club_memberships cm ON cm.club_id = cc.club_id
        WHERE cc.id = channel_messages.channel_id AND cm.user_id = auth.uid() AND cm.status = 'active'
        AND (cc.type != 'announcements' OR cm.role IN ('president', 'organizer'))
      ) OR
      public.is_college_admin(auth.uid())
    )
  );

DROP POLICY IF EXISTS "Sender update own message" ON public.channel_messages;
CREATE POLICY "Sender update own message" ON public.channel_messages
  FOR UPDATE TO authenticated
  USING (auth.uid() = sender_id);

DROP POLICY IF EXISTS "Sender or organizer delete message" ON public.channel_messages;
CREATE POLICY "Sender or organizer delete message" ON public.channel_messages
  FOR DELETE TO authenticated
  USING (
    auth.uid() = sender_id OR
    EXISTS (
      SELECT 1 FROM public.club_channels cc
      WHERE cc.id = channel_messages.channel_id AND public.is_club_organizer_or_admin(cc.club_id, auth.uid())
    )
  );

-- 8. EVENTS POLICIES
DROP POLICY IF EXISTS "View published events or club organizers" ON public.events;
CREATE POLICY "View published events or club organizers" ON public.events
  FOR SELECT USING (
    is_published = true OR
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

DROP POLICY IF EXISTS "Club organizers create events" ON public.events;
CREATE POLICY "Club organizers create events" ON public.events
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = created_by AND
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

DROP POLICY IF EXISTS "Club organizers update events" ON public.events;
CREATE POLICY "Club organizers update events" ON public.events
  FOR UPDATE TO authenticated
  USING (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

DROP POLICY IF EXISTS "Club organizers delete events" ON public.events;
CREATE POLICY "Club organizers delete events" ON public.events
  FOR DELETE TO authenticated
  USING (
    public.is_club_organizer_or_admin(club_id, auth.uid())
  );

-- 9. EVENT REGISTRATIONS POLICIES
DROP POLICY IF EXISTS "View own registration or organizers view all" ON public.event_registrations;
CREATE POLICY "View own registration or organizers view all" ON public.event_registrations
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM public.events e
      WHERE e.id = event_registrations.event_id AND public.is_club_organizer_or_admin(e.club_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS "Register for event" ON public.event_registrations;
CREATE POLICY "Register for event" ON public.event_registrations
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Update own registration or organizers manage" ON public.event_registrations;
CREATE POLICY "Update own registration or organizers manage" ON public.event_registrations
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM public.events e
      WHERE e.id = event_registrations.event_id AND public.is_club_organizer_or_admin(e.club_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS "Cancel registration" ON public.event_registrations;
CREATE POLICY "Cancel registration" ON public.event_registrations
  FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM public.events e
      WHERE e.id = event_registrations.event_id AND public.is_club_organizer_or_admin(e.club_id, auth.uid())
    )
  );

-- 10. NOTIFICATIONS POLICIES
DROP POLICY IF EXISTS "Users view own notifications" ON public.notifications;
CREATE POLICY "Users view own notifications" ON public.notifications
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own notifications" ON public.notifications;
CREATE POLICY "Users update own notifications" ON public.notifications
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Authorized system inserts notifications" ON public.notifications;
DROP POLICY IF EXISTS "Admins insert notifications" ON public.notifications;
CREATE POLICY "Admins insert notifications" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_college_admin(auth.uid())
  );
