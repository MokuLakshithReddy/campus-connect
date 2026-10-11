import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

interface MessagePayload {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  is_read?: boolean;
}

export const useUnreadMessages = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [unreadCount, setUnreadCount] = useState(0);
  const convoIdsRef = useRef<Set<string>>(new Set());

  // Database-backed aggregate fetch of unread messages count
  const fetchUnreadCount = useCallback(async () => {
    if (!user) {
      setUnreadCount(0);
      return;
    }

    try {
      // 1. Try secure stored procedure aggregate
      const { data, error } = await supabase.rpc("get_unread_messages_count");
      if (!error && typeof data === "number") {
        setUnreadCount(data);
        return;
      }

      // 2. Resilient fallback query if RPC is compiling or unavailable
      const { data: convos } = await supabase
        .from("conversations")
        .select("id")
        .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`);

      const ids = (convos ?? []).map((c) => c.id);
      convoIdsRef.current = new Set(ids);

      if (ids.length === 0) {
        setUnreadCount(0);
        return;
      }

      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .in("conversation_id", ids)
        .neq("sender_id", user.id)
        .eq("is_read", false);

      setUnreadCount(count ?? 0);
    } catch (err) {
      console.error("Error fetching unread messages count:", err);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;

    fetchUnreadCount();

    // Listen for new messages or read state updates in real-time
    const channel = supabase
      .channel(`user-unread-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        async (payload) => {
          const msg = payload.new as MessagePayload;
          if (!msg || msg.sender_id === user.id) return;

          // Verify this message belongs to one of user's conversations
          let isUserConvo = convoIdsRef.current.has(msg.conversation_id);
          if (!isUserConvo) {
            const { data: convo } = await supabase
              .from("conversations")
              .select("id")
              .eq("id", msg.conversation_id)
              .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
              .maybeSingle();

            if (convo) {
              convoIdsRef.current.add(convo.id);
              isUserConvo = true;
            }
          }

          if (!isUserConvo) return;

          setUnreadCount((c) => c + 1);
          toast("New message received", {
            description: msg.content?.length > 50 ? msg.content.slice(0, 50) + "…" : msg.content,
            action: {
              label: "View",
              onClick: () => {
                navigate(`/chat/${msg.conversation_id}`);
              },
            },
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages" },
        () => {
          // Re-synchronize unread count when messages are marked as read in database
          fetchUnreadCount();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, navigate, fetchUnreadCount]);

  // Mark messages in a conversation as read in the database
  const clearUnread = async (conversationId?: string) => {
    if (!user) return;

    if (conversationId) {
      try {
        await supabase
          .from("messages")
          .update({ is_read: true, read_at: new Date().toISOString() })
          .eq("conversation_id", conversationId)
          .neq("sender_id", user.id)
          .eq("is_read", false);
      } catch (err) {
        console.error("Failed to mark conversation read:", err);
      }
    }

    fetchUnreadCount();
  };

  return { unreadCount, clearUnread, refreshUnreadCount: fetchUnreadCount };
};

export default useUnreadMessages;
