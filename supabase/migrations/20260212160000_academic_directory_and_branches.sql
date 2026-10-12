-- ============================================================================
-- CAMPUSCONNECT: ACADEMIC BRANCH REGISTRY & VERIFIED STUDENT DIRECTORY
-- ============================================================================

-- 1. ACADEMIC BRANCHES REGISTRY
CREATE TABLE IF NOT EXISTS public.academic_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course TEXT NOT NULL,
  branch_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course, branch_code)
);

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

-- 5. VALIDATION TRIGGER: ENFORCE PREFIX VALIDATION ON STUDENT DIRECTORY
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

  -- Validate against registered branch prefixes
  SELECT prefix, branch_id, admission_year INTO v_matching_prefix
  FROM public.academic_branch_prefixes
  WHERE NEW.roll_number LIKE (prefix || '%') AND is_active = true
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

-- 6. PROFILE ACADEMIC INTEGRITY TRIGGER
-- Prevents ordinary students from tampering with assigned roll_number or branch_id
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

  -- If caller is not admin and trying to alter student_id or branch_id
  IF NOT COALESCE(v_is_admin, false) THEN
    IF OLD.student_id IS NOT NULL AND NEW.student_id IS DISTINCT FROM OLD.student_id THEN
      RAISE EXCEPTION 'Unauthorized: Student roll number cannot be modified';
    END IF;

    IF OLD.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
      RAISE EXCEPTION 'Unauthorized: Academic branch cannot be modified by student';
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

-- 7. SEED CONFIRMED BRANCHES & PREFIXES
-- Confirmed 2025 mappings:
-- 25MVCSMR -> B.Tech CSE-AIML
-- 25MVCSER -> B.Tech CSE
DO $$
DECLARE
  v_aiml_id UUID;
  v_cse_id UUID;
BEGIN
  -- Insert CSE-AIML branch
  INSERT INTO public.academic_branches (course, branch_code, display_name)
  VALUES ('B.Tech', 'CSE-AIML', 'Computer Science and Engineering (AI & ML)')
  ON CONFLICT (course, branch_code) DO UPDATE
    SET display_name = EXCLUDED.display_name
  RETURNING id INTO v_aiml_id;

  -- Insert CSE branch
  INSERT INTO public.academic_branches (course, branch_code, display_name)
  VALUES ('B.Tech', 'CSE', 'Computer Science and Engineering')
  ON CONFLICT (course, branch_code) DO UPDATE
    SET display_name = EXCLUDED.display_name
  RETURNING id INTO v_cse_id;

  -- Insert prefixes
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

-- 8. RPC: RESOLVE STUDENT BRANCH INFORMATION
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
  WHERE v_clean_roll LIKE (abp.prefix || '%') AND abp.is_active = true
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

-- 9. ROW LEVEL SECURITY (RLS) FOR ACADEMIC DIRECTORY
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
CREATE POLICY "Active directory records viewable by authenticated users"
  ON public.student_directory
  FOR SELECT TO authenticated
  USING (is_active = true);

-- Directory management restricted to college admins
DROP POLICY IF EXISTS "Admins can manage student directory" ON public.student_directory;
CREATE POLICY "Admins can manage student directory"
  ON public.student_directory
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND college_role = 'college_admin'));
