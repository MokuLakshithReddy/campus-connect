-- ============================================================================
-- CAMPUSCONNECT SECURITY TRIGGERS AND SECURE STORED PROCEDURES (RPCs)
-- ============================================================================

-- 1. HARDENED PROFILE PROVISIONING TRIGGER (ON AUTH SIGNUP)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- SECURITY ENFORCEMENT:
  -- college_role ALWAYS defaults to 'student'
  -- is_verified ALWAYS defaults to false
  -- must_change_password ALWAYS defaults to true
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

-- 2. PROFILE PRIVILEGE PROTECTION (BEFORE INSERT OR UPDATE)
CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS TRIGGER AS $$
DECLARE
  caller_role TEXT;
BEGIN
  IF auth.role() = 'service_role' OR auth.role() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT college_role INTO caller_role
  FROM public.profiles
  WHERE id = auth.uid();

  IF TG_OP = 'INSERT' THEN
    IF caller_role IS DISTINCT FROM 'college_admin' THEN
      NEW.college_role := 'student';
      NEW.is_verified := false;
      NEW.must_change_password := true;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
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

-- 3. PASSWORD CHANGE COMPLETION TRIGGER (ON AUTH.USERS)
CREATE OR REPLACE FUNCTION public.handle_auth_user_password_changed()
RETURNS TRIGGER AS $$
BEGIN
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

-- 4. CLUB MEMBERSHIP PRIVILEGE PROTECTION (BEFORE INSERT OR UPDATE)
CREATE OR REPLACE FUNCTION public.protect_club_membership_privileges()
RETURNS TRIGGER AS $$
DECLARE
  caller_role TEXT;
  is_admin BOOLEAN := false;
BEGIN
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
    IF NOT is_admin THEN
      NEW.role := 'member';
      NEW.status := 'pending';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT is_admin AND NOT public.is_club_organizer_or_admin(OLD.club_id, auth.uid()) THEN
      RAISE EXCEPTION 'Unauthorized: Only club organizers or administrators can modify memberships';
    END IF;

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

DROP TRIGGER IF EXISTS trg_protect_club_membership ON public.club_memberships;
CREATE TRIGGER trg_protect_club_membership
  BEFORE INSERT OR UPDATE ON public.club_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_club_membership_privileges();

-- 5. MEMBERSHIP STATE MACHINE TRANSITIONS
CREATE OR REPLACE FUNCTION public.enforce_membership_state_machine()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'banned' AND NEW.status != 'banned' THEN
      RAISE EXCEPTION 'Banned memberships cannot be reactivated directly';
    END IF;

    IF OLD.status = 'active' AND NEW.status = 'pending' THEN
      RAISE EXCEPTION 'Active memberships cannot transition back to pending';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_membership_state ON public.club_memberships;
CREATE TRIGGER trg_enforce_membership_state
  BEFORE INSERT OR UPDATE ON public.club_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_membership_state_machine();

-- 6. AUTO-NOTIFICATIONS TRIGGERS
CREATE OR REPLACE FUNCTION public.handle_membership_notifications()
RETURNS TRIGGER AS $$
DECLARE
  v_club_name TEXT;
  v_user_name TEXT;
  v_organizer RECORD;
BEGIN
  SELECT name INTO v_club_name FROM public.clubs WHERE id = NEW.club_id;
  SELECT username INTO v_user_name FROM public.profiles WHERE id = NEW.user_id;

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

-- 7. ANNOUNCEMENTS BROADCAST TRIGGER
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

-- 8. EVENT REGISTRATION CAPACITY TRACKER
CREATE OR REPLACE FUNCTION public.handle_event_capacity_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'registered' THEN
    UPDATE public.events
    SET registered_count = registered_count + 1
    WHERE id = NEW.event_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status != 'registered' AND NEW.status = 'registered' THEN
      UPDATE public.events
      SET registered_count = registered_count + 1
      WHERE id = NEW.event_id;
    ELSIF OLD.status = 'registered' AND NEW.status != 'registered' THEN
      UPDATE public.events
      SET registered_count = GREATEST(0, registered_count - 1)
      WHERE id = NEW.event_id;
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.status = 'registered' THEN
    UPDATE public.events
    SET registered_count = GREATEST(0, registered_count - 1)
    WHERE id = OLD.event_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_event_capacity ON public.event_registrations;
CREATE TRIGGER trg_event_capacity
  AFTER INSERT OR UPDATE OR DELETE ON public.event_registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_event_capacity_change();

-- 9. EVENT CANCELLATION BROADCAST
CREATE OR REPLACE FUNCTION public.handle_event_cancellation()
RETURNS TRIGGER AS $$
DECLARE
  v_reg RECORD;
BEGIN
  IF OLD.is_published = true AND NEW.is_published = false THEN
    FOR v_reg IN
      SELECT user_id FROM public.event_registrations
      WHERE event_id = NEW.id AND status = 'registered'
    LOOP
      INSERT INTO public.notifications (user_id, type, title, message, resource_type, resource_id)
      VALUES (
        v_reg.user_id,
        'event_reminder',
        'Event Update',
        'The event "' || NEW.title || '" has been cancelled or unpublished.',
        'event',
        NEW.id::text
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_event_cancel ON public.events;
CREATE TRIGGER trg_event_cancel
  AFTER UPDATE OF is_published ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_event_cancellation();

-- ============================================================================
-- SECURE STORED PROCEDURES / RPCs
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

-- ATOMIC EVENT REGISTRATION RPC
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

  SELECT id, status INTO v_existing_reg
  FROM public.event_registrations
  WHERE event_id = p_event_id AND user_id = v_user_id;

  IF FOUND THEN
    IF v_existing_reg.status = 'registered' THEN
      RAISE EXCEPTION 'Already registered for this event';
    ELSIF v_existing_reg.status = 'cancelled' THEN
      SELECT COUNT(*) INTO v_current_count
      FROM public.event_registrations
      WHERE event_id = p_event_id AND status = 'registered';

      IF v_current_count >= v_event.capacity THEN
        RAISE EXCEPTION 'Event is at full capacity';
      END IF;

      UPDATE public.event_registrations
      SET status = 'registered', qr_code_token = encode(gen_random_bytes(16), 'hex')
      WHERE id = v_existing_reg.id
      RETURNING * INTO v_new_reg;

      RETURN jsonb_build_object(
        'success', true,
        'registration_id', v_new_reg.id,
        'status', 'registered',
        'qr_code_token', v_new_reg.qr_code_token
      );
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_current_count
  FROM public.event_registrations
  WHERE event_id = p_event_id AND status = 'registered';

  IF v_current_count >= v_event.capacity THEN
    RAISE EXCEPTION 'Event is at full capacity (% / %)', v_current_count, v_event.capacity;
  END IF;

  INSERT INTO public.event_registrations (event_id, user_id, status)
  VALUES (p_event_id, v_user_id, 'registered')
  RETURNING * INTO v_new_reg;

  RETURN jsonb_build_object(
    'success', true,
    'registration_id', v_new_reg.id,
    'status', 'registered',
    'qr_code_token', v_new_reg.qr_code_token
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CANCEL EVENT REGISTRATION RPC
CREATE OR REPLACE FUNCTION public.cancel_event_registration(p_registration_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_reg RECORD;
BEGIN
  SELECT * INTO v_reg
  FROM public.event_registrations
  WHERE id = p_registration_id AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Registration not found or not owned by caller';
  END IF;

  IF v_reg.status = 'cancelled' THEN
    RAISE EXCEPTION 'Registration already cancelled';
  END IF;

  UPDATE public.event_registrations
  SET status = 'cancelled'
  WHERE id = p_registration_id;

  RETURN jsonb_build_object('success', true, 'registration_id', p_registration_id, 'status', 'cancelled');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- VERIFY EVENT TICKET RPC (QR CODE SCANNER)
CREATE OR REPLACE FUNCTION public.verify_event_ticket(p_qr_code_token TEXT)
RETURNS JSONB AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_reg RECORD;
  v_event RECORD;
  v_student RECORD;
  v_is_authorized BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required to scan tickets';
  END IF;

  SELECT * INTO v_reg
  FROM public.event_registrations
  WHERE qr_code_token = p_qr_code_token;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'error', 'Invalid ticket token');
  END IF;

  SELECT * INTO v_event FROM public.events WHERE id = v_reg.event_id;
  SELECT * INTO v_student FROM public.profiles WHERE id = v_reg.user_id;

  SELECT EXISTS (
    SELECT 1 FROM public.club_memberships
    WHERE club_id = v_event.club_id AND user_id = v_caller_id AND role IN ('president', 'organizer') AND status = 'active'
    UNION
    SELECT 1 FROM public.profiles
    WHERE id = v_caller_id AND college_role = 'college_admin'
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Unauthorized: Only club organizers or admins can verify tickets for this event';
  END IF;

  IF v_reg.status = 'attended' THEN
    RETURN jsonb_build_object(
      'valid', false,
      'status', 'already_attended',
      'attended_at', v_reg.attended_at,
      'student_name', v_student.username,
      'event_title', v_event.title
    );
  ELSIF v_reg.status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'valid', false,
      'status', 'cancelled',
      'student_name', v_student.username,
      'event_title', v_event.title
    );
  END IF;

  UPDATE public.event_registrations
  SET status = 'attended', attended_at = NOW()
  WHERE id = v_reg.id;

  RETURN jsonb_build_object(
    'valid', true,
    'status', 'admitted',
    'student_name', v_student.username,
    'student_id', v_student.student_id,
    'department', v_student.department,
    'event_title', v_event.title,
    'admitted_at', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
