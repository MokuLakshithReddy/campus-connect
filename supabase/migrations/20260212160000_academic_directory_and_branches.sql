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

-- 4. ASSOCIATE BRANCHES WITH PROFILES AND POSTS
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id);

CREATE INDEX IF NOT EXISTS idx_profiles_branch_id
  ON public.profiles(branch_id);

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id);

CREATE INDEX IF NOT EXISTS idx_posts_branch_id
  ON public.posts(branch_id);

-- Backfill existing posts from author profiles
UPDATE public.posts p
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE p.user_id = pr.id
  AND p.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;

-- 5. VALIDATION TRIGGER: LITERAL PREFIX MATCHING WITH LONGEST-PREFIX PRECEDENCE
CREATE OR REPLACE FUNCTION public.validate_student_directory_prefix()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_matching_prefix RECORD;
BEGIN
  -- Normalize roll number
  NEW.roll_number := upper(trim(NEW.roll_number));

  IF length(NEW.roll_number) != 12 THEN
    RAISE EXCEPTION 'Roll number must be exactly 12 characters';
  END IF;

  -- Literal prefix matching (avoiding SQL LIKE wildcard semantics on _ and %)
  -- Deterministic longest-prefix rule resolves any overlapping configurations
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

-- 6. PROFILE ACADEMIC INTEGRITY & ROLE ESCALATION PROTECTION TRIGGER
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

  -- Non-admins cannot alter verified academic fields or self-escalate college_role
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

-- 7. SEED ACADEMIC BRANCHES & CONFIRMED PREFIXES
-- Inserts all official listed branches; activates only verified 2025 prefixes
DO $$
DECLARE
  v_aiml_id UUID;
  v_cse_id UUID;
BEGIN
  -- Insert all 13 official academic branches
  INSERT INTO public.academic_branches (course, branch_code, display_name)
  VALUES
    ('B.Tech', 'CSE-AIML', 'Computer Science and Engineering (AI & ML)'),
    ('B.Tech', 'CSE', 'Computer Science and Engineering'),
    ('B.Tech', 'CSE-DS', 'Computer Science and Engineering (Data Science)'),
    ('B.Tech', 'CSE-AI', 'Computer Science and Engineering (Artificial Intelligence)'),
    ('B.Tech', 'CSE-AIDS', 'Computer Science and Engineering (AI & Data Science)'),
    ('B.Tech', 'CSE-CS', 'Computer Science and Engineering (Cyber Security)'),
    ('B.Tech', 'CSIT', 'Computer Science and Information Technology'),
    ('B.Tech', 'ECE', 'Electronics and Communication Engineering'),
    ('B.Tech', 'CSE-ICB', 'Computer Science and Engineering (IoT & Cyber Security including Blockchain)'),
    ('B.Tech', 'RAI', 'Robotics and Artificial Intelligence'),
    ('BBA', 'BBA', 'Bachelor of Business Administration'),
    ('M.Tech', 'CSE', 'Master of Technology (Computer Science)'),
    ('M.Tech', 'CSE-AIML', 'Master of Technology (CSE - AI & ML)')
  ON CONFLICT (course, branch_code) DO UPDATE
    SET display_name = EXCLUDED.display_name;

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

-- 9. RPC: TRUSTED SERVER-SIDE DIRECTORY ACCOUNT SYNCHRONIZATION
-- Hardened with FOR UPDATE row locking and row-count verification.
-- Fails closed: raises an exception if another account already owns the directory record.
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

  -- 1. Load the caller's profile
  SELECT * INTO v_profile FROM public.profiles WHERE id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile record not found';
  END IF;

  IF v_profile.student_id IS NULL THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'No student roll number on profile');
  END IF;

  -- 2. Lock the directory record with FOR UPDATE to prevent concurrent claiming
  SELECT * INTO v_dir
  FROM public.student_directory
  WHERE roll_number = upper(trim(v_profile.student_id)) AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'Student roll number not found in active directory');
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

  -- 5. Only after the directory link succeeds, update the profile
  SELECT * INTO v_branch FROM public.academic_branches WHERE id = v_dir.branch_id;

  UPDATE public.profiles
  SET branch_id = v_dir.branch_id,
      department = v_branch.display_name,
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

-- 10. RPC: CONTROLLED STUDENT DISCOVERY SEARCH (PRIVACY-PRESERVING)
-- Returns masked roll numbers (last 4 chars only) to protect student identifiers.
-- Full roll numbers remain searchable but are never exposed in results.
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
    -- Mask roll number: show only last 4 characters for privacy
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

-- 11. STRICT ROW LEVEL SECURITY (RLS)
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
-- Administrators can view all directory rows for verification & operations
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

-- ============================================================================
-- 12. CONTENT VISIBILITY / AUDIENCE MODEL
-- ============================================================================
-- Distinguishes "who created the content" from "who should see it".
-- Valid values: 'college' (everyone), 'branch' (author's branch), 'club_members' (club members only).

-- Posts
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS content_visibility TEXT NOT NULL DEFAULT 'college'
  CHECK (content_visibility IN ('college', 'branch', 'club_members'));

-- Events
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS content_visibility TEXT NOT NULL DEFAULT 'college'
  CHECK (content_visibility IN ('college', 'branch', 'club_members'));

-- Clubs
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS content_visibility TEXT NOT NULL DEFAULT 'college'
  CHECK (content_visibility IN ('college', 'branch', 'club_members'));

-- Channel messages (announcements)
ALTER TABLE public.channel_messages
  ADD COLUMN IF NOT EXISTS content_visibility TEXT NOT NULL DEFAULT 'college'
  CHECK (content_visibility IN ('college', 'branch', 'club_members'));

-- 13. AUTO-POPULATE POST branch_id FROM AUTHOR'S VERIFIED PROFILE
-- Ensures new posts always carry the author's verified branch_id (if available).
-- This eliminates reliance on the frontend to set branch_id.
CREATE OR REPLACE FUNCTION public.auto_set_post_branch_from_author()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_author_branch_id UUID;
BEGIN
  -- Only set branch_id if it was not explicitly provided
  IF NEW.branch_id IS NULL THEN
    SELECT branch_id INTO v_author_branch_id
    FROM public.profiles
    WHERE id = NEW.user_id;

    IF v_author_branch_id IS NOT NULL THEN
      NEW.branch_id := v_author_branch_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_set_post_branch ON public.posts;
CREATE TRIGGER trg_auto_set_post_branch
  BEFORE INSERT ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_set_post_branch_from_author();

-- 14. AUTHORITATIVE BRANCH_ID ON CLUBS, EVENTS, AND CHANNEL MESSAGES
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id);

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id);

ALTER TABLE public.channel_messages
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.academic_branches(id);

CREATE INDEX IF NOT EXISTS idx_clubs_branch_id ON public.clubs(branch_id);
CREATE INDEX IF NOT EXISTS idx_events_branch_id ON public.events(branch_id);
CREATE INDEX IF NOT EXISTS idx_channel_messages_branch_id ON public.channel_messages(branch_id);

-- Auto-set branch_id from creator/sender triggers
CREATE OR REPLACE FUNCTION public.auto_set_event_branch_from_creator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_creator_branch_id UUID;
BEGIN
  IF NEW.branch_id IS NULL AND NEW.created_by IS NOT NULL THEN
    SELECT branch_id INTO v_creator_branch_id
    FROM public.profiles
    WHERE id = NEW.created_by;

    IF v_creator_branch_id IS NOT NULL THEN
      NEW.branch_id := v_creator_branch_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_set_event_branch ON public.events;
CREATE TRIGGER trg_auto_set_event_branch
  BEFORE INSERT ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_set_event_branch_from_creator();

CREATE OR REPLACE FUNCTION public.auto_set_club_branch_from_creator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_creator_branch_id UUID;
BEGIN
  IF NEW.branch_id IS NULL AND NEW.created_by IS NOT NULL THEN
    SELECT branch_id INTO v_creator_branch_id
    FROM public.profiles
    WHERE id = NEW.created_by;

    IF v_creator_branch_id IS NOT NULL THEN
      NEW.branch_id := v_creator_branch_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_set_club_branch ON public.clubs;
CREATE TRIGGER trg_auto_set_club_branch
  BEFORE INSERT ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_set_club_branch_from_creator();

CREATE OR REPLACE FUNCTION public.auto_set_message_branch_from_sender()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sender_branch_id UUID;
BEGIN
  IF NEW.branch_id IS NULL AND NEW.sender_id IS NOT NULL THEN
    SELECT branch_id INTO v_sender_branch_id
    FROM public.profiles
    WHERE id = NEW.sender_id;

    IF v_sender_branch_id IS NOT NULL THEN
      NEW.branch_id := v_sender_branch_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_set_message_branch ON public.channel_messages;
CREATE TRIGGER trg_auto_set_message_branch
  BEFORE INSERT ON public.channel_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_set_message_branch_from_sender();

-- Backfill existing events, clubs, and messages
UPDATE public.events e
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE e.created_by = pr.id
  AND e.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;

UPDATE public.clubs c
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE c.created_by = pr.id
  AND c.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;

UPDATE public.channel_messages m
SET branch_id = pr.branch_id
FROM public.profiles pr
WHERE m.sender_id = pr.id
  AND m.branch_id IS NULL
  AND pr.branch_id IS NOT NULL;
