import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { getAvatarUrl } from "@/lib/supabase-helpers";
import { ArrowLeft, Send } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
}

interface ChatUserProfile {
  id: string;
  username: string;
  avatar_url: string | null;
}

const ChatConversation = () => {
  const { conversationId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [otherUser, setOtherUser] = useState<ChatUserProfile | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!conversationId || !user) return;

    const fetchData = async () => {
      const { data: convo } = await supabase
        .from("conversations")
        .select("*")
        .eq("id", conversationId)
        .maybeSingle();

      if (!convo) return;

      const otherUserId = convo.user1_id === user.id ? convo.user2_id : convo.user1_id;
      const { data: profile } = await supabase
        .from("profiles")
        .select("id, username, avatar_url")
        .eq("id", otherUserId)
        .maybeSingle();
      setOtherUser(profile);

      const { data: msgs } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });
      setMessages((msgs as unknown as ChatMessage[]) ?? []);

      // Mark incoming messages as read in database via secure RPC
      await (supabase.rpc as any)("mark_messages_read", { p_conversation_id: conversationId });
    };

    fetchData();

    // Realtime subscription
    const channel = supabase
      .channel(`messages-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const newMsg = payload.new as ChatMessage;
          setMessages((prev) => [...prev, newMsg]);

          // Automatically mark incoming messages read while active in the chat
          if (newMsg.sender_id !== user.id) {
            await (supabase.rpc as any)("mark_messages_read", { p_conversation_id: conversationId });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!newMessage.trim() || !user || !conversationId || sending) return;
    const content = newMessage.trim();
    setSending(true);

    try {
      const { error: msgErr } = await supabase.from("messages").insert({
        conversation_id: conversationId,
        sender_id: user.id,
        content,
      });

      if (msgErr) throw msgErr;

      setNewMessage("");

      await supabase
        .from("conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", conversationId);
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error?.message || "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const avatarUrl = getAvatarUrl(otherUser?.avatar_url);

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b bg-background/95 backdrop-blur px-4 py-3">
        <button onClick={() => navigate("/chats")}>
          <ArrowLeft className="h-5 w-5" />
        </button>
        {otherUser && (
          <button onClick={() => navigate(`/profile/${otherUser.id}`)} className="flex items-center gap-2">
            <div className="h-8 w-8 overflow-hidden rounded-full bg-secondary">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs font-bold text-muted-foreground">
                  {otherUser.username?.[0]?.toUpperCase()}
                </div>
              )}
            </div>
            <span className="text-sm font-semibold">{otherUser.username}</span>
          </button>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {messages.map((msg) => {
          const isMine = msg.sender_id === user?.id;
          return (
            <div key={msg.id} className={cn("flex", isMine ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[75%] rounded-2xl px-4 py-2 text-sm",
                  isMine
                    ? "bg-primary text-primary-foreground rounded-br-md"
                    : "bg-secondary text-secondary-foreground rounded-bl-md"
                )}
              >
                <p>
                  {/^https?:\/\/.*\/post\//.test(msg.content) ? (
                    <a href={msg.content.match(/\/post\/[^\s]+/)?.[0] ?? msg.content} className="underline">
                      📷 Shared a post
                    </a>
                  ) : (
                    msg.content
                  )}
                </p>
                <p className={cn("mt-1 text-[10px] opacity-60", isMine ? "text-right" : "text-left")}>
                  {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="sticky bottom-0 border-t bg-background px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-center gap-2"
        >
          <Input
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder="Message..."
            className="flex-1 rounded-full bg-secondary border-0"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!newMessage.trim() || sending}
            className="h-10 w-10 shrink-0 rounded-full"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
};

export default ChatConversation;
