-- =============================================================================
-- HIGH-FREQUENCY QUERY INDEXES MIGRATION
-- =============================================================================

-- 1. Club Memberships High-Frequency Indexes
CREATE INDEX IF NOT EXISTS idx_club_memberships_user_status 
  ON public.club_memberships(user_id, status);

CREATE INDEX IF NOT EXISTS idx_club_memberships_club_status 
  ON public.club_memberships(club_id, status);

CREATE INDEX IF NOT EXISTS idx_club_memberships_club_role_status 
  ON public.club_memberships(club_id, role, status);

-- 2. Event Registrations High-Frequency Indexes
CREATE INDEX IF NOT EXISTS idx_event_registrations_user_status 
  ON public.event_registrations(user_id, status);

CREATE INDEX IF NOT EXISTS idx_event_registrations_event_status 
  ON public.event_registrations(event_id, status);

CREATE INDEX IF NOT EXISTS idx_event_registrations_event_qr 
  ON public.event_registrations(event_id, qr_code_token);

-- 3. Channel Messages High-Frequency Indexes
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created 
  ON public.channel_messages(channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_messages_sender 
  ON public.channel_messages(sender_id);

-- 4. Events High-Frequency Indexes
CREATE INDEX IF NOT EXISTS idx_events_club_start_time 
  ON public.events(club_id, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_events_published_start_time 
  ON public.events(is_published, start_time) 
  WHERE is_published = true;

-- 5. Notifications (Unread & Chronological) High-Frequency Indexes
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread 
  ON public.notifications(user_id, created_at DESC) 
  WHERE is_read = false;

CREATE INDEX IF NOT EXISTS idx_notifications_user_all 
  ON public.notifications(user_id, created_at DESC);

-- 6. Conversations & Direct Messages High-Frequency Indexes
CREATE INDEX IF NOT EXISTS idx_conversations_user1_last_msg 
  ON public.conversations(user1_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_user2_last_msg 
  ON public.conversations(user2_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created 
  ON public.messages(conversation_id, created_at DESC);
