-- =============================================================================
-- MIGRATION: SECURE PROFILE FALLBACK RPC & ACTIVATION CREDENTIAL SECURITY
-- =============================================================================
-- 1. Narrowly scoped, authenticated get_my_profile_fallback() RPC
-- 2. Dedicated caller-scoped view public.my_profile
-- 3. Activation lifecycle tracking: activation_expires_at and activated_at
-- 4. Authentication login audit & brute-force rate-limiting (audit_login_attempt, check_login_rate_limit)
-- =============================================================================

-- 1. ADD ACTIVATION LIFECYCLE COLUMNS TO PROFILES
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS activation_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

-- 2. DEDICATED AUTHENTICATED FALLBACK RPC FOR CALLER'S OWN PROFILE
-- Solves column permission restriction while preserving privacy
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

-- UPDATE PRIMARY get_my_profile() RPC TO ALSO INCLUDE ACTIVATION FIELDS
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

-- 3. DEDICATED VIEW FOR CALLER'S OWN PROFILE
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

-- 4. UPDATE PASSWORD CHANGED TRIGGER TO MARK ACTIVATION COMPLETE
CREATE OR REPLACE FUNCTION public.handle_auth_user_password_changed()
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password THEN
    UPDATE public.profiles
    SET 
      must_change_password = false,
      activated_at = pg_catalog.clock_timestamp(),
      activation_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- 5. AUTH LOGIN AUDIT & RATE-LIMITING
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

-- Audit insertion RPC
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
    pg_catalog.lower(pg_catalog.trim(p_identifier)),
    pg_catalog.clock_timestamp(),
    p_success,
    p_failure_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.audit_login_attempt(TEXT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_login_attempt(TEXT, BOOLEAN, TEXT) TO authenticated, anon;

-- Rate limiting check RPC: Returns false if 5 or more failed logins in last 15 minutes
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
  WHERE identifier = pg_catalog.lower(pg_catalog.trim(p_identifier))
    AND success = false
    AND attempt_time > pg_catalog.clock_timestamp() - interval '15 minutes';
  
  RETURN (v_recent_failures < 5);
END;
$$;

REVOKE ALL ON FUNCTION public.check_login_rate_limit(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_login_rate_limit(TEXT) TO authenticated, anon;
