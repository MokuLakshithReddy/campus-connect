-- =============================================================================
-- COLLEGE ADMIN PORTAL RPCS AND TELEMETRY
-- =============================================================================

-- 1. Metrics Overview RPC for College Admins
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_metrics()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
  v_total_students INT;
  v_verified_students INT;
  v_unverified_students INT;
  v_total_clubs INT;
  v_active_clubs INT;
  v_pending_clubs INT;
  v_total_events INT;
  v_failed_logins_24h INT;
  v_successful_logins_24h INT;
BEGIN
  SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
    RAISE EXCEPTION 'Access denied. Only college administrators can view system metrics.';
  END IF;

  SELECT count(*) INTO v_total_students FROM public.profiles WHERE college_role = 'student';
  SELECT count(*) INTO v_verified_students FROM public.profiles WHERE college_role = 'student' AND is_verified = true;
  SELECT count(*) INTO v_unverified_students FROM public.profiles WHERE college_role = 'student' AND is_verified = false;

  SELECT count(*) INTO v_total_clubs FROM public.clubs;
  SELECT count(*) INTO v_active_clubs FROM public.clubs WHERE status = 'active';
  SELECT count(*) INTO v_pending_clubs FROM public.clubs WHERE status = 'pending_approval';

  SELECT count(*) INTO v_total_events FROM public.events;

  SELECT count(*) INTO v_failed_logins_24h 
  FROM public.auth_login_audit 
  WHERE success = false AND attempt_time > pg_catalog.clock_timestamp() - interval '24 hours';

  SELECT count(*) INTO v_successful_logins_24h 
  FROM public.auth_login_audit 
  WHERE success = true AND attempt_time > pg_catalog.clock_timestamp() - interval '24 hours';

  RETURN pg_catalog.jsonb_build_object(
    'total_students', v_total_students,
    'verified_students', v_verified_students,
    'unverified_students', v_unverified_students,
    'total_clubs', v_total_clubs,
    'active_clubs', v_active_clubs,
    'pending_clubs', v_pending_clubs,
    'total_events', v_total_events,
    'failed_logins_24h', v_failed_logins_24h,
    'successful_logins_24h', v_successful_logins_24h
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_dashboard_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_metrics() TO authenticated;

-- 2. Login Telemetry Audit RPC for College Admins
CREATE OR REPLACE FUNCTION public.get_admin_login_audit(p_limit INT DEFAULT 30)
RETURNS TABLE (
  identifier TEXT,
  attempt_time TIMESTAMPTZ,
  success BOOLEAN,
  failure_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
BEGIN
  SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
    RAISE EXCEPTION 'Access denied. Only college administrators can view login audit.';
  END IF;

  RETURN QUERY
  SELECT a.identifier, a.attempt_time, a.success, a.failure_reason
  FROM public.auth_login_audit a
  ORDER BY a.attempt_time DESC
  LIMIT pg_catalog.least(p_limit, 100);
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_login_audit(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_login_audit(INT) TO authenticated;

-- 3. Student Verification Admin RPC
CREATE OR REPLACE FUNCTION public.admin_verify_student(p_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
  v_student_id TEXT;
  v_branch_id UUID;
  v_dept TEXT;
  v_year TEXT;
BEGIN
  SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
    RAISE EXCEPTION 'Access denied. Only college administrators can verify students.';
  END IF;

  SELECT student_id INTO v_student_id FROM public.profiles WHERE id = p_profile_id;
  
  -- Attempt directory resolution if entry exists
  IF v_student_id IS NOT NULL AND v_student_id != '' THEN
    SELECT branch_id, department, year INTO v_branch_id, v_dept, v_year
    FROM public.student_directory
    WHERE roll_number = pg_catalog.upper(pg_catalog.btrim(v_student_id))
    LIMIT 1;

    IF v_branch_id IS NOT NULL THEN
      UPDATE public.student_directory
      SET profile_id = p_profile_id, claimed_at = pg_catalog.clock_timestamp()
      WHERE roll_number = pg_catalog.upper(pg_catalog.btrim(v_student_id));
    END IF;
  END IF;

  UPDATE public.profiles
  SET 
    is_verified = true,
    branch_id = COALESCE(v_branch_id, branch_id),
    department = COALESCE(v_dept, department),
    year = COALESCE(v_year, year)
  WHERE id = p_profile_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_verify_student(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_verify_student(UUID) TO authenticated;

-- 4. Club Status Admin RPC
CREATE OR REPLACE FUNCTION public.admin_set_club_status(p_club_id UUID, p_status TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
BEGIN
  SELECT college_role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'college_admin' THEN
    RAISE EXCEPTION 'Access denied. Only college administrators can update club status.';
  END IF;

  IF p_status NOT IN ('active', 'pending_approval', 'inactive', 'rejected') THEN
    RAISE EXCEPTION 'Invalid club status: %', p_status;
  END IF;

  UPDATE public.clubs
  SET status = p_status
  WHERE id = p_club_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_club_status(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_club_status(UUID, TEXT) TO authenticated;
