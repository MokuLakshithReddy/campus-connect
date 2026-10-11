-- ============================================================================
-- STORAGE BUCKETS INITIALIZATION AND POLICIES
-- ============================================================================

-- 1. ENSURE STORAGE BUCKETS EXIST
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true;

INSERT INTO storage.buckets (id, name, public)
VALUES ('posts', 'posts', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 2. STORAGE POLICIES FOR AVATARS
DROP POLICY IF EXISTS "Public can view avatars" ON storage.objects;
CREATE POLICY "Public can view avatars" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Authenticated users upload avatars" ON storage.objects;
CREATE POLICY "Authenticated users upload avatars" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Users update own avatars" ON storage.objects;
CREATE POLICY "Users update own avatars" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users delete own avatars" ON storage.objects;
CREATE POLICY "Users delete own avatars" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 3. STORAGE POLICIES FOR POSTS
DROP POLICY IF EXISTS "Public can view posts" ON storage.objects;
CREATE POLICY "Public can view posts" ON storage.objects
  FOR SELECT USING (bucket_id = 'posts');

DROP POLICY IF EXISTS "Authenticated users upload post media" ON storage.objects;
CREATE POLICY "Authenticated users upload post media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'posts');

DROP POLICY IF EXISTS "Users update own post media" ON storage.objects;
CREATE POLICY "Users update own post media" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'posts');

DROP POLICY IF EXISTS "Users delete own post media" ON storage.objects;
CREATE POLICY "Users delete own post media" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'posts');
