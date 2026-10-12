import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ArrowLeft,
  Megaphone,
  MessageSquare,
  Calendar,
  Users,
  Send,
  Pin,
  Plus,
  ShieldCheck,
  GraduationCap,
  Loader2,
  Clock,
  MapPin,
  UserCheck,
  UserX,
  QrCode,
  CheckCircle2,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Club,
  ClubMembership,
  ClubChannel,
  ChannelMessage,
  CampusEvent,
  EventRegistration,
  StudentProfile,
  RegisterEventResult,
  CheckInResult,
} from "@/types/campus";

interface MemberWithProfile extends ClubMembership {
  username: string;
  avatar_url: string | null;
  department: string | null;
  year: string | null;
}

interface EventWithMeta extends CampusEvent {
  registration_count: number | null;
  is_registered: boolean;
}

const ClubWorkspace = () => {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [club, setClub] = useState<Club | null>(null);
  const [membership, setMembership] = useState<ClubMembership | null>(null);
  const [channels, setChannels] = useState<ClubChannel[]>([]);
  const [activeMembers, setActiveMembers] = useState<MemberWithProfile[]>([]);
  const [pendingMembers, setPendingMembers] = useState<MemberWithProfile[]>([]);
  const [events, setEvents] = useState<EventWithMeta[]>([]);
  const [userProfile, setUserProfile] = useState<StudentProfile | null>(null);

  // Active channel state
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [loading, setLoading] = useState(true);

  // Modals
  const [isNewEventOpen, setIsNewEventOpen] = useState(false);
  const [eventTitle, setEventTitle] = useState("");
  const [eventDesc, setEventDesc] = useState("");
  const [eventVenue, setEventVenue] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventCapacity, setEventCapacity] = useState("");
  const [creatingEvent, setCreatingEvent] = useState(false);

  // Announcement modal
  const [isAnnouncementOpen, setIsAnnouncementOpen] = useState(false);
  const [announcementText, setAnnouncementText] = useState("");
  const [publishingNotice, setPublishingNotice] = useState(false);

  // Attendance check-in modal
  const [checkInEventId, setCheckInEventId] = useState<string | null>(null);
  const [qrTokenInput, setQrTokenInput] = useState("");
  const [checkingIn, setCheckingIn] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isPresident = membership?.role === "president" && membership?.status === "active";
  const isOrganizer = (membership?.role === "president" || membership?.role === "organizer") && membership?.status === "active";
  const isActiveMember = membership?.status === "active";
  const isPendingMember = membership?.status === "pending";
  const isAdmin = userProfile?.college_role === "college_admin";

  const loadClubData = useCallback(async () => {
    if (!clubId) return;
    try {
      setLoading(true);

      // 1. Fetch User Profile
      if (user?.id) {
        const { data: prof } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .maybeSingle();
        if (prof) setUserProfile(prof as unknown as StudentProfile);
      }

      // 2. Fetch Club
      const { data: cData, error: cErr } = await supabase
        .from("clubs")
        .select("*")
        .eq("id", clubId)
        .single();
      if (cErr) throw cErr;
      setClub(cData as unknown as Club);

      // 3. Fetch User Membership
      if (user?.id) {
        const { data: mData, error: mErr } = await supabase
          .from("club_memberships")
          .select("*")
          .eq("club_id", clubId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (mErr) console.warn("Could not load user club membership:", mErr.message);
        setMembership((mData as unknown as ClubMembership) || null);
      }

      // 4. Fetch Channels
      const { data: chData, error: chErr } = await supabase
        .from("club_channels")
        .select("*")
        .eq("club_id", clubId)
        .order("created_at", { ascending: true });

      if (chErr) throw chErr;

      const chList = (chData || []) as unknown as ClubChannel[];
      setChannels(chList);
      if (chList.length > 0 && !selectedChannelId) {
        const defaultCh = chList.find((c) => c.type === "announcements") || chList[0];
        setSelectedChannelId(defaultCh.id);
      }

      // 5. Fetch Members (active and pending)
      const { data: memData, error: memErr } = await supabase
        .from("club_memberships")
        .select(`
          id,
          club_id,
          user_id,
          role,
          status,
          joined_at,
          profiles:user_id (
            username,
            avatar_url,
            department,
            year
          )
        `)
        .eq("club_id", clubId);

      if (memErr) throw memErr;

      if (memData) {
        const parsedMembers: MemberWithProfile[] = memData.map((m: any) => ({
          id: m.id,
          club_id: m.club_id,
          user_id: m.user_id,
          role: m.role,
          status: m.status,
          joined_at: m.joined_at,
          username: m.profiles?.username || "Student",
          avatar_url: m.profiles?.avatar_url || null,
          department: m.profiles?.department || null,
          year: m.profiles?.year || null,
        }));

        setActiveMembers(parsedMembers.filter((m) => m.status === "active"));
        setPendingMembers(parsedMembers.filter((m) => m.status === "pending"));
      }

      // 6. Fetch Events & Registrations
      const { data: evData, error: evErr } = await supabase
        .from("events")
        .select("*")
        .eq("club_id", clubId)
        .order("start_time", { ascending: true });

      if (evErr) throw evErr;

      if (evData) {
        const rawEvents = evData as unknown as CampusEvent[];
        const eventIds = rawEvents.map((ev) => ev.id);
        const registrationCounts = new Map<string, number>();
        let statsLoaded = false;

        if (eventIds.length > 0) {
          const { data: statsData, error: statsErr } = await supabase.rpc("get_event_registration_stats", {
            p_event_ids: eventIds,
          });
          if (statsErr) {
            console.warn("Could not load event registration statistics:", statsErr.message);
          } else if (statsData) {
            statsLoaded = true;
            for (const stat of statsData) {
              registrationCounts.set(stat.event_id, Number(stat.registration_count));
            }
          }
        }

        let myRegs: EventRegistration[] = [];
        if (user?.id) {
          const { data: regData, error: regErr } = await supabase
            .from("event_registrations")
            .select("event_id, user_id, status")
            .eq("user_id", user.id);
          if (regErr) console.warn("Could not load user registrations:", regErr.message);
          myRegs = (regData || []) as unknown as EventRegistration[];
        }

        const enrichedEvents: EventWithMeta[] = rawEvents.map((ev) => {
          const isUserReg = myRegs.some((r) => r.event_id === ev.id && r.status === "registered");
          return {
            ...ev,
            registration_count: statsLoaded ? (registrationCounts.get(ev.id) || 0) : null,
            is_registered: isUserReg,
          };
        });
        setEvents(enrichedEvents);
      }
    } catch (err: unknown) {
      const error = err as Error;
      console.error("Error loading club:", error);
      toast.error("Could not load club details");
    } finally {
      setLoading(false);
    }
  }, [clubId, user?.id, selectedChannelId]);

  const loadChannelMessages = useCallback(async (channelId: string) => {
    if (!channelId) return;
    try {
      const { data, error } = await supabase
        .from("channel_messages")
        .select(`
          id,
          channel_id,
          sender_id,
          content,
          is_pinned,
          created_at,
          profiles:sender_id (
            username,
            avatar_url,
            department
          )
        `)
        .eq("channel_id", channelId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      const parsed: ChannelMessage[] = (data || []).map((m: any) => ({
        id: m.id,
        channel_id: m.channel_id,
        sender_id: m.sender_id,
        content: m.content,
        is_pinned: m.is_pinned,
        created_at: m.created_at,
        sender: {
          id: m.sender_id,
          username: m.profiles?.username || "Student",
          avatar_url: m.profiles?.avatar_url || null,
          department: m.profiles?.department || null,
        },
      }));
      setMessages(parsed);
    } catch (err: unknown) {
      console.error("Error loading messages:", err);
    }
  }, []);

  useEffect(() => {
    loadClubData();
  }, [loadClubData]);

  useEffect(() => {
    if (selectedChannelId && (isActiveMember || isAdmin)) {
      loadChannelMessages(selectedChannelId);

      const sub = supabase
        .channel(`workspace_channel_${selectedChannelId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "channel_messages",
            filter: `channel_id=eq.${selectedChannelId}`,
          },
          () => {
            loadChannelMessages(selectedChannelId);
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(sub);
      };
    }
  }, [selectedChannelId, isActiveMember, isAdmin, loadChannelMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.id || !newMessage.trim() || !selectedChannelId) return;

    try {
      setSendingMessage(true);
      const { error } = await supabase
        .from("channel_messages")
        .insert({
          channel_id: selectedChannelId,
          sender_id: user.id,
          content: newMessage.trim(),
        });

      if (error) throw error;
      setNewMessage("");
      loadChannelMessages(selectedChannelId);
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to post. Check membership permissions.");
    } finally {
      setSendingMessage(false);
    }
  };

  const handlePublishAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.id || !announcementText.trim()) return;

    const announcementsCh = channels.find((c) => c.type === "announcements");
    if (!announcementsCh) {
      toast.error("Announcements channel not found");
      return;
    }

    try {
      setPublishingNotice(true);
      const { error } = await supabase
        .from("channel_messages")
        .insert({
          channel_id: announcementsCh.id,
          sender_id: user.id,
          content: announcementText.trim(),
          is_pinned: true,
        });

      if (error) throw error;
      toast.success("Official notice broadcasted to all club members!");
      setAnnouncementText("");
      setIsAnnouncementOpen(false);
      setSelectedChannelId(announcementsCh.id);
      loadChannelMessages(announcementsCh.id);
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to broadcast notice");
    } finally {
      setPublishingNotice(false);
    }
  };

  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clubId || !user?.id || !eventTitle.trim() || !eventVenue.trim() || !eventDate) return;

    try {
      setCreatingEvent(true);
      const { error } = await supabase
        .from("events")
        .insert({
          club_id: clubId,
          title: eventTitle.trim(),
          description: eventDesc.trim() || null,
          venue: eventVenue.trim(),
          start_time: new Date(eventDate).toISOString(),
          capacity: eventCapacity ? parseInt(eventCapacity, 10) : null,
          is_published: true,
          created_by: user.id,
        });

      if (error) throw error;
      toast.success("Event scheduled and published!");
      setIsNewEventOpen(false);
      setEventTitle("");
      setEventDesc("");
      setEventVenue("");
      setEventDate("");
      setEventCapacity("");
      loadClubData();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to create event");
    } finally {
      setCreatingEvent(false);
    }
  };

  // Membership request actions via secure RPCs
  const handleApproveMember = async (targetMemId: string, studentName: string) => {
    try {
      const { error } = await supabase.rpc("approve_club_membership", {
        p_membership_id: targetMemId,
      });

      if (error) throw error;
      toast.success(`Approved ${studentName}'s membership!`);
      loadClubData();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to approve membership");
    }
  };

  const handleRejectMember = async (targetMemId: string, studentName: string) => {
    try {
      const { error } = await supabase.rpc("reject_club_membership", {
        p_membership_id: targetMemId,
      });

      if (error) throw error;
      toast.info(`Rejected ${studentName}'s request.`);
      loadClubData();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to reject membership");
    }
  };

  const handlePromoteToOrganizer = async (targetMemId: string, studentName: string) => {
    try {
      const { error } = await supabase.rpc("appoint_club_organizer", {
        p_membership_id: targetMemId,
      });

      if (error) throw error;
      toast.success(`${studentName} appointed as Club Organizer!`);
      loadClubData();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to promote member");
    }
  };

  // Atomic event registration via PostgreSQL stored procedure
  const handleRegisterEventAtomic = async (ev: EventWithMeta) => {
    if (!user?.id) return;
    try {
      if (ev.is_registered) {
        const { data, error } = await supabase.rpc("cancel_event_registration", {
          p_event_id: ev.id,
        });
        if (error) throw error;
        toast.info("Registration cancelled.");
      } else {
        const { data, error } = await supabase.rpc("register_for_event", {
          p_event_id: ev.id,
        });
        if (error) throw error;
        const result = data as unknown as RegisterEventResult;
        if (result.success) {
          toast.success("Successfully registered! Digital Pass issued.");
        }
      }
      loadClubData();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Registration failed");
    }
  };

  // Server-validated QR ticket check-in for organizers
  const handleCheckInAttendee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkInEventId || !qrTokenInput.trim()) return;

    try {
      setCheckingIn(true);
      const { data, error } = await supabase.rpc("check_in_event_attendee", {
        p_event_id: checkInEventId,
        p_qr_token: qrTokenInput.trim(),
      });

      if (error) throw error;
      const result = data as unknown as CheckInResult;
      if (result.success) {
        toast.success(`Check-in verified! Welcome ${result.attendee_name || "attendee"}.`);
        setQrTokenInput("");
        setCheckInEventId(null);
      }
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Invalid ticket or check-in failed");
    } finally {
      setCheckingIn(false);
    }
  };

  const handleToggleJoin = async () => {
    if (!clubId || !user?.id) return;
    try {
      if (membership) {
        await supabase
          .from("club_memberships")
          .delete()
          .match({ club_id: clubId, user_id: user.id });
        toast.success(`Membership updated.`);
        setMembership(null);
      } else {
        await supabase
          .from("club_memberships")
          .insert({
            club_id: clubId,
            user_id: user.id,
            role: "member",
            status: "pending",
          });
        toast.success(`Join request submitted to ${club?.name} organizers!`);
        setMembership({
          id: "",
          club_id: clubId,
          user_id: user.id,
          role: "member",
          status: "pending",
          joined_at: new Date().toISOString(),
        });
      }
      loadClubData();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to submit request");
    }
  };

  if (loading || !club) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[70vh] gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm">Loading club workspace...</p>
        </div>
      </AppLayout>
    );
  }

  const activeChannel = channels.find((c) => c.id === selectedChannelId);

  return (
    <AppLayout>
      <div className="min-h-screen bg-background">
        {/* Top Navbar */}
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              onClick={() => navigate("/clubs")}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="leading-tight">
              <h1 className="text-base font-bold text-foreground truncate max-w-[200px]">
                {club.name}
              </h1>
              <p className="text-[11px] text-muted-foreground">{club.category}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={isActiveMember ? "outline" : isPendingMember ? "secondary" : "default"}
              onClick={handleToggleJoin}
              className="h-7 text-xs rounded-full px-3"
            >
              {isActiveMember ? "Joined" : isPendingMember ? "Requested ⏳" : "Request Join"}
            </Button>
          </div>
        </header>

        {/* Club Hero Card */}
        <div className="p-4 bg-muted/30 border-b space-y-3">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-lg font-bold">{club.name}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {club.category}
                </Badge>
                {membership?.role && (
                  <Badge className="bg-primary/10 text-primary hover:bg-primary/20 border-primary/20 text-[10px] capitalize">
                    <ShieldCheck className="h-3 w-3 mr-1" />
                    {membership.role} ({membership.status})
                  </Badge>
                )}
              </div>
              {club.description && (
                <p className="text-xs text-muted-foreground leading-relaxed pt-1">
                  {club.description}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
            <span className="flex items-center gap-1 font-medium text-foreground">
              <Users className="h-3.5 w-3.5 text-primary" /> {activeMembers.length} Members
            </span>
            {club.faculty_coordinator && (
              <span className="flex items-center gap-1">
                <GraduationCap className="h-3.5 w-3.5" /> Advisor: {club.faculty_coordinator}
              </span>
            )}
          </div>

          {/* Pending Membership Notice */}
          {isPendingMember && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-xs flex items-center gap-2">
              <Clock className="h-4 w-4 shrink-0" />
              <span>Your membership request is pending approval by club organizers.</span>
            </div>
          )}

          {/* Organizer Quick Actions */}
          {(isOrganizer || isAdmin) && (
            <div className="flex items-center gap-2 pt-2 border-t border-border/50 flex-wrap">
              <Dialog open={isAnnouncementOpen} onOpenChange={setIsAnnouncementOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 rounded-full">
                    <Megaphone className="h-3.5 w-3.5 text-primary" /> Broadcast Notice
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Broadcast Official Club Notice</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handlePublishAnnouncement} className="space-y-3 pt-2">
                    <Textarea
                      placeholder="Write important notice or agenda for all active club members..."
                      rows={4}
                      value={announcementText}
                      onChange={(e) => setAnnouncementText(e.target.value)}
                      required
                    />
                    <Button type="submit" className="w-full" disabled={publishingNotice}>
                      {publishingNotice ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : "Post Notice"}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>

              <Dialog open={isNewEventOpen} onOpenChange={setIsNewEventOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 rounded-full">
                    <Plus className="h-3.5 w-3.5 text-primary" /> Add Event
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Schedule Campus Event or Workshop</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleCreateEvent} className="space-y-3 pt-2">
                    <div className="space-y-1">
                      <Label htmlFor="ev-title">Event Title</Label>
                      <Input
                        id="ev-title"
                        placeholder="e.g. AI Vision Bootcamp"
                        value={eventTitle}
                        onChange={(e) => setEventTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="ev-venue">Venue / Location</Label>
                      <Input
                        id="ev-venue"
                        placeholder="e.g. Seminar Hall 3, Block A"
                        value={eventVenue}
                        onChange={(e) => setEventVenue(e.target.value)}
                        required
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="ev-date">Date & Time</Label>
                        <Input
                          id="ev-date"
                          type="datetime-local"
                          value={eventDate}
                          onChange={(e) => setEventDate(e.target.value)}
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="ev-cap">Seat Capacity Limit</Label>
                        <Input
                          id="ev-cap"
                          type="number"
                          placeholder="e.g. 80"
                          value={eventCapacity}
                          onChange={(e) => setEventCapacity(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="ev-desc">Description & Prerequisites</Label>
                      <Textarea
                        id="ev-desc"
                        placeholder="Workshop topics, hands-on tasks..."
                        rows={3}
                        value={eventDesc}
                        onChange={(e) => setEventDesc(e.target.value)}
                      />
                    </div>
                    <Button type="submit" className="w-full" disabled={creatingEvent}>
                      {creatingEvent ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : "Publish Event"}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          )}
        </div>

        {/* Club Navigation Tabs */}
        <Tabs defaultValue="channels" className="w-full">
          <TabsList className="w-full justify-start rounded-none border-b bg-background px-4 h-11 gap-3 overflow-x-auto scrollbar-none">
            <TabsTrigger value="channels" className="text-xs gap-1 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none">
              <MessageSquare className="h-3.5 w-3.5" /> Channels
            </TabsTrigger>
            <TabsTrigger value="events" className="text-xs gap-1 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none">
              <Calendar className="h-3.5 w-3.5" /> Events ({events.length})
            </TabsTrigger>
            <TabsTrigger value="members" className="text-xs gap-1 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none">
              <Users className="h-3.5 w-3.5" /> Members ({activeMembers.length})
            </TabsTrigger>
            {(isOrganizer || isAdmin) && (
              <TabsTrigger value="requests" className="text-xs gap-1 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none">
                <Clock className="h-3.5 w-3.5 text-amber-500" /> Requests ({pendingMembers.length})
              </TabsTrigger>
            )}
          </TabsList>

          {/* TAB 1: CHANNELS */}
          <TabsContent value="channels" className="m-0 p-0">
            {!isActiveMember && !isAdmin ? (
              <div className="p-8 text-center text-muted-foreground space-y-3">
                <Lock className="mx-auto h-10 w-10 opacity-40 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">Private Club Space</h3>
                <p className="text-xs max-w-xs mx-auto">
                  Channel discussions are reserved for approved members. Request membership above to participate.
                </p>
              </div>
            ) : (
              <>
                {/* Channel Switcher */}
                <div className="flex gap-1.5 overflow-x-auto p-3 border-b bg-muted/20 scrollbar-none">
                  {channels.map((ch) => (
                    <Button
                      key={ch.id}
                      size="sm"
                      variant={selectedChannelId === ch.id ? "default" : "outline"}
                      onClick={() => setSelectedChannelId(ch.id)}
                      className="h-7 text-xs rounded-full gap-1.5 whitespace-nowrap px-3"
                    >
                      {ch.type === "announcements" ? <Megaphone className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
                      <span>#{ch.name}</span>
                    </Button>
                  ))}
                </div>

                {/* Messages Feed */}
                <div className="flex flex-col h-[calc(100vh-340px)]">
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {messages.length === 0 ? (
                      <div className="text-center py-12 text-muted-foreground">
                        <p className="text-sm font-medium">No messages in #{activeChannel?.name || "channel"} yet.</p>
                        <p className="text-xs mt-1">Be the first to start the conversation!</p>
                      </div>
                    ) : (
                      messages.map((msg) => {
                        const isMe = msg.sender_id === user?.id;
                        return (
                          <div
                            key={msg.id}
                            className={`flex gap-2.5 ${isMe ? "flex-row-reverse" : "flex-row"}`}
                          >
                            <Avatar className="h-7 w-7 mt-0.5">
                              <AvatarImage src={msg.sender?.avatar_url || undefined} />
                              <AvatarFallback className="text-[10px]">
                                {msg.sender?.username.slice(0, 2).toUpperCase() || "ST"}
                              </AvatarFallback>
                            </Avatar>

                            <div className={`max-w-[80%] space-y-1 ${isMe ? "items-end" : "items-start"}`}>
                              <div className={`flex items-center gap-1.5 text-[11px] ${isMe ? "justify-end" : "justify-start"}`}>
                                <span className="font-semibold text-foreground">{msg.sender?.username}</span>
                                {msg.is_pinned && (
                                  <Badge variant="outline" className="text-[9px] h-4 gap-0.5 text-amber-500 border-amber-500/30">
                                    <Pin className="h-2.5 w-2.5" /> Pinned
                                  </Badge>
                                )}
                              </div>

                              <div
                                className={`p-2.5 rounded-2xl text-xs leading-relaxed ${
                                  isMe
                                    ? "bg-primary text-primary-foreground rounded-tr-none"
                                    : "bg-muted text-foreground rounded-tl-none border border-border/40"
                                }`}
                              >
                                {msg.content}
                              </div>
                              <span className={`block text-[10px] text-muted-foreground px-1 ${isMe ? "text-right" : "text-left"}`}>
                                {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Input bar */}
                  {activeChannel?.type === "announcements" && !isOrganizer && !isAdmin ? (
                    <div className="p-3 border-t bg-muted/40 text-center text-xs text-muted-foreground">
                      🔒 Only authorized club organizers can broadcast notices in this announcement channel.
                    </div>
                  ) : (
                    <form onSubmit={handleSendMessage} className="p-3 border-t bg-background flex items-center gap-2">
                      <Input
                        placeholder={`Message #${activeChannel?.name || "chat"}...`}
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        className="h-9 text-xs"
                        disabled={sendingMessage}
                      />
                      <Button type="submit" size="icon" className="h-9 w-9 rounded-full shrink-0" disabled={sendingMessage || !newMessage.trim()}>
                        <Send className="h-4 w-4" />
                      </Button>
                    </form>
                  )}
                </div>
              </>
            )}
          </TabsContent>

          {/* TAB 2: EVENTS */}
          <TabsContent value="events" className="p-4 space-y-3">
            {events.length === 0 ? (
              <div className="text-center py-10 border border-dashed rounded-xl text-muted-foreground">
                <Calendar className="h-8 w-8 mx-auto opacity-40 mb-2" />
                <p className="text-xs">No upcoming events scheduled for this club.</p>
              </div>
            ) : (
              events.map((ev) => (
                <Card key={ev.id} className="border-border/60">
                  <CardHeader className="p-4 pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-sm font-semibold">{ev.title}</CardTitle>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                          <span className="flex items-center gap-1 text-primary font-medium">
                            <Clock className="h-3 w-3" />
                            {new Date(ev.start_time).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {ev.venue}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {isOrganizer && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setCheckInEventId(ev.id)}
                            className="h-7 text-xs rounded-full gap-1"
                          >
                            <QrCode className="h-3.5 w-3.5" /> Check-in
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant={ev.is_registered ? "outline" : "default"}
                          onClick={() => handleRegisterEventAtomic(ev)}
                          className="h-7 text-xs rounded-full"
                        >
                          {ev.is_registered ? "Registered ✓" : "Register"}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  {ev.description && (
                    <CardContent className="p-4 pt-0 text-xs text-muted-foreground">
                      {ev.description}
                    </CardContent>
                  )}
                  <CardFooter className="p-4 pt-2 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      {ev.registration_count !== null ? (
                        <span>
                          {ev.registration_count} {ev.capacity ? `/ ${ev.capacity}` : ""} Registered
                        </span>
                      ) : (
                        <span className="text-amber-500 font-medium">Count unavailable</span>
                      )}
                    </span>
                    {ev.capacity && ev.registration_count !== null && ev.registration_count >= ev.capacity && (
                      <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/30">
                        Capacity Reached
                      </Badge>
                    )}
                  </CardFooter>
                </Card>
              ))
            )}
          </TabsContent>

          {/* TAB 3: MEMBERS */}
          <TabsContent value="members" className="p-4 space-y-2">
            {activeMembers.map((mem) => (
              <div
                key={mem.id}
                className="flex items-center justify-between p-2.5 rounded-lg border border-border/40 hover:bg-muted/30"
              >
                <div
                  onClick={() => navigate(`/profile/${mem.user_id}`)}
                  className="flex items-center gap-2.5 cursor-pointer flex-1"
                >
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={mem.avatar_url || undefined} />
                    <AvatarFallback className="text-xs">
                      {mem.username.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold">{mem.username}</span>
                      {mem.role !== "member" && (
                        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 capitalize">
                          {mem.role}
                        </Badge>
                      )}
                    </div>
                    {mem.department && (
                      <p className="text-[10px] text-muted-foreground">
                        {mem.department} {mem.year ? `· ${mem.year}` : ""}
                      </p>
                    )}
                  </div>
                </div>

                {/* President action: Appoint as Organizer */}
                {isPresident && mem.role === "member" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handlePromoteToOrganizer(mem.id, mem.username)}
                    className="h-7 text-[11px] rounded-full px-2.5"
                  >
                    Promote to Organizer
                  </Button>
                )}
              </div>
            ))}
          </TabsContent>

          {/* TAB 4: PENDING JOIN REQUESTS (Organizers & Admins Only) */}
          {(isOrganizer || isAdmin) && (
            <TabsContent value="requests" className="p-4 space-y-2">
              {pendingMembers.length === 0 ? (
                <div className="text-center py-10 border border-dashed rounded-xl text-muted-foreground">
                  <UserCheck className="h-8 w-8 mx-auto opacity-40 mb-2" />
                  <p className="text-xs">No pending join requests.</p>
                </div>
              ) : (
                pendingMembers.map((req) => (
                  <div
                    key={req.id}
                    className="flex items-center justify-between p-3 rounded-xl border bg-muted/20"
                  >
                    <div>
                      <span className="text-xs font-bold text-foreground">{req.username}</span>
                      <p className="text-[10px] text-muted-foreground">
                        {req.department || "Student"} {req.year ? `· ${req.year}` : ""}
                      </p>
                      <span className="text-[10px] text-amber-600 dark:text-amber-400">
                        Requested: {new Date(req.joined_at).toLocaleDateString()}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => handleApproveMember(req.id, req.username)}
                        className="h-7 text-xs rounded-full gap-1 bg-emerald-600 hover:bg-emerald-700"
                      >
                        <UserCheck className="h-3 w-3" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRejectMember(req.id, req.username)}
                        className="h-7 text-xs rounded-full gap-1 text-destructive hover:bg-destructive/10"
                      >
                        <UserX className="h-3 w-3" /> Reject
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>
          )}
        </Tabs>

        {/* Organizer Ticket Check-in Dialog */}
        <Dialog open={!!checkInEventId} onOpenChange={(open) => !open && setCheckInEventId(null)}>
          <DialogContent className="max-w-xs p-5">
            <DialogHeader>
              <DialogTitle className="text-base font-bold flex items-center gap-1.5">
                <QrCode className="h-5 w-5 text-primary" /> Scan / Verify Attendance
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCheckInAttendee} className="space-y-3 pt-2">
              <p className="text-xs text-muted-foreground">
                Enter the attendee's 8-character Pass ID or token to validate their ticket.
              </p>
              <div className="space-y-1">
                <Label htmlFor="qr-token">Pass ID / QR Token</Label>
                <Input
                  id="qr-token"
                  placeholder="e.g. 3a5f8b9c"
                  value={qrTokenInput}
                  onChange={(e) => setQrTokenInput(e.target.value)}
                  className="font-mono text-sm"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={checkingIn}>
                {checkingIn ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : "Confirm Attendance"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
};

export default ClubWorkspace;
