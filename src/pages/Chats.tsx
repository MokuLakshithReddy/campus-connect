import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { getAvatarUrl } from "@/lib/supabase-helpers";
import { MessageCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";

interface ConversationWithProfile {
  id: string;
  otherUserId: string;
  username: string;
  avatar_url: string | null;
  lastMessage: string | null;
  lastMessageAt: string;
}

const Chats = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<ConversationWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIdRef = useRef(0);
  const isMountedRef = useRef(true);

  const fetchConversations = useCallback(async () => {
    if (!user) return;
    const fetchId = ++fetchIdRef.current;

    try {
      setLoading(true);
      setError(null);

      // 1. Fetch user conversations
      const { data: convos, error: convosErr } = await supabase
        .from("conversations")
        .select("*")
        .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
        .order("last_message_at", { ascending: false });

      if (convosErr) throw convosErr;

      if (!convos || convos.length === 0) {
        if (isMountedRef.current && fetchId === fetchIdRef.current) {
          setConversations([]);
          setLoading(false);
        }
        return;
      }

      const otherUserIds = convos.map((c) =>
        c.user1_id === user.id ? c.user2_id : c.user1_id
      );
      const convoIds = convos.map((c) => c.id);

      // 2. Batch fetch profiles and latest messages in parallel (avoiding N+1 queries)
      const [profilesRes, messagesRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, username, avatar_url")
          .in("id", otherUserIds),
        supabase
          .from("messages")
          .select("conversation_id, content, created_at")
          .in("conversation_id", convoIds)
          .order("created_at", { ascending: false }),
      ]);

      if (profilesRes.error) {
        console.warn("Could not batch load profiles:", profilesRes.error.message);
      }
      if (messagesRes.error) {
        console.warn("Could not batch load messages:", messagesRes.error.message);
      }

      // Check if request is still current and component is mounted
      if (!isMountedRef.current || fetchId !== fetchIdRef.current) return;

      const profileMap = new Map(profilesRes.data?.map((p) => [p.id, p]) ?? []);

      // Build latest-message lookup map per conversation
      const lastMessageMap = new Map<string, string>();
      if (messagesRes.data) {
        for (const msg of messagesRes.data) {
          if (!lastMessageMap.has(msg.conversation_id)) {
            lastMessageMap.set(msg.conversation_id, msg.content);
          }
        }
      }

      // Map combined conversation data
      const results: ConversationWithProfile[] = convos.map((c) => {
        const otherUserId = c.user1_id === user.id ? c.user2_id : c.user1_id;
        const profile = profileMap.get(otherUserId);
        return {
          id: c.id,
          otherUserId,
          username: profile?.username ?? "Unknown",
          avatar_url: profile?.avatar_url ?? null,
          lastMessage: lastMessageMap.get(c.id) ?? null,
          lastMessageAt: c.last_message_at,
        };
      });

      setConversations(results);
    } catch (err: unknown) {
      const e = err as Error;
      console.error("Error loading conversations:", e);
      if (isMountedRef.current && fetchId === fetchIdRef.current) {
        setError(e.message || "Failed to load conversations");
      }
    } finally {
      if (isMountedRef.current && fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [user]);

  useEffect(() => {
    isMountedRef.current = true;
    fetchConversations();

    // Realtime subscription with debounce to protect against rapid duplicate queries
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("chats-list-updates")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            fetchConversations();
          }, 300);
        }
      )
      .subscribe();

    return () => {
      isMountedRef.current = false;
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [fetchConversations]);

  return (
    <AppLayout>
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur px-4 py-3">
        <h1 className="text-xl font-bold tracking-tight">Messages</h1>
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-20 text-center px-4">
          <AlertCircle className="h-12 w-12 text-destructive mb-3" />
          <h2 className="text-base font-semibold">Could not load conversations</h2>
          <p className="mt-1 text-xs text-muted-foreground max-w-xs">{error}</p>
          <Button size="sm" onClick={fetchConversations} className="mt-4">
            Try Again
          </Button>
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center px-4">
          <MessageCircle className="h-16 w-16 text-muted-foreground/50 mb-4" />
          <h2 className="text-lg font-semibold">No messages yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Start a conversation from someone's profile!
          </p>
        </div>
      ) : (
        <div className="divide-y">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => navigate(`/chat/${c.id}`)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-secondary/50 transition-colors"
            >
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-secondary">
                {getAvatarUrl(c.avatar_url) ? (
                  <img src={getAvatarUrl(c.avatar_url)!} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-lg font-bold text-muted-foreground">
                    {c.username[0]?.toUpperCase()}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{c.username}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.lastMessage ?? "No messages yet"} · {formatDistanceToNow(new Date(c.lastMessageAt), { addSuffix: false })}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </AppLayout>
  );
};

export default Chats;
