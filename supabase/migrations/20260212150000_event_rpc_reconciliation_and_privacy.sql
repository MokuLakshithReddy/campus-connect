-- ============================================================================
-- MIGRATION: 20260212150000_event_rpc_reconciliation_and_privacy.sql
-- Description:
-- 1. Canonical implementations for get_event_registration_stats and check_in_event_attendee
-- 2. SECURITY DEFINER hardening (search_path = public, pg_temp & explicit grants)
-- 3. Campus-Only Privacy boundary: Restrict anon table grants and RLS policies
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CANONICAL RPC: get_event_registration_stats
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 2. CANONICAL RPC: check_in_event_attendee
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_in_event_attendee(p_event_id UUID, p_qr_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_event RECORD;
  v_is_authorized BOOLEAN;
  v_reg RECORD;
  v_attendee_name TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT ev.id, ev.club_id, ev.title INTO v_event
  FROM public.events ev
  WHERE ev.id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  -- Verify caller is club organizer, president, or college administrator
  SELECT EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = v_event.club_id 
      AND user_id = v_caller_id 
      AND role IN ('president', 'organizer') 
      AND status = 'active'
    UNION
    SELECT 1 FROM public.profiles
    WHERE id = v_caller_id AND college_role = 'college_admin'
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Unauthorized: Only event organizers or college administrators can scan tickets';
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

  IF v_reg.checked_in_at IS NOT NULL OR v_reg.status = 'attended' THEN
    RAISE EXCEPTION 'Attendee already checked in at %', COALESCE(v_reg.checked_in_at, v_reg.updated_at);
  END IF;

  UPDATE public.event_registrations
  SET checked_in_at = NOW(), status = 'attended', updated_at = NOW()
  WHERE id = v_reg.id;

  SELECT username INTO v_attendee_name FROM public.profiles WHERE id = v_reg.user_id;

  RETURN jsonb_build_object(
    'success', true,
    'attendee_name', COALESCE(v_attendee_name, 'Student Attendee'),
    'checked_in_at', NOW()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_in_event_attendee(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_in_event_attendee(UUID, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. COMPATIBILITY WRAPPER: verify_event_ticket
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_event_ticket(p_qr_code_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg RECORD;
BEGIN
  SELECT event_id INTO v_reg
  FROM public.event_registrations
  WHERE qr_code_token = p_qr_code_token;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'error', 'Invalid ticket token');
  END IF;

  RETURN public.check_in_event_attendee(v_reg.event_id, p_qr_code_token);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('valid', false, 'error', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.verify_event_ticket(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_event_ticket(TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. HARDEN SEARCH PATH AND EXECUTION GRANTS FOR ALL SECURITY DEFINER FUNCTIONS
-- ----------------------------------------------------------------------------
ALTER FUNCTION public.register_for_event(UUID) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.register_for_event(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_for_event(UUID) TO authenticated;

ALTER FUNCTION public.cancel_event_registration(UUID) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.cancel_event_registration(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_event_registration(UUID) TO authenticated;

ALTER FUNCTION public.approve_club_membership(UUID) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.approve_club_membership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_club_membership(UUID) TO authenticated;

ALTER FUNCTION public.reject_club_membership(UUID) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.reject_club_membership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_club_membership(UUID) TO authenticated;

ALTER FUNCTION public.appoint_club_organizer(UUID) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.appoint_club_organizer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.appoint_club_organizer(UUID) TO authenticated;

-- Verify student account definition (Admin only)
CREATE OR REPLACE FUNCTION public.verify_student_account(p_user_id UUID, p_is_verified BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;

REVOKE EXECUTE ON FUNCTION public.verify_student_account(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_student_account(UUID, BOOLEAN) TO authenticated;

-- First-time password change RPC definition
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

-- ----------------------------------------------------------------------------
-- 5. CAMPUS-ONLY PRIVACY BOUNDARY (RESTRICT UNRESTRICTED ANON ACCESS)
-- ----------------------------------------------------------------------------

-- Revoke anonymous access to private student & campus community data
REVOKE SELECT ON public.profiles FROM anon;
REVOKE SELECT ON public.posts FROM anon;
REVOKE SELECT ON public.likes FROM anon;
REVOKE SELECT ON public.comments FROM anon;
REVOKE SELECT ON public.followers FROM anon;
REVOKE SELECT ON public.events FROM anon;
REVOKE SELECT ON public.event_registrations FROM anon;
REVOKE SELECT ON public.clubs FROM anon;
REVOKE SELECT ON public.club_memberships FROM anon;
REVOKE SELECT ON public.messages FROM anon;
REVOKE SELECT ON public.conversations FROM anon;
REVOKE SELECT ON public.notifications FROM anon;

-- Ensure authenticated campus accounts have explicit query privileges
GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT ON public.posts TO authenticated;
GRANT SELECT ON public.likes TO authenticated;
GRANT SELECT ON public.comments TO authenticated;
GRANT SELECT ON public.followers TO authenticated;
GRANT SELECT ON public.events TO authenticated;
GRANT SELECT ON public.clubs TO authenticated;
GRANT SELECT ON public.club_memberships TO authenticated;

-- Tighten RLS policies to authenticated users only
DROP POLICY IF EXISTS "Anyone can view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users view profiles" ON public.profiles;
CREATE POLICY "Authenticated users view profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Posts are viewable by everyone" ON public.posts;
DROP POLICY IF EXISTS "Posts are viewable by authenticated users" ON public.posts;
CREATE POLICY "Posts are viewable by authenticated users" ON public.posts
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Likes are viewable by everyone" ON public.likes;
DROP POLICY IF EXISTS "Likes are viewable by authenticated users" ON public.likes;
CREATE POLICY "Likes are viewable by authenticated users" ON public.likes
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Comments are viewable by everyone" ON public.comments;
DROP POLICY IF EXISTS "Comments are viewable by authenticated users" ON public.comments;
CREATE POLICY "Comments are viewable by authenticated users" ON public.comments
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Anyone can view followers" ON public.followers;
DROP POLICY IF EXISTS "Followers are viewable by everyone" ON public.followers;
DROP POLICY IF EXISTS "Followers are viewable by authenticated users" ON public.followers;
CREATE POLICY "Followers are viewable by authenticated users" ON public.followers
  FOR SELECT TO authenticated
  USING (true);
