import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { getAvatarUrl } from "@/lib/supabase-helpers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  LogOut,
  MessageCircle,
  ShieldCheck,
  GraduationCap,
  Users,
  Calendar,
  Ticket,
  QrCode,
  CheckCircle2,
  Edit3,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";

interface UserProfileData {
  id: string;
  username: string;
  bio?: string | null;
  avatar_url?: string | null;
  department?: string | null;
  year?: string | null;
  student_id?: string | null;
  college_role?: string | null;
  is_verified?: boolean;
}

interface JoinedClub {
  id: string;
  name: string;
  category: string;
  role: string;
}

interface UserEventPass {
  id: string;
  title: string;
  venue: string;
  start_time: string;
  club_name: string;
  qr_code_token: string;
}

const Profile = () => {
  const { userId: paramUserId } = useParams();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<UserProfileData | null>(null);
  const [joinedClubs, setJoinedClubs] = useState<JoinedClub[]>([]);
  const [eventPasses, setEventPasses] = useState<UserEventPass[]>([]);
  const [selectedPass, setSelectedPass] = useState<UserEventPass | null>(null);
  const [loading, setLoading] = useState(true);

  const effectiveUserId = paramUserId && paramUserId !== "undefined" ? paramUserId : user?.id;
  const isOwn = !!user && user.id === effectiveUserId;

  const fetchProfile = useCallback(async () => {
    if (!effectiveUserId) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      // 1. Fetch Profile
      const { data: profileRes } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", effectiveUserId)
        .maybeSingle();

      let profileData = profileRes as UserProfileData | null;

      // Self-healing
      if (!profileData && isOwn && user) {
        const defaultUsername = user.user_metadata?.username || `student_${user.id.slice(0, 6)}`;
        const { data: createdProfile } = await supabase
          .from("profiles")
          .upsert({ id: user.id, username: defaultUsername })
          .select("*")
          .maybeSingle();

        if (createdProfile) {
          profileData = createdProfile as UserProfileData;
        }
      }

      if (profileData) {
        setProfile(profileData);
      }

      // 2. Fetch Joined Clubs safely
      try {
        const { data: memberships } = await supabase
          .from("club_memberships")
          .select(`
            role,
            clubs:club_id (
              id,
              name,
              category
            )
          `)
          .eq("user_id", effectiveUserId)
          .eq("status", "active");

        const rawMemberships = (memberships || []) as any[];
        const clubsList: JoinedClub[] = rawMemberships
          .filter((m) => m && m.clubs && m.clubs.id)
          .map((m) => ({
            id: m.clubs.id,
            name: m.clubs.name,
            category: m.clubs.category || "General",
            role: m.role,
          }));
        setJoinedClubs(clubsList);
      } catch (clubErr) {
        console.warn("Could not load clubs for profile:", clubErr);
      }

      // 3. Fetch Registered Event Passes safely
      try {
        const { data: regs } = await supabase
          .from("event_registrations")
          .select(`
            qr_code_token,
            events:event_id (
              id,
              title,
              venue,
              start_time,
              clubs:club_id (name)
            )
          `)
          .eq("user_id", effectiveUserId)
          .eq("status", "registered");

        const rawRegs = (regs || []) as any[];
        const passes: UserEventPass[] = rawRegs
          .filter((r) => r && r.events && r.events.id)
          .map((r) => ({
            id: r.events.id,
            title: r.events.title,
            venue: r.events.venue,
            start_time: r.events.start_time,
            club_name: r.events.clubs?.name || "Campus Club",
            qr_code_token: r.qr_code_token,
          }));
        setEventPasses(passes);
      } catch (regErr) {
        console.warn("Could not load event passes for profile:", regErr);
      }
    } catch (err: any) {
      console.error("Profile load error:", err);
    } finally {
      setLoading(false);
    }
  }, [effectiveUserId, isOwn, user]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    const ext = file.name.split(".").pop();
    const path = `${user.id}/avatar.${ext}`;
    const { error } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("profiles").update({ avatar_url: path }).eq("id", user.id);
    toast.success("Profile picture updated!");
    fetchProfile();
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  const handleMessage = async () => {
    if (!user || !effectiveUserId) return;
    const { data: existing } = await supabase
      .from("conversations")
      .select("id")
      .or(
        `and(user1_id.eq.${user.id},user2_id.eq.${effectiveUserId}),and(user1_id.eq.${effectiveUserId},user2_id.eq.${user.id})`
      )
      .maybeSingle();

    if (existing) {
      navigate(`/chat/${existing.id}`);
    } else {
      const { data: newConvo, error } = await supabase
        .from("conversations")
        .insert({ user1_id: user.id, user2_id: effectiveUserId })
        .select("id")
        .single();
      if (error) {
        toast.error("Could not start conversation");
        return;
      }
      navigate(`/chat/${newConvo.id}`);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-xs">Loading student profile...</p>
        </div>
      </AppLayout>
    );
  }

  if (!profile) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
          Student not found
        </div>
      </AppLayout>
    );
  }

  const avatarUrl = getAvatarUrl(profile.avatar_url);

  return (
    <AppLayout>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b bg-background/95 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-1.5">
          <GraduationCap className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">My Profile & Student ID</h1>
        </div>
        {isOwn && (
          <button onClick={handleSignOut} className="p-1 hover:text-destructive transition-colors" title="Sign out">
            <LogOut className="h-5 w-5 text-muted-foreground" />
          </button>
        )}
      </header>

      <div className="p-4 space-y-4">
        {/* Student ID Card Badge */}
        <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-muted/50 p-4 shadow-sm relative overflow-hidden">
          <div className="flex items-start gap-4">
            <button
              onClick={() => isOwn && fileRef.current?.click()}
              className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl bg-secondary ring-2 ring-primary/30 relative group"
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xl font-bold text-muted-foreground">
                  {profile.username?.[0]?.toUpperCase()}
                </div>
              )}
              {isOwn && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white">
                  <Edit3 className="h-4 w-4" />
                </div>
              )}
            </button>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="text-base font-bold text-foreground truncate">{profile.username}</h2>
                {profile.is_verified && (
                  <ShieldCheck className="h-4 w-4 text-primary fill-primary/20 shrink-0" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {profile.department || "Department Not Set"}
              </p>
              <p className="text-xs text-muted-foreground">{profile.year || "Year Not Set"}</p>
              {profile.student_id && (
                <div className="mt-1.5">
                  <span className="font-mono text-[11px] bg-background px-2 py-0.5 rounded border text-foreground font-medium">
                    ROLL: {profile.student_id}
                  </span>
                </div>
              )}
            </div>
          </div>

          {profile.bio && (
            <p className="mt-3 text-xs text-muted-foreground leading-relaxed pt-2 border-t border-border/60">
              {profile.bio}
            </p>
          )}

          {isOwn ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-xl text-xs h-8"
                onClick={() => navigate("/edit-profile")}
              >
                Edit Details
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-xl text-xs h-8"
                onClick={() => navigate("/change-password")}
              >
                Change Password
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <Button onClick={handleMessage} className="flex-1 rounded-xl text-xs h-8 gap-1.5">
                <MessageCircle className="h-4 w-4" /> Direct Message
              </Button>
            </div>
          )}
        </div>

        {/* Section: Joined Clubs */}
        <div className="space-y-2 pt-1">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-primary" /> Joined Campus Clubs ({joinedClubs.length})
          </h3>

          {joinedClubs.length === 0 ? (
            <div className="p-4 rounded-xl border border-dashed text-center text-xs text-muted-foreground">
              No campus clubs joined yet.
            </div>
          ) : (
            <div className="space-y-2">
              {joinedClubs.map((club) => (
                <div
                  key={club.id}
                  onClick={() => navigate(`/club/${club.id}`)}
                  className="flex items-center justify-between p-3 rounded-xl border bg-card hover:border-primary/50 cursor-pointer transition-all"
                >
                  <div>
                    <p className="text-xs font-semibold text-foreground">{club.name}</p>
                    <p className="text-[10px] text-muted-foreground">{club.category}</p>
                  </div>
                  <Badge variant="secondary" className="text-[10px] capitalize">
                    {club.role}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Section: Event Passes */}
        {isOwn && (
          <div className="space-y-2 pt-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Ticket className="h-3.5 w-3.5 text-emerald-500" /> Active Event Passes ({eventPasses.length})
            </h3>

            {eventPasses.length === 0 ? (
              <div className="p-4 rounded-xl border border-dashed text-center text-xs text-muted-foreground">
                No active event passes. Explore campus workshops to register!
              </div>
            ) : (
              <div className="space-y-2">
                {eventPasses.map((pass) => (
                  <div
                    key={pass.id}
                    onClick={() => setSelectedPass(pass)}
                    className="flex items-center justify-between p-3 rounded-xl border bg-muted/20 hover:bg-muted/40 cursor-pointer transition-all"
                  >
                    <div>
                      <p className="text-xs font-semibold text-foreground">{pass.title}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {pass.club_name} · {pass.venue}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-xs rounded-full gap-1">
                      <QrCode className="h-3.5 w-3.5" /> Pass
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* QR Ticket Dialog */}
      <Dialog open={!!selectedPass} onOpenChange={(open) => !open && setSelectedPass(null)}>
        <DialogContent className="max-w-xs rounded-2xl p-6 text-center">
          {selectedPass && (
            <div className="space-y-4">
              <div className="flex items-center justify-center">
                <div className="h-10 w-10 rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400 flex items-center justify-center">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
              </div>

              <div>
                <Badge variant="outline" className="text-[10px] text-primary">
                  {selectedPass.club_name}
                </Badge>
                <h3 className="text-sm font-bold text-foreground mt-1">{selectedPass.title}</h3>
                <p className="text-[11px] text-muted-foreground">Campus Event Attendance Pass</p>
              </div>

              <div className="p-4 bg-muted/60 rounded-xl border flex flex-col items-center justify-center gap-2">
                <div className="p-2.5 bg-white rounded-lg">
                  <QrCode className="h-24 w-24 text-black" />
                </div>
                <span className="text-[9px] font-mono text-muted-foreground tracking-wider">
                  TOKEN: {selectedPass.qr_code_token?.slice(0, 8).toUpperCase()}
                </span>
              </div>

              <div className="text-[11px] text-left p-2.5 rounded-lg bg-background border text-muted-foreground space-y-1">
                <div className="flex justify-between">
                  <span>Venue:</span>
                  <span className="font-medium text-foreground">{selectedPass.venue}</span>
                </div>
                <div className="flex justify-between">
                  <span>Student:</span>
                  <span className="font-medium text-foreground">{profile.username}</span>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <input ref={fileRef} type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
    </AppLayout>
  );
};

export default Profile;
