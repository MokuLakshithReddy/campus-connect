-- ============================================================================
-- CAMPUSCONNECT: ACADEMIC BRANCH REGISTRY & VERIFIED STUDENT DIRECTORY
-- ============================================================================

-- 1. ACADEMIC BRANCHES REGISTRY
-- Authoritative catalog of all 13 academic course/branch combinations
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

-- 2. ACADEMIC BRANCH PREFIX CONFIGURATION
-- Configurable mappings for official roll number prefixes
CREATE TABLE IF NOT EXISTS public.academic_branch_prefixes (
  prefix TEXT PRIMARY KEY,
  branch_id UUID NOT NULL REFERENCES public.academic_branches(id) ON DELETE CASCADE,
  admission_year INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (prefix = upper(trim(prefix))),
  CHECK (admission_year BETWEEN 2000 AND 2100)
);

-- 3. VERIFIED STUDENT DIRECTORY
-- Authoritative source of truth for enrolled students
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

-- 4. ASSOCIATE BRANCHES & CONTENT VISIBILITY WITH ENTITIES
ALTER TABLE public.profiles
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
-- Hardened with SET search_path = '' and explicit schema qualification.
CREATE OR REPLACE FUNCTION public.validate_student_directory_prefix()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_matching_prefix RECORD;
BEGIN
  -- Normalize roll number
  NEW.roll_number := pg_catalog.upper(pg_catalog.btrim(NEW.roll_number));

  IF pg_catalog.length(NEW.roll_number) != 12 THEN
    RAISE EXCEPTION 'Roll number must be exactly 12 characters';
  END IF;

  -- Literal prefix matching (avoiding SQL LIKE wildcard semantics on _ and %)
  -- Deterministic longest-prefix rule resolves any overlapping configurations
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

-- 6. PROFILE ACADEMIC INTEGRITY & ROLE ESCALATION PROTECTION TRIGGER
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

-- Drop legacy trigger that blocked directory sync
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
) ON public.profiles TO authenticated, anon;

-- Dedicated secure RPC for authenticated users to view their own full profile including student_id
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

GRANT SELECT ON public.public_profiles TO authenticated, anon;

-- 7. SEED ACADEMIC BRANCHES & CONFIRMED PREFIXES
-- Inserts all 13 official listed branches; activates confirmed 2025 prefixes
DO $$
DECLARE
  v_aiml_id UUID;
  v_cse_id UUID;
BEGIN
  -- Insert all 13 official academic branches
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

  -- Seed confirmed 2025 cohort prefixes
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

-- 8. RPC: RESOLVE STUDENT BRANCH (LITERAL PREFIX MATCH WITH LONGEST-PREFIX RULE)
-- Hardened with SET search_path = '' and explicit schema qualification.
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
-- Hardened with:
-- (1) SET search_path = ''
-- (2) SELECT FOR UPDATE row locking
-- (3) Ownership check against conflicting claims
-- (4) GET DIAGNOSTICS ROW_COUNT verification
-- (5) Sets is_verified = true upon successful linking
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

  -- 1. Load the caller's profile
  SELECT * INTO v_profile FROM public.profiles WHERE id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile record not found';
  END IF;

  IF v_profile.student_id IS NULL OR pg_catalog.btrim(v_profile.student_id) = '' THEN
    RETURN pg_catalog.jsonb_build_object('linked', false, 'reason', 'No student roll number on profile');
  END IF;

  -- 2. Lock the directory record with FOR UPDATE to prevent concurrent claiming
  SELECT * INTO v_dir
  FROM public.student_directory
  WHERE roll_number = pg_catalog.upper(pg_catalog.btrim(v_profile.student_id)) AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('linked', false, 'reason', 'Student roll number not found in active directory');
  END IF;

  -- 3. Check ownership: record must be unclaimed OR already belong to this user
  IF v_dir.profile_id IS NOT NULL AND v_dir.profile_id != v_user_id THEN
    RAISE EXCEPTION 'Directory record already linked to another account'
      USING HINT = 'Contact campus administration if you believe this is an error.';
  END IF;

  -- 4. Atomically link directory row to this profile and verify exactly 1 row updated
  UPDATE public.student_directory
  SET profile_id = v_user_id
  WHERE roll_number = v_dir.roll_number
    AND (profile_id IS NULL OR profile_id = v_user_id);

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

  IF v_rows_updated != 1 THEN
    RAISE EXCEPTION 'Directory link failed: expected 1 row updated, got %', v_rows_updated
      USING HINT = 'This may indicate a concurrent claim attempt. Please retry.';
  END IF;

  -- 5. Only after the directory link succeeds, update the profile via dedicated internal updater
  SELECT * INTO v_branch FROM public.academic_branches WHERE id = v_dir.branch_id;

  PERFORM public.internal_apply_directory_verification(v_user_id, v_dir.branch_id, v_branch.display_name);

  RETURN pg_catalog.jsonb_build_object(
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
      -- Default to caller's verified branch if query is short
      IF pg_catalog.length(v_sanitized) < 3 THEN
        v_effective_branch_id := v_caller_branch_id;
      ELSE
        -- If query >= 3 characters, allow targeted cross-college discovery
        v_effective_branch_id := NULL;
      END IF;
    ELSIF p_branch_id = v_caller_branch_id THEN
      v_effective_branch_id := v_caller_branch_id;
    ELSE
      -- Specific other branch selected: require query length >= 3 to prevent broad enumeration
      IF pg_catalog.length(v_sanitized) < 3 THEN
        RAISE EXCEPTION 'Cross-branch search requires at least 3 search characters';
      END IF;
      v_effective_branch_id := p_branch_id;
    END IF;
  END IF;

  v_effective_limit := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 20);
  v_effective_offset := GREATEST(COALESCE(p_offset, 0), 0);

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
      p.username ILIKE ('%' || v_sanitized || '%') OR
      p.student_id ILIKE ('%' || v_sanitized || '%') OR
      p.department ILIKE ('%' || v_sanitized || '%')
    )
    AND (v_effective_branch_id IS NULL OR p.branch_id = v_effective_branch_id)
  ORDER BY p.username ASC
  LIMIT v_effective_limit
  OFFSET v_effective_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.search_campus_students(TEXT, UUID, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_campus_students(TEXT, UUID, INT, INT) TO authenticated;

-- 11. STRICT ROW LEVEL SECURITY (RLS) FOR REGISTRIES
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

-- Student directory privacy: students can ONLY read their own linked enrollment record
DROP POLICY IF EXISTS "Active directory records viewable by authenticated users" ON public.student_directory;
DROP POLICY IF EXISTS "Students view own directory record" ON public.student_directory;
CREATE POLICY "Students view own directory record"
  ON public.student_directory
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin')
  );

-- Directory management restricted strictly to college administrators
DROP POLICY IF EXISTS "Admins can manage student directory" ON public.student_directory;
CREATE POLICY "Admins can manage student directory"
  ON public.student_directory
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin'));

-- 12. DATABASE-LEVEL CONTENT AUDIENCE AND VISIBILITY RLS POLICIES
-- Enforces college vs branch vs club_members visibility directly in PostgreSQL.

-- A. POSTS AUDIENCE POLICY
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

-- B. EVENTS AUDIENCE POLICY
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

-- C. CLUBS AUDIENCE POLICY
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

-- D. CHANNEL MESSAGES AUDIENCE POLICY (ANNOUNCEMENTS & DISCUSSIONS)
DROP POLICY IF EXISTS "Active members view messages" ON public.channel_messages;
DROP POLICY IF EXISTS "Audience can view channel messages" ON public.channel_messages;
CREATE POLICY "Audience can view channel messages" ON public.channel_messages
  FOR SELECT TO authenticated
  USING (
    sender_id = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin') OR
    -- Active club members can view messages in their club channels
    EXISTS (
      SELECT 1 FROM public.club_channels cc
      JOIN public.club_memberships cm ON cm.club_id = cc.club_id
      WHERE cc.id = channel_messages.channel_id AND cm.user_id = auth.uid() AND cm.status = 'active'
    ) OR
    -- Non-members can view public announcements according to visibility scope
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
