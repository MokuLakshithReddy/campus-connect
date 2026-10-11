-- ============================================================================
-- STORAGE BUCKETS INITIALIZATION AND STRICT RLS POLICIES
-- ============================================================================

-- 1. ENSURE STORAGE BUCKETS EXIST
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars', 
  'avatars', 
  true, 
  5242880, -- 5 MB limit
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
  20971520, -- 20 MB limit
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime']
)
ON CONFLICT (id) DO UPDATE SET 
  public = true,
  file_size_limit = 20971520,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'];

-- 2. STORAGE POLICIES FOR AVATARS (STRICT PATH & TYPE OWNERSHIP)
DROP POLICY IF EXISTS "Public can view avatars" ON storage.objects;
CREATE POLICY "Public can view avatars" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Authenticated users upload avatars" ON storage.objects;
DROP POLICY IF EXISTS "Users upload own avatar" ON storage.objects;
CREATE POLICY "Users upload own avatar" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] = auth.uid()::text AND
    LOWER(storage.extension(name)) IN ('jpg', 'jpeg', 'png', 'webp', 'gif')
  );

DROP POLICY IF EXISTS "Users update own avatars" ON storage.objects;
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

DROP POLICY IF EXISTS "Users delete own avatars" ON storage.objects;
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

-- 3. STORAGE POLICIES FOR POST MEDIA (STRICT PATH & TYPE OWNERSHIP)
DROP POLICY IF EXISTS "Public can view posts" ON storage.objects;
CREATE POLICY "Public can view posts" ON storage.objects
  FOR SELECT USING (bucket_id = 'posts');

DROP POLICY IF EXISTS "Authenticated users upload post media" ON storage.objects;
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
