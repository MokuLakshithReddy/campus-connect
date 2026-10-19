import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { getAvatarUrl } from "@/lib/supabase-helpers";
import {
  MessageCircle,
  AlertCircle,
  Hash,
  Users,
  Search,
  Megaphone,
  Sparkles,
  ChevronRight,
  Clock,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";

interface ConversationWithProfile {
  type: "dm";
  id: string;
  otherUserId: string;
  username: string;
  avatar_url: string | null;
  lastMessage: string | null;
  lastMessageAt: string;
}

interface ClubChannelItem {
  type: "channel";
  id: string;
  name: string;
  channelType: string;
  clubId: string;
  clubName: string;
  clubLogoUrl: string | null;
  lastMessage: string | null;
  lastMessageAt: string;
  lastSenderName: string | null;
}

type ChatItem = ConversationWithProfile | ClubChannelItem;

const Chats = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<"all" | "dms" | "channels">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [conversations, setConversations] = useState<ConversationWithProfile[]>([]);
  const [channels, setChannels] = useState<ClubChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIdRef = useRef(0);
  const isMountedRef = useRef(true);

  const fetchAllMessages = useCallback(async () => {
    if (!user) return;
    const fetchId = ++fetchIdRef.current;

    try {
      setLoading(true);
      setError(null);

      // =========================================================================
      // 1. Fetch 1-on-1 Direct Messages (Conversations)
      // =========================================================================
      const { data: convos, error: convosErr } = await supabase
        .from("conversations")
        .select("*")
        .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
        .order("last_message_at", { ascending: false });

      if (convosErr) throw convosErr;

      let mappedConvos: ConversationWithProfile[] = [];

      if (convos && convos.length > 0) {
        const otherUserIds = convos.map((c) =>
          c.user1_id === user.id ? c.user2_id : c.user1_id
        );
        const convoIds = convos.map((c) => c.id);

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

        const profileMap = new Map(profilesRes.data?.map((p) => [p.id, p]) ?? []);
        const lastMessageMap = new Map<string, string>();
        if (messagesRes.data) {
          for (const msg of messagesRes.data) {
            if (!lastMessageMap.has(msg.conversation_id)) {
              lastMessageMap.set(msg.conversation_id, msg.content);
            }
          }
        }

        mappedConvos = convos.map((c) => {
          const otherUserId = c.user1_id === user.id ? c.user2_id : c.user1_id;
          const profile = profileMap.get(otherUserId);
          return {
            type: "dm",
            id: c.id,
            otherUserId,
            username: profile?.username ?? "Campus Student",
            avatar_url: profile?.avatar_url ?? null,
            lastMessage: lastMessageMap.get(c.id) ?? null,
            lastMessageAt: c.last_message_at,
          };
        });
      }

      // =========================================================================
      // 2. Fetch User's Active Clubs & Integrated Club Channels
      // =========================================================================
      const { data: memberships, error: memErr } = await supabase
        .from("club_memberships")
        .select("club_id, role")
        .eq("user_id", user.id)
        .eq("status", "active");

      let mappedChannels: ClubChannelItem[] = [];

      if (!memErr && memberships && memberships.length > 0) {
        const clubIds = memberships.map((m) => m.club_id);

        // Fetch clubs and channels in parallel
        const [clubsRes, channelsRes] = await Promise.all([
          supabase
            .from("clubs")
            .select("id, name, logo_url")
            .in("id", clubIds),
          supabase
            .from("club_channels")
            .select("id, club_id, name, type, created_at")
            .in("club_id", clubIds)
            .order("created_at", { ascending: true }),
        ]);

        const clubMap = new Map(clubsRes.data?.map((c) => [c.id, c]) ?? []);
        const allChannels = channelsRes.data || [];

        if (allChannels.length > 0) {
          const channelIds = allChannels.map((ch) => ch.id);

          // Fetch latest channel messages
          const { data: channelMsgs } = await supabase
            .from("channel_messages")
            .select(`
              id,
              channel_id,
              content,
              created_at,
              sender_id,
              profiles:sender_id (
                username
              )
            `)
            .in("channel_id", channelIds)
            .order("created_at", { ascending: false });

          // Map latest message per channel
          const latestChannelMsgMap = new Map<
            string,
            { content: string; createdAt: string; senderName: string }
          >();

          if (channelMsgs) {
            for (const msg of channelMsgs) {
              if (!latestChannelMsgMap.has(msg.channel_id)) {
                const senderProfile = msg.profiles as unknown as { username?: string } | null;
                latestChannelMsgMap.set(msg.channel_id, {
                  content: msg.content,
                  createdAt: msg.created_at,
                  senderName: senderProfile?.username || "Member",
                });
              }
            }
          }

          mappedChannels = allChannels.map((ch) => {
            const club = clubMap.get(ch.club_id);
            const latest = latestChannelMsgMap.get(ch.id);
            return {
              type: "channel",
              id: ch.id,
              name: ch.name,
              channelType: ch.type,
              clubId: ch.club_id,
              clubName: club?.name || "Campus Club",
              clubLogoUrl: club?.logo_url || null,
              lastMessage: latest?.content || null,
              lastMessageAt: latest?.createdAt || ch.created_at,
              lastSenderName: latest?.senderName || null,
            };
          });

          // Sort channels by most recently active
          mappedChannels.sort(
            (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
          );
        }
      }

      if (!isMountedRef.current || fetchId !== fetchIdRef.current) return;

      setConversations(mappedConvos);
      setChannels(mappedChannels);
    } catch (err: unknown) {
      const e = err as Error;
      console.error("Error loading chats and channels:", e);
      if (isMountedRef.current && fetchId === fetchIdRef.current) {
        setError(e.message || "Failed to load chats");
      }
    } finally {
      if (isMountedRef.current && fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [user]);

  useEffect(() => {
    isMountedRef.current = true;
    fetchAllMessages();

    // Debounced realtime subscription for both conversations and channel messages
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const triggerDebouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchAllMessages();
      }, 400);
    };

    const convChannel = supabase
      .channel("inbox-conversations-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, triggerDebouncedFetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "channel_messages" }, triggerDebouncedFetch)
      .subscribe();

    return () => {
      isMountedRef.current = false;
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(convChannel);
    };
  }, [fetchAllMessages]);

  // Aggregate and filter items based on active tab and search query
  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    let items: ChatItem[] = [];
    if (activeTab === "all") {
      items = [...conversations, ...channels].sort(
        (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
      );
    } else if (activeTab === "dms") {
      items = conversations;
    } else {
      items = channels;
    }

    if (!query) return items;

    return items.filter((item) => {
      if (item.type === "dm") {
        return (
          item.username.toLowerCase().includes(query) ||
          (item.lastMessage && item.lastMessage.toLowerCase().includes(query))
        );
      } else {
        return (
          item.name.toLowerCase().includes(query) ||
          item.clubName.toLowerCase().includes(query) ||
          (item.lastMessage && item.lastMessage.toLowerCase().includes(query))
        );
      }
    });
  }, [activeTab, conversations, channels, searchQuery]);

  return (
    <AppLayout>
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur px-4 py-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">Messages & Channels</h1>
          <Badge variant="outline" className="text-xs px-2 py-0.5 font-normal text-muted-foreground">
            {conversations.length} DMs · {channels.length} Channels
          </Badge>
        </div>

        {/* Search bar */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search messages, students, or club channels..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-9 text-xs bg-secondary/50 rounded-lg"
          />
        </div>

        {/* Segmented Filter Tabs */}
        <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as "all" | "dms" | "channels")}>
          <TabsList className="grid w-full grid-cols-3 h-8">
            <TabsTrigger value="all" className="text-xs">
              All ({conversations.length + channels.length})
            </TabsTrigger>
            <TabsTrigger value="dms" className="text-xs">
              Direct ({conversations.length})
            </TabsTrigger>
            <TabsTrigger value="channels" className="text-xs">
              Clubs ({channels.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {/* Content Area */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-20 text-center px-4">
          <AlertCircle className="h-12 w-12 text-destructive mb-3" />
          <h2 className="text-base font-semibold">Could not load messages</h2>
          <p className="mt-1 text-xs text-muted-foreground max-w-xs">{error}</p>
          <Button size="sm" onClick={fetchAllMessages} className="mt-4">
            Try Again
          </Button>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center px-4">
          {activeTab === "channels" ? (
            <>
              <Hash className="h-14 w-14 text-muted-foreground/40 mb-3" />
              <h2 className="text-base font-semibold">No club channels found</h2>
              <p className="mt-1 text-xs text-muted-foreground max-w-xs">
                Join campus clubs to access discussions, announcement channels, and collaborate with members!
              </p>
              <Button size="sm" onClick={() => navigate("/clubs")} className="mt-4 gap-1.5">
                <Users className="h-4 w-4" /> Browse Clubs
              </Button>
            </>
          ) : activeTab === "dms" ? (
            <>
              <MessageCircle className="h-14 w-14 text-muted-foreground/40 mb-3" />
              <h2 className="text-base font-semibold">No direct messages yet</h2>
              <p className="mt-1 text-xs text-muted-foreground max-w-xs">
                Connect with peers and start direct conversations from student profiles or explore.
              </p>
              <Button size="sm" onClick={() => navigate("/explore")} className="mt-4">
                Find Students
              </Button>
            </>
          ) : (
            <>
              <MessageCircle className="h-14 w-14 text-muted-foreground/40 mb-3" />
              <h2 className="text-base font-semibold">No messages found</h2>
              <p className="mt-1 text-xs text-muted-foreground max-w-xs">
                {searchQuery ? "Try searching for a different keyword or name." : "Your campus communication inbox is empty."}
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {filteredItems.map((item) => {
            if (item.type === "dm") {
              // Direct Message Row
              return (
                <button
                  key={`dm-${item.id}`}
                  onClick={() => navigate(`/chat/${item.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-secondary/40 active:bg-secondary/60 transition-colors"
                >
                  <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full bg-secondary border border-border">
                    {getAvatarUrl(item.avatar_url) ? (
                      <img
                        src={getAvatarUrl(item.avatar_url)!}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-base font-bold text-muted-foreground">
                        {item.username[0]?.toUpperCase()}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-sm font-semibold text-foreground truncate">
                        {item.username}
                      </p>
                      <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                        {formatDistanceToNow(new Date(item.lastMessageAt), { addSuffix: false })}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.lastMessage ?? "Conversation opened · Say hello!"}
                    </p>
                  </div>
                </button>
              );
            } else {
              // Club Channel Row
              const isAnnouncement = item.channelType === "announcements";
              return (
                <button
                  key={`channel-${item.id}`}
                  onClick={() => navigate(`/club/${item.clubId}?channel=${item.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-secondary/40 active:bg-secondary/60 transition-colors"
                >
                  <div className="relative h-12 w-12 shrink-0 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold overflow-hidden">
                    {item.clubLogoUrl ? (
                      <img
                        src={getAvatarUrl(item.clubLogoUrl)!}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : isAnnouncement ? (
                      <Megaphone className="h-5 w-5 text-primary" />
                    ) : (
                      <Hash className="h-5 w-5 text-primary" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between mb-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-semibold text-foreground truncate">
                          {item.clubName}
                        </span>
                        <Badge
                          variant="secondary"
                          className="h-4 px-1.5 text-[9px] font-mono tracking-tight shrink-0 gap-0.5"
                        >
                          #{item.name}
                        </Badge>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                        {formatDistanceToNow(new Date(item.lastMessageAt), { addSuffix: false })}
                      </span>
                    </div>

                    <p className="truncate text-xs text-muted-foreground">
                      {item.lastMessage ? (
                        <>
                          <span className="font-medium text-foreground/80">
                            {item.lastSenderName || "Member"}:{" "}
                          </span>
                          {item.lastMessage}
                        </>
                      ) : (
                        <span className="italic text-muted-foreground/80">
                          {isAnnouncement ? "Official club broadcast channel" : "Club discussion channel"}
                        </span>
                      )}
                    </p>
                  </div>
                </button>
              );
            }
          })}
        </div>
      )}
    </AppLayout>
  );
};

export default Chats;
