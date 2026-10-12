import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Search, Users, GraduationCap, ChevronRight, Plus, Check, Clock, Loader2, ShieldCheck, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Club, ClubMembership, StudentProfile, MembershipStatus } from "@/types/campus";

interface ClubWithMeta extends Club {
  member_count: number;
  membership_status: MembershipStatus | null;
  membership_role?: string;
}

const CATEGORIES = [
  "All",
  "Technical",
  "Robotics & AI",
  "Entrepreneurship",
  "Arts & Media",
  "Design & Product",
];

const Clubs = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [clubs, setClubs] = useState<ClubWithMeta[]>([]);
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  // New club form
  const [newClubName, setNewClubName] = useState("");
  const [newClubCategory, setNewClubCategory] = useState("Technical");
  const [newClubDescription, setNewClubDescription] = useState("");
  const [newClubCoordinator, setNewClubCoordinator] = useState("");

  const isAdmin = profile?.college_role === "college_admin";

  const fetchClubs = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);

      // Fetch user profile to check role
      if (user?.id) {
        const { data: profData, error: profErr } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .maybeSingle();
        if (profErr) {
          console.warn("Could not fetch user profile in Clubs:", profErr.message);
        }
        if (profData) {
          setProfile(profData as unknown as StudentProfile);
        }
      }

      // Fetch clubs
      const { data: clubsData, error: clubsErr } = await supabase
        .from("clubs")
        .select("*")
        .order("name", { ascending: true });

      if (clubsErr) throw clubsErr;

      // Fetch memberships
      const { data: membersData, error: membersErr } = await supabase
        .from("club_memberships")
        .select("club_id, user_id, role, status");

      if (membersErr) throw membersErr;

      const memberships = (membersData || []) as unknown as ClubMembership[];

      const rawClubs = (clubsData || []) as unknown as Club[];
      const enriched: ClubWithMeta[] = rawClubs.map((club) => {
        const activeMembers = memberships.filter((m) => m.club_id === club.id && m.status === "active");
        const userMem = memberships.find((m) => m.club_id === club.id && m.user_id === user?.id);

        return {
          ...club,
          member_count: activeMembers.length,
          membership_status: userMem ? userMem.status : null,
          membership_role: userMem?.role,
        };
      });

      setClubs(enriched);
    } catch (err: unknown) {
      const error = err as Error;
      console.error("Error fetching clubs:", error);
      setLoadError(error.message || "Failed to load clubs");
      toast.error("Failed to load clubs");
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchClubs();
  }, [fetchClubs]);

  const handleJoinToggle = async (club: ClubWithMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user?.id) return;

    try {
      if (club.membership_status === "active") {
        // Leave club
        const { error } = await supabase
          .from("club_memberships")
          .delete()
          .match({ club_id: club.id, user_id: user.id });
        if (error) throw error;
        toast.success(`Left ${club.name}`);
      } else if (club.membership_status === "pending") {
        // Withdraw request
        const { error } = await supabase
          .from("club_memberships")
          .delete()
          .match({ club_id: club.id, user_id: user.id });
        if (error) throw error;
        toast.info(`Cancelled membership request for ${club.name}`);
      } else {
        // Request membership (strictly status = pending, role = member)
        const { error } = await supabase
          .from("club_memberships")
          .insert({
            club_id: club.id,
            user_id: user.id,
            role: "member",
            status: "pending",
          });
        if (error) throw error;
        toast.success(`Request sent to ${club.name} organizers for approval!`);
      }
      fetchClubs();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to update membership");
    }
  };

  const handleCreateClub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.id || !newClubName.trim()) return;

    try {
      setIsSubmitting(true);
      const slug = newClubName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

      const initialStatus = isAdmin ? "active" : "pending_approval";

      const { data: newClubData, error } = await supabase
        .from("clubs")
        .insert({
          name: newClubName.trim(),
          slug,
          category: newClubCategory,
          description: newClubDescription.trim(),
          faculty_coordinator: newClubCoordinator.trim() || null,
          created_by: user.id,
          status: initialStatus,
        })
        .select()
        .single();

      if (error) throw error;

      const createdClub = newClubData as unknown as Club;

      if (isAdmin) {
        // Assign admin as president and create default channels
        await supabase
          .from("club_memberships")
          .insert({
            club_id: createdClub.id,
            user_id: user.id,
            role: "president",
            status: "active",
          });

        await supabase
          .from("club_channels")
          .insert([
            { club_id: createdClub.id, name: "announcements", type: "announcements", description: "Official notices" },
            { club_id: createdClub.id, name: "general", type: "general", description: "General community chat" },
          ]);

        toast.success("Club created and activated!");
        setIsCreateOpen(false);
        fetchClubs();
        navigate(`/club/${createdClub.id}`);
      } else {
        toast.success("Club proposal submitted! Pending College Administrator approval.");
        setIsCreateOpen(false);
        fetchClubs();
      }

      setNewClubName("");
      setNewClubDescription("");
      setNewClubCoordinator("");
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to submit club proposal");
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredClubs = clubs.filter((c) => {
    const matchesCategory = selectedCategory === "All" || c.category === selectedCategory;
    const matchesSearch =
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.description && c.description.toLowerCase().includes(search.toLowerCase()));
    return matchesCategory && matchesSearch;
  });

  return (
    <AppLayout>
      <div className="min-h-screen bg-background">
        {/* Top Header */}
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-xl font-bold tracking-tight text-foreground">Campus Clubs</h1>
                {isAdmin && (
                  <Badge variant="outline" className="text-[10px] text-primary border-primary/30">
                    <ShieldCheck className="h-3 w-3 mr-0.5" /> Admin
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Discover, join & collaborate with student organizations</p>
            </div>
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="h-8 gap-1 rounded-full text-xs">
                  <Plus className="h-3.5 w-3.5" /> {isAdmin ? "Create Club" : "Propose Club"}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>
                    {isAdmin ? "Launch New Campus Club" : "Submit Campus Club Proposal"}
                  </DialogTitle>
                </DialogHeader>
                {!isAdmin && (
                  <p className="text-xs text-muted-foreground bg-muted/50 p-2.5 rounded-lg border">
                    ℹ️ Club proposals are reviewed by college administrators before being officially activated.
                  </p>
                )}
                <form onSubmit={handleCreateClub} className="space-y-4 pt-1">
                  <div className="space-y-1.5">
                    <Label htmlFor="club-name">Club Name</Label>
                    <Input
                      id="club-name"
                      placeholder="e.g. CyberSecurity & CTF Club"
                      value={newClubName}
                      onChange={(e) => setNewClubName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="club-cat">Category</Label>
                    <select
                      id="club-cat"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={newClubCategory}
                      onChange={(e) => setNewClubCategory(e.target.value)}
                    >
                      {CATEGORIES.filter((c) => c !== "All").map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="club-coord">Faculty Coordinator</Label>
                    <Input
                      id="club-coord"
                      placeholder="e.g. Dr. Rajesh Kumar"
                      value={newClubCoordinator}
                      onChange={(e) => setNewClubCoordinator(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="club-desc">About the Club & Objectives</Label>
                    <Textarea
                      id="club-desc"
                      placeholder="Describe the club mission, planned activities, and faculty advisor..."
                      rows={3}
                      value={newClubDescription}
                      onChange={(e) => setNewClubDescription(e.target.value)}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={isSubmitting}>
                    {isSubmitting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : isAdmin ? (
                      "Launch Club"
                    ) : (
                      "Submit Proposal for Review"
                    )}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {/* Search bar */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search clubs by name or keywords..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9 text-sm"
            />
          </div>

          {/* Category filter pills */}
          <div className="flex gap-1.5 overflow-x-auto pt-3 pb-1 scrollbar-none">
            {CATEGORIES.map((category) => (
              <Button
                key={category}
                size="sm"
                variant={selectedCategory === category ? "default" : "outline"}
                onClick={() => setSelectedCategory(category)}
                className="h-7 whitespace-nowrap rounded-full px-3 text-xs"
              >
                {category}
              </Button>
            ))}
          </div>
        </header>

        {/* Club List */}
        <div className="p-4 space-y-3">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-xs">Loading campus clubs...</p>
            </div>
          ) : loadError ? (
            <div className="text-center py-16 px-4 rounded-xl border border-destructive/20 bg-destructive/5 text-muted-foreground">
              <AlertCircle className="mx-auto h-10 w-10 text-destructive mb-2" />
              <p className="font-semibold text-sm text-foreground">Could not load campus clubs</p>
              <p className="text-xs mt-1 max-w-sm mx-auto">{loadError}</p>
              <Button size="sm" onClick={fetchClubs} className="mt-4">
                Try Again
              </Button>
            </div>
          ) : filteredClubs.length === 0 ? (
            <div className="text-center py-12 px-4 rounded-xl border border-dashed text-muted-foreground">
              <Users className="mx-auto h-10 w-10 opacity-40 mb-2" />
              <p className="font-semibold text-sm">No clubs found</p>
              <p className="text-xs mt-1">Try a different search term or category filter.</p>
            </div>
          ) : (
            filteredClubs.map((club) => {
              const isPending = club.membership_status === "pending";
              const isActive = club.membership_status === "active";

              return (
                <Card
                  key={club.id}
                  onClick={() => navigate(`/club/${club.id}`)}
                  className="cursor-pointer border-border/60 hover:border-primary/50 transition-all hover:shadow-sm"
                >
                  <CardHeader className="p-4 pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-base font-semibold leading-tight hover:text-primary transition-colors">
                            {club.name}
                          </CardTitle>
                          {club.status === "pending_approval" && (
                            <Badge variant="outline" className="text-[9px] text-amber-500 border-amber-500/30">
                              Pending Review
                            </Badge>
                          )}
                        </div>
                        <Badge variant="secondary" className="mt-1 text-[10px] font-normal px-2 py-0">
                          {club.category}
                        </Badge>
                      </div>

                      {/* Join / Requested / Joined Button */}
                      <Button
                        size="sm"
                        variant={isActive ? "outline" : isPending ? "secondary" : "default"}
                        onClick={(e) => handleJoinToggle(club, e)}
                        className="h-7 px-3 text-xs rounded-full gap-1 shrink-0"
                      >
                        {isActive ? (
                          <>
                            <Check className="h-3 w-3 text-primary" />
                            <span>Joined</span>
                          </>
                        ) : isPending ? (
                          <>
                            <Clock className="h-3 w-3 text-amber-500" />
                            <span>Requested</span>
                          </>
                        ) : (
                          <span>Request Join</span>
                        )}
                      </Button>
                    </div>
                    {club.description && (
                      <CardDescription className="line-clamp-2 text-xs pt-2">
                        {club.description}
                      </CardDescription>
                    )}
                  </CardHeader>

                  <CardFooter className="p-4 pt-2 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/40 mt-2">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {club.member_count} {club.member_count === 1 ? "member" : "members"}
                      </span>
                      {club.faculty_coordinator && (
                        <span className="flex items-center gap-1 truncate max-w-[150px]">
                          <GraduationCap className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{club.faculty_coordinator}</span>
                        </span>
                      )}
                    </div>
                    <span className="flex items-center gap-0.5 text-primary font-medium text-xs">
                      View Space <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                  </CardFooter>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </AppLayout>
  );
};

export default Clubs;
