import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import {
  GraduationCap,
  Bell,
  Calendar,
  Users,
  Megaphone,
  Clock,
  MapPin,
  ChevronRight,
  Ticket,
  Loader2,
  Sparkles,
  ArrowRight,
  Compass,
  CheckCircle2,
  User,
} from "lucide-react";
import { toast } from "sonner";

interface UpcomingEvent {
  id: string;
  club_id: string;
  title: string;
  venue: string;
  start_time: string;
  club_name: string;
  is_registered: boolean;
  capacity?: number | null;
}

interface AnnouncementNotice {
  id: string;
  club_id: string;
  club_name: string;
  content: string;
  created_at: string;
  sender_name: string;
}

interface FeaturedClub {
  id: string;
  name: string;
  description?: string | null;
  category: string;
  status: string;
}

const CATEGORIES = ["All", "Technical", "Cultural", "Sports", "Arts", "Academic"];

const Index = () => {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  const [events, setEvents] = useState<UpcomingEvent[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementNotice[]>([]);
  const [featuredClubs, setFeaturedClubs] = useState<FeaturedClub[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [loading, setLoading] = useState(true);

  const loadCampusFeed = useCallback(async () => {
    try {
      setLoading(true);

      // 1. Fetch Featured Active Clubs
      const { data: clubsData } = await supabase
        .from("clubs")
        .select("id, name, description, category, status")
        .eq("status", "active")
        .limit(6);

      setFeaturedClubs((clubsData || []) as FeaturedClub[]);

      // 2. Fetch Upcoming Campus Events
      const { data: evData } = await supabase
        .from("events")
        .select(`
          id,
          club_id,
          title,
          venue,
          start_time,
          capacity,
          clubs:club_id (name)
        `)
        .eq("is_published", true)
        .order("start_time", { ascending: true })
        .limit(4);

      let registeredIds = new Set<string>();
      if (user?.id) {
        const { data: regData } = await supabase
          .from("event_registrations")
          .select("event_id")
          .eq("user_id", user.id)
          .eq("status", "registered");

        registeredIds = new Set(((regData || []) as { event_id: string }[]).map((r) => r.event_id));
      }

      const rawEvents = (evData || []) as any[];
      const parsedEvents: UpcomingEvent[] = rawEvents.map((ev) => ({
        id: ev.id,
        club_id: ev.club_id,
        title: ev.title,
        venue: ev.venue,
        start_time: ev.start_time,
        capacity: ev.capacity,
        club_name: ev.clubs?.name || "Campus Club",
        is_registered: registeredIds.has(ev.id),
      }));
      setEvents(parsedEvents);

      // 3. Fetch Official Announcements
      const { data: notices } = await supabase
        .from("channel_messages")
        .select(`
          id,
          content,
          created_at,
          club_channels:channel_id (
            club_id,
            type,
            clubs:club_id (name)
          ),
          profiles:sender_id (username)
        `)
        .order("created_at", { ascending: false })
        .limit(5);

      const rawNotices = (notices || []) as any[];
      const announcementNotices: AnnouncementNotice[] = rawNotices
        .filter((n) => n && n.club_channels && n.club_channels.type === "announcements")
        .map((n) => ({
          id: n.id,
          club_id: n.club_channels.club_id,
          club_name: n.club_channels.clubs?.name || "Campus Club",
          content: n.content,
          created_at: n.created_at,
          sender_name: n.profiles?.username || "Coordinator",
        }));
      setAnnouncements(announcementNotices);
    } catch (err: unknown) {
      console.error("Campus feed error:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadCampusFeed();
  }, [loadCampusFeed]);

  const handleRegisterEvent = async (ev: UpcomingEvent) => {
    if (!user?.id) return;
    try {
      if (ev.is_registered) {
        navigate("/profile");
      } else {
        const { error } = await supabase.rpc("register_for_event", {
          p_event_id: ev.id,
        });
        if (error) throw error;
        toast.success("Successfully registered! Pass added to your profile.");
        loadCampusFeed();
      }
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to register");
    }
  };

  const filteredClubs = selectedCategory === "All"
    ? featuredClubs
    : featuredClubs.filter((c) => c.category === selectedCategory);

  return (
    <AppLayout>
      <div className="min-h-screen bg-background">
        {/* Campus Header */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b bg-background/95 backdrop-blur px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight">CampusConnect</h1>
              <p className="text-[11px] text-muted-foreground">University Community & Activities</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              onClick={() => navigate("/notifications")}
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4 text-foreground" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
              onClick={() => navigate("/profile")}
              title="My Student Profile"
            >
              <User className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-xs">Loading campus activities...</p>
          </div>
        ) : (
          <div className="p-4 space-y-6">
            {/* Campus Community Welcome Hero */}
            <div className="rounded-2xl border bg-gradient-to-br from-primary/10 via-card to-card p-4 shadow-sm relative overflow-hidden">
              <div className="relative z-10 space-y-2">
                <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-0.5 text-[10px] font-semibold text-primary">
                  <Sparkles className="h-3 w-3" />
                  College Club & Event Network
                </div>
                <h2 className="text-lg font-bold tracking-tight text-foreground">
                  What's Happening on Campus
                </h2>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Discover student clubs, attend technical workshops, cultural fests, and stay updated with official notices.
                </p>

                {/* Quick Action Navigation Buttons */}
                <div className="grid grid-cols-3 gap-2 pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate("/clubs")}
                    className="h-8 text-xs rounded-xl flex items-center justify-center gap-1.5 bg-background/80"
                  >
                    <Users className="h-3.5 w-3.5 text-primary" />
                    Clubs
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate("/events")}
                    className="h-8 text-xs rounded-xl flex items-center justify-center gap-1.5 bg-background/80"
                  >
                    <Calendar className="h-3.5 w-3.5 text-primary" />
                    Events
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate("/profile")}
                    className="h-8 text-xs rounded-xl flex items-center justify-center gap-1.5 bg-background/80"
                  >
                    <Ticket className="h-3.5 w-3.5 text-primary" />
                    My Passes
                  </Button>
                </div>
              </div>
            </div>

            {/* Official Campus Notice Board */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Megaphone className="h-4 w-4 text-amber-500" />
                  Official Campus Notices
                </h3>
              </div>

              {announcements.length === 0 ? (
                <div className="p-3.5 rounded-xl border border-dashed text-center text-xs text-muted-foreground">
                  No active broadcasts right now. Check back soon for club notices!
                </div>
              ) : (
                <div className="space-y-2">
                  {announcements.map((notice) => (
                    <Card
                      key={notice.id}
                      onClick={() => navigate(`/club/${notice.club_id}`)}
                      className="border-border/60 hover:border-primary/40 transition-colors cursor-pointer"
                    >
                      <CardContent className="p-3 space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-semibold text-primary">{notice.club_name}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {new Date(notice.created_at).toLocaleDateString([], {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        </div>
                        <p className="text-xs text-foreground leading-relaxed line-clamp-2">
                          {notice.content}
                        </p>
                        <div className="text-[10px] text-muted-foreground pt-0.5">
                          Posted by {notice.sender_name}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {/* Upcoming Campus Events */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Calendar className="h-4 w-4 text-primary" />
                  Upcoming Workshops & Events
                </h3>
                <button
                  onClick={() => navigate("/events")}
                  className="text-xs text-primary font-medium hover:underline flex items-center"
                >
                  View All <ChevronRight className="h-3 w-3" />
                </button>
              </div>

              {events.length === 0 ? (
                <div className="p-3.5 rounded-xl border border-dashed text-center text-xs text-muted-foreground">
                  No upcoming events scheduled. Explore clubs to propose an event!
                </div>
              ) : (
                <div className="space-y-2.5">
                  {events.map((ev) => (
                    <Card key={ev.id} className="border-border/60">
                      <CardHeader className="p-3 pb-1">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="text-[10px] font-semibold text-primary">
                              {ev.club_name}
                            </span>
                            <CardTitle className="text-sm font-bold mt-0.5">{ev.title}</CardTitle>
                          </div>
                          {ev.is_registered && (
                            <Badge variant="secondary" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20 shrink-0">
                              <CheckCircle2 className="h-3 w-3 mr-1" /> Registered
                            </Badge>
                          )}
                        </div>
                      </CardHeader>

                      <CardContent className="p-3 pt-1 pb-2">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3 text-primary shrink-0" />
                            {new Date(ev.start_time).toLocaleDateString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-primary shrink-0" />
                            {ev.venue}
                          </span>
                        </div>
                      </CardContent>

                      <CardFooter className="p-3 pt-0 flex justify-end">
                        <Button
                          size="sm"
                          variant={ev.is_registered ? "secondary" : "default"}
                          onClick={() => handleRegisterEvent(ev)}
                          className="h-7 text-xs font-medium"
                        >
                          {ev.is_registered ? (
                            <span className="flex items-center gap-1">
                              <Ticket className="h-3 w-3" /> View Pass
                            </span>
                          ) : (
                            "Register Now"
                          )}
                        </Button>
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {/* Explore Campus Clubs Section */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Compass className="h-4 w-4 text-primary" />
                  Explore Campus Clubs
                </h3>
                <button
                  onClick={() => navigate("/clubs")}
                  className="text-xs text-primary font-medium hover:underline flex items-center"
                >
                  All Clubs <ChevronRight className="h-3 w-3" />
                </button>
              </div>

              {/* Category Filter Pills */}
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-2.5 py-1 rounded-full text-xs transition-all whitespace-nowrap ${
                      selectedCategory === cat
                        ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                        : "bg-muted/80 text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {filteredClubs.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed text-center text-xs text-muted-foreground">
                  No clubs found in this category.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {filteredClubs.map((club) => (
                    <div
                      key={club.id}
                      onClick={() => navigate(`/club/${club.id}`)}
                      className="p-3 rounded-xl border bg-card hover:border-primary/50 cursor-pointer transition-all flex items-center justify-between group"
                    >
                      <div className="space-y-0.5 min-w-0 pr-2">
                        <Badge variant="secondary" className="text-[9px] mb-0.5">
                          {club.category}
                        </Badge>
                        <p className="text-xs font-bold text-foreground truncate">{club.name}</p>
                        <p className="text-[10px] text-muted-foreground line-clamp-1">
                          {club.description || "Student-led campus community."}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
};

export default Index;
