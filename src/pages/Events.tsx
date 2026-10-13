import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Calendar,
  Clock,
  MapPin,
  Search,
  Users,
  QrCode,
  Ticket,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { CampusEvent, EventRegistration, RegisterEventResult } from "@/types/campus";

interface EventItemWithMeta extends CampusEvent {
  club_name: string;
  club_category: string;
  registration_count: number;
  is_registered: boolean;
  qr_code_token?: string;
}

const Events = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [events, setEvents] = useState<EventItemWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "registered">("all");
  const [selectedTicket, setSelectedTicket] = useState<EventItemWithMeta | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);

      // Fetch published public events with club info
      const { data: evData, error: evErr } = await supabase
        .from("events")
        .select(`
          *,
          clubs:club_id (
            name,
            category
          )
        `)
        .eq("is_published", true)
        .order("start_time", { ascending: true });

      if (evErr) throw evErr;

      const rawEvents = (evData || []) as any[];
      const eventIds = rawEvents.map((ev) => ev.id);
      const registrationCounts = new Map<string, number>();

      if (eventIds.length > 0) {
        const { data: statsData, error: statsError } = await supabase.rpc("get_event_registration_stats", {
          p_event_ids: eventIds,
        });
        if (statsError) throw statsError;
        for (const stat of statsData || []) {
          registrationCounts.set(stat.event_id, Number(stat.registration_count));
        }
      }

      const { data: regData, error: regError } = await supabase
        .from("event_registrations")
        .select("event_id, user_id, qr_code_token, status")
        .eq("user_id", user?.id || "");
      if (regError) throw regError;
      const userRegs = (regData || []) as unknown as EventRegistration[];

      const enriched: EventItemWithMeta[] = rawEvents.map((ev) => {
        const userReg = userRegs.find((r) => r.event_id === ev.id && r.status === "registered");

        return {
          id: ev.id,
          club_id: ev.club_id,
          title: ev.title,
          description: ev.description,
          poster_url: ev.poster_url,
          venue: ev.venue,
          start_time: ev.start_time,
          end_time: ev.end_time,
          capacity: ev.capacity,
          is_published: ev.is_published,
          created_by: ev.created_by,
          created_at: ev.created_at,
          club_name: ev.clubs?.name || "Campus Club",
          club_category: ev.clubs?.category || "Activity",
          registration_count: registrationCounts.get(ev.id) || 0,
          is_registered: !!userReg,
          qr_code_token: userReg?.qr_code_token,
        };
      });

      setEvents(enriched);
    } catch (err: unknown) {
      const error = err as Error;
      console.error("Error loading events:", error);
      toast.error("Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Atomic event registration via stored procedure
  const handleRegisterToggle = async (ev: EventItemWithMeta) => {
    if (!user?.id) return;
    try {
      if (ev.is_registered) {
        const { error } = await supabase.rpc("cancel_event_registration", {
          p_event_id: ev.id,
        });
        if (error) throw error;
        toast.info(`Cancelled registration for ${ev.title}`);
        if (selectedTicket?.id === ev.id) setSelectedTicket(null);
      } else {
        const { data, error } = await supabase.rpc("register_for_event", {
          p_event_id: ev.id,
        });
        if (error) throw error;
        const result = data as unknown as RegisterEventResult;
        if (result.success) {
          toast.success("Successfully registered! Ticket pass generated.");
        }
      }
      fetchEvents();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to update registration");
    }
  };

  const filteredEvents = events.filter((ev) => {
    const matchesTab = tab === "all" || (tab === "registered" && ev.is_registered);
    const matchesSearch =
      ev.title.toLowerCase().includes(search.toLowerCase()) ||
      ev.venue.toLowerCase().includes(search.toLowerCase()) ||
      ev.club_name.toLowerCase().includes(search.toLowerCase());
    return matchesTab && matchesSearch;
  });

  return (
    <AppLayout>
      <div className="min-h-screen bg-background">
        {/* Sticky Header */}
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">Campus Events</h1>
              <p className="text-xs text-muted-foreground">Workshops, hackathons, guest lectures & club meetups</p>
            </div>
          </div>

          {/* Search bar */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search by event, club, or venue..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9 text-sm"
            />
          </div>

          {/* Tab Filter */}
          <div className="grid grid-cols-2 gap-2 mt-3 p-1 bg-muted/60 rounded-lg">
            <button
              onClick={() => setTab("all")}
              className={`py-1.5 text-xs font-medium rounded-md transition-all ${
                tab === "all" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              All Events ({events.length})
            </button>
            <button
              onClick={() => setTab("registered")}
              className={`py-1.5 text-xs font-medium rounded-md transition-all ${
                tab === "registered" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              My Tickets ({events.filter((e) => e.is_registered).length})
            </button>
          </div>
        </header>

        {/* Event List */}
        <div className="p-4 space-y-3">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-xs">Loading campus events...</p>
            </div>
          ) : filteredEvents.length === 0 ? (
            <div className="text-center py-12 px-4 rounded-xl border border-dashed text-muted-foreground">
              <Calendar className="mx-auto h-10 w-10 opacity-40 mb-2" />
              <p className="font-semibold text-sm">
                {tab === "registered" ? "No registered events yet" : "No upcoming events found"}
              </p>
              <p className="text-xs mt-1">
                {tab === "registered" ? "Browse 'All Events' to register for upcoming workshops!" : "Try adjusting your search query."}
              </p>
            </div>
          ) : (
            filteredEvents.map((ev) => {
              const eventDate = new Date(ev.start_time);
              const isFull = ev.capacity ? ev.registration_count >= ev.capacity : false;

              return (
                <Card key={ev.id} className="border-border/60 hover:border-primary/40 transition-all">
                  <CardHeader className="p-4 pb-2 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge variant="outline" className="text-[10px] font-medium text-primary border-primary/30">
                            {ev.club_name}
                          </Badge>
                          <Badge variant="secondary" className="text-[10px]">
                            {ev.club_category}
                          </Badge>
                        </div>
                        <CardTitle className="text-base font-semibold leading-snug">
                          {ev.title}
                        </CardTitle>
                      </div>

                      {/* Registration action */}
                      {ev.is_registered ? (
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="default"
                            onClick={() => setSelectedTicket(ev)}
                            className="h-7 text-xs rounded-full gap-1 bg-emerald-600 hover:bg-emerald-700"
                          >
                            <Ticket className="h-3.5 w-3.5" /> Ticket
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          disabled={isFull}
                          onClick={() => handleRegisterToggle(ev)}
                          className="h-7 text-xs rounded-full shrink-0"
                        >
                          {isFull ? "Full" : "Register"}
                        </Button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-1">
                      <span className="flex items-center gap-1 font-medium text-foreground">
                        <Clock className="h-3.5 w-3.5 text-primary" />
                        {eventDate.toLocaleDateString([], { month: "short", day: "numeric" })},{" "}
                        {eventDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="flex items-center gap-1 truncate">
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{ev.venue}</span>
                      </span>
                    </div>
                  </CardHeader>

                  {ev.description && (
                    <CardContent className="p-4 pt-1 text-xs text-muted-foreground line-clamp-2">
                      {ev.description}
                    </CardContent>
                  )}

                  <CardFooter className="p-4 pt-2 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      {ev.registration_count} {ev.capacity ? `/ ${ev.capacity}` : ""} Registered
                    </span>
                    <button
                      onClick={() => navigate(`/club/${ev.club_id}`)}
                      className="text-primary hover:underline font-medium"
                    >
                      View Club Workspace →
                    </button>
                  </CardFooter>
                </Card>
              );
            })
          )}
        </div>

        {/* Digital Campus Pass / QR Ticket Dialog */}
        <Dialog open={!!selectedTicket} onOpenChange={(open) => !open && setSelectedTicket(null)}>
          <DialogContent className="max-w-xs sm:max-w-sm rounded-2xl p-6 text-center">
            {selectedTicket && (
              <div className="space-y-4">
                <div className="flex items-center justify-center">
                  <div className="h-12 w-12 rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400 flex items-center justify-center">
                    <CheckCircle2 className="h-7 w-7" />
                  </div>
                </div>

                <div>
                  <Badge variant="outline" className="text-[10px] text-primary border-primary/30">
                    {selectedTicket.club_name}
                  </Badge>
                  <h3 className="text-base font-bold text-foreground mt-1">{selectedTicket.title}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Official Campus Event Pass</p>
                </div>

                {/* QR Code Container */}
                <div className="p-4 bg-muted/60 rounded-xl border border-border/60 flex flex-col items-center justify-center gap-2">
                  <div className="p-3 bg-white rounded-lg shadow-sm">
                    <QrCode className="h-28 w-28 text-black" />
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground tracking-wider">
                    PASS ID: {selectedTicket.qr_code_token?.slice(0, 8).toUpperCase() || "CAMPUS-2026"}
                  </span>
                </div>

                <div className="text-xs text-left space-y-1.5 p-3 rounded-lg bg-background border text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Venue:</span>
                    <span className="font-medium text-foreground">{selectedTicket.venue}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Time:</span>
                    <span className="font-medium text-foreground">
                      {new Date(selectedTicket.start_time).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRegisterToggle(selectedTicket)}
                  className="w-full text-xs text-destructive hover:bg-destructive/10"
                >
                  Cancel Registration
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
};

export default Events;
