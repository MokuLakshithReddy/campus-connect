-- ============================================================================
-- PERSISTENT MESSAGE READ STATE, NARROW UPDATE PRIVILEGES, & IMMUTABILITY
-- ============================================================================

-- 1. ADD IS_READ AND READ_AT TO MESSAGES
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_messages_convo_read ON public.messages(conversation_id, sender_id, is_read);

-- 2. RESTRICT COLUMN UPDATE PRIVILEGES (CLIENTS CANNOT UPDATE CONTENT OR SENDER)
REVOKE UPDATE ON public.messages FROM authenticated;
GRANT UPDATE (is_read, read_at) ON public.messages TO authenticated;

-- 3. ROW LEVEL SECURITY FOR MESSAGE READ UPDATES
DROP POLICY IF EXISTS "Users can mark messages as read" ON public.messages;
CREATE POLICY "Users can mark messages as read" ON public.messages
  FOR UPDATE TO authenticated
  USING (
    sender_id != auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  )
  WITH CHECK (
    sender_id != auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id
      AND (c.user1_id = auth.uid() OR c.user2_id = auth.uid())
    )
  );

-- 4. MESSAGE IMMUTABILITY TRIGGER (PREVENTS TAMPERING WITH CONTENT/METADATA)
CREATE OR REPLACE FUNCTION public.protect_message_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- Content, sender_id, conversation_id, created_at, and ID must NEVER change
  IF NEW.content IS DISTINCT FROM OLD.content OR
     NEW.sender_id IS DISTINCT FROM OLD.sender_id OR
     NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Unauthorized: Message content and metadata are immutable. Only read status can be updated.';
  END IF;

  -- Disallow sender from modifying read status of their own sent message
  IF auth.uid() IS NOT NULL AND auth.role() = 'authenticated' AND NEW.sender_id = auth.uid() THEN
    IF NEW.is_read IS DISTINCT FROM OLD.is_read OR NEW.read_at IS DISTINCT FROM OLD.read_at THEN
      RAISE EXCEPTION 'Unauthorized: Only recipients can mark messages as read.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_message_immutability ON public.messages;
CREATE TRIGGER trg_protect_message_immutability
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_message_immutability();

-- 5. NARROWLY SCOPED RPC TO MARK INCOMING CONVERSATION MESSAGES READ
CREATE OR REPLACE FUNCTION public.mark_messages_read(p_conversation_id UUID)
RETURNS INT AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_updated_count INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversations
    WHERE id = p_conversation_id AND (user1_id = v_user_id OR user2_id = v_user_id)
  ) THEN
    RAISE EXCEPTION 'Unauthorized: Caller is not a participant in this conversation';
  END IF;

  UPDATE public.messages
  SET is_read = true, read_at = NOW()
  WHERE conversation_id = p_conversation_id
    AND sender_id != v_user_id
    AND is_read = false;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. HELPER FUNCTION TO GET UNREAD MESSAGES COUNT ACCURATELY
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
