-- ============================================================================
-- PERSISTENT MESSAGE READ STATE & UNREAD AGGREGATION
-- ============================================================================

-- 1. ADD IS_READ AND READ_AT TO MESSAGES
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_messages_convo_read ON public.messages(conversation_id, sender_id, is_read);

-- 2. ALLOW RECIPIENTS TO UPDATE READ STATUS
DROP POLICY IF EXISTS "Users can mark messages as read" ON public.messages;
CREATE POLICY "Users can mark messages as read" ON public.messages
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );

-- 3. HELPER FUNCTION TO GET UNREAD MESSAGES COUNT ACCURATELY
CREATE OR REPLACE FUNCTION public.get_unread_messages_count()
RETURNS INT AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_count INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  WHERE (c.user1_id = v_user_id OR c.user2_id = v_user_id)
    AND m.sender_id != v_user_id
    AND m.is_read = false;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
