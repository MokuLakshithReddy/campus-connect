import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ShieldCheck,
  Users,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Calendar,
  Search,
  Check,
  X,
  RefreshCw,
  Loader2,
  Lock,
  ArrowLeft,
  Activity,
  Layers,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

interface AdminMetrics {
  total_students: number;
  verified_students: number;
  unverified_students: number;
  total_clubs: number;
  active_clubs: number;
  pending_clubs: number;
  total_events: number;
  failed_logins_24h: number;
  successful_logins_24h: number;
}

interface UnverifiedStudent {
  profile_id: string;
  username: string;
  student_id: string | null;
  created_at: string;
  review_reason: string;
}

interface AdminClubItem {
  id: string;
  name: string;
  category: string;
  status: string;
  faculty_coordinator: string | null;
  created_at: string;
}

interface LoginAuditItem {
  identifier: string;
  attempt_time: string;
  success: boolean;
  failure_reason: string | null;
}

const AdminPortal = () => {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<"overview" | "students" | "clubs" | "telemetry">("overview");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Data states
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [unverifiedStudents, setUnverifiedStudents] = useState<UnverifiedStudent[]>([]);
  const [clubs, setClubs] = useState<AdminClubItem[]>([]);
  const [loginAudit, setLoginAudit] = useState<LoginAuditItem[]>([]);

  // Search & filter states
  const [studentSearch, setStudentSearch] = useState("");
  const [clubFilter, setClubFilter] = useState<"all" | "pending_approval" | "active">("all");
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const fetchAdminData = useCallback(async () => {
    try {
      setRefreshing(true);

      // 1. Fetch system metrics
      const { data: metricsData, error: metricsErr } = await (supabase.rpc as any)("get_admin_dashboard_metrics");
      if (metricsErr) console.warn("Could not load admin metrics:", metricsErr.message);
      else setMetrics(metricsData as unknown as AdminMetrics);

      // 2. Fetch unverified students needing review
      const { data: studentsData, error: studentsErr } = await (supabase.from as any)("unverified_students_needing_review")
        .select("*")
        .order("created_at", { ascending: false });
      if (studentsErr) console.warn("Could not load unverified students:", studentsErr.message);
      else setUnverifiedStudents((studentsData || []) as unknown as UnverifiedStudent[]);

      // 3. Fetch clubs
      const { data: clubsData, error: clubsErr } = await supabase
        .from("clubs")
        .select("id, name, category, status, faculty_coordinator, created_at")
        .order("created_at", { ascending: false });
      if (clubsErr) console.warn("Could not load clubs:", clubsErr.message);
      else setClubs((clubsData || []) as unknown as AdminClubItem[]);

      // 4. Fetch security login telemetry
      const { data: auditData, error: auditErr } = await (supabase.rpc as any)("get_admin_login_audit", { p_limit: 25 });
      if (auditErr) console.warn("Could not load login audit:", auditErr.message);
      else setLoginAudit((auditData || []) as unknown as LoginAuditItem[]);

    } catch (err) {
      console.error("Error loading admin data:", err);
      toast.error("Failed to load some admin data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAdminData();
  }, [fetchAdminData]);

  // Handle student verification
  const handleVerifyStudent = async (profileId: string, studentRoll: string | null) => {
    try {
      setActionLoadingId(profileId);
      const { error } = await (supabase.rpc as any)("admin_verify_student", {
        p_profile_id: profileId,
      });

      if (error) throw error;
      toast.success(`Verified student ${studentRoll || profileId}!`);
      fetchAdminData();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to verify student");
    } finally {
      setActionLoadingId(null);
    }
  };

  // Handle club approval or rejection
  const handleSetClubStatus = async (clubId: string, clubName: string, status: "active" | "rejected") => {
    try {
      setActionLoadingId(clubId);
      const { error } = await (supabase.rpc as any)("admin_set_club_status", {
        p_club_id: clubId,
        p_status: status,
      });

      if (error) throw error;
      toast.success(status === "active" ? `Approved club: ${clubName}` : `Rejected club: ${clubName}`);
      fetchAdminData();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to update club status");
    } finally {
      setActionLoadingId(null);
    }
  };

  // Filtered lists
  const filteredStudents = unverifiedStudents.filter((s) => {
    const q = studentSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      (s.student_id && s.student_id.toLowerCase().includes(q)) ||
      s.username.toLowerCase().includes(q) ||
      s.review_reason.toLowerCase().includes(q)
    );
  });

  const filteredClubs = clubs.filter((c) => {
    if (clubFilter === "all") return true;
    return c.status === clubFilter;
  });

  return (
    <AppLayout>
      {/* Top Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => navigate("/")}
              className="p-1 rounded-lg hover:bg-secondary transition-colors"
            >
              <ArrowLeft className="h-5 w-5 text-muted-foreground" />
            </button>
            <div>
              <h1 className="text-lg font-bold tracking-tight flex items-center gap-1.5">
                <ShieldCheck className="h-5 w-5 text-primary" /> College Administration
              </h1>
              <p className="text-[11px] text-muted-foreground">Campus Control & Identity Governance</p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={fetchAdminData}
            disabled={refreshing}
            className="h-8 text-xs gap-1"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>

        {/* Navigation Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="w-full mt-3">
          <TabsList className="grid w-full grid-cols-4 h-8">
            <TabsTrigger value="overview" className="text-xs">
              Overview
            </TabsTrigger>
            <TabsTrigger value="students" className="text-xs relative">
              Students
              {unverifiedStudents.length > 0 && (
                <span className="ml-1 px-1 rounded-full bg-destructive text-[9px] text-destructive-foreground font-bold">
                  {unverifiedStudents.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="clubs" className="text-xs relative">
              Clubs
              {metrics && metrics.pending_clubs > 0 && (
                <span className="ml-1 px-1 rounded-full bg-amber-500 text-[9px] text-white font-bold">
                  {metrics.pending_clubs}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="telemetry" className="text-xs">
              Telemetry
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {/* Main Body */}
      <div className="p-4 space-y-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-xs font-medium">Loading campus administration...</p>
          </div>
        ) : (
          <>
            {/* TAB 1: OVERVIEW & SYSTEM METRICS */}
            {activeTab === "overview" && (
              <div className="space-y-4">
                {/* KPI Metrics Grid */}
                <div className="grid grid-cols-2 gap-2.5">
                  <Card className="p-3 bg-secondary/30 border-border/80">
                    <div className="flex items-center gap-2 mb-1">
                      <Users className="h-4 w-4 text-primary" />
                      <span className="text-xs text-muted-foreground font-medium">Students</span>
                    </div>
                    <div className="text-2xl font-bold">{metrics?.total_students ?? 0}</div>
                    <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground">
                      <span className="text-emerald-500 font-semibold">{metrics?.verified_students ?? 0} verified</span>
                      <span>·</span>
                      <span className="text-amber-500 font-semibold">{metrics?.unverified_students ?? 0} pending</span>
                    </div>
                  </Card>

                  <Card className="p-3 bg-secondary/30 border-border/80">
                    <div className="flex items-center gap-2 mb-1">
                      <Layers className="h-4 w-4 text-primary" />
                      <span className="text-xs text-muted-foreground font-medium">Campus Clubs</span>
                    </div>
                    <div className="text-2xl font-bold">{metrics?.total_clubs ?? 0}</div>
                    <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground">
                      <span className="text-emerald-500 font-semibold">{metrics?.active_clubs ?? 0} active</span>
                      <span>·</span>
                      <span className="text-amber-500 font-semibold">{metrics?.pending_clubs ?? 0} pending</span>
                    </div>
                  </Card>

                  <Card className="p-3 bg-secondary/30 border-border/80">
                    <div className="flex items-center gap-2 mb-1">
                      <Calendar className="h-4 w-4 text-primary" />
                      <span className="text-xs text-muted-foreground font-medium">Campus Events</span>
                    </div>
                    <div className="text-2xl font-bold">{metrics?.total_events ?? 0}</div>
                    <p className="text-[11px] text-muted-foreground mt-1">Published activities</p>
                  </Card>

                  <Card className="p-3 bg-secondary/30 border-border/80">
                    <div className="flex items-center gap-2 mb-1">
                      <Activity className="h-4 w-4 text-primary" />
                      <span className="text-xs text-muted-foreground font-medium">Auth (24h)</span>
                    </div>
                    <div className="text-2xl font-bold">{metrics?.successful_logins_24h ?? 0}</div>
                    <div className="flex items-center gap-1.5 mt-1 text-[11px]">
                      <span className="text-emerald-500 font-semibold">Success</span>
                      <span>·</span>
                      <span className={`${(metrics?.failed_logins_24h || 0) > 0 ? "text-destructive font-semibold" : "text-muted-foreground"}`}>
                        {metrics?.failed_logins_24h ?? 0} failed
                      </span>
                    </div>
                  </Card>
                </div>

                {/* Quick Action Cards */}
                <Card className="p-4 border-primary/20 bg-primary/5">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                        <Sparkles className="h-4 w-4 text-primary" /> Pending Administrative Tasks
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {unverifiedStudents.length} student verification requests and {metrics?.pending_clubs ?? 0} club registration requests require review.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <Button
                      size="sm"
                      onClick={() => setActiveTab("students")}
                      className="text-xs h-7"
                    >
                      Review Students ({unverifiedStudents.length})
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setActiveTab("clubs")}
                      className="text-xs h-7"
                    >
                      Review Clubs ({metrics?.pending_clubs ?? 0})
                    </Button>
                  </div>
                </Card>

                {/* System Integrity & Policy Notice */}
                <Card className="p-3.5 bg-secondary/20 border-border">
                  <h4 className="text-xs font-bold flex items-center gap-1.5 text-muted-foreground mb-1.5">
                    <Lock className="h-3.5 w-3.5" /> Campus Security Policy
                  </h4>
                  <ul className="text-[11px] text-muted-foreground space-y-1 list-disc list-inside">
                    <li>Students must be verified against academic branch directories before full campus access.</li>
                    <li>All club channels and event attendance are protected by strict row-level security.</li>
                    <li>Account activation tokens are strictly single-use and expire within 72 hours.</li>
                  </ul>
                </Card>
              </div>
            )}

            {/* TAB 2: STUDENT DIRECTORY VERIFICATION */}
            {activeTab === "students" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Search roll number, username, or reason..."
                      value={studentSearch}
                      onChange={(e) => setStudentSearch(e.target.value)}
                      className="pl-8 h-8 text-xs bg-secondary/40"
                    />
                  </div>
                </div>

                {filteredStudents.length === 0 ? (
                  <div className="py-12 text-center text-muted-foreground">
                    <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-2 opacity-80" />
                    <h3 className="text-sm font-semibold text-foreground">All Student Profiles Verified</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      No unverified students currently require administrative review.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredStudents.map((s) => (
                      <Card key={s.profile_id} className="p-3 border-border/80 hover:border-primary/40 transition-colors">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-sm">{s.username}</span>
                              {s.student_id ? (
                                <Badge variant="outline" className="font-mono text-[10px] px-1.5 h-4">
                                  {s.student_id}
                                </Badge>
                              ) : (
                                <Badge variant="destructive" className="text-[10px] px-1.5 h-4">
                                  No Roll No
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground">
                              <span className="text-amber-600 dark:text-amber-400 font-medium">
                                Reason: {s.review_reason.replace(/_/g, " ")}
                              </span>
                              <span>·</span>
                              <span>{formatDistanceToNow(new Date(s.created_at), { addSuffix: true })}</span>
                            </div>
                          </div>

                          <Button
                            size="sm"
                            onClick={() => handleVerifyStudent(s.profile_id, s.student_id)}
                            disabled={actionLoadingId === s.profile_id}
                            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-1 rounded-full shrink-0"
                          >
                            {actionLoadingId === s.profile_id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <>
                                <Check className="h-3 w-3" /> Verify
                              </>
                            )}
                          </Button>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: CLUB GOVERNANCE */}
            {activeTab === "clubs" && (
              <div className="space-y-3">
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={clubFilter === "all" ? "default" : "outline"}
                    onClick={() => setClubFilter("all")}
                    className="h-7 text-xs"
                  >
                    All ({clubs.length})
                  </Button>
                  <Button
                    size="sm"
                    variant={clubFilter === "pending_approval" ? "default" : "outline"}
                    onClick={() => setClubFilter("pending_approval")}
                    className="h-7 text-xs"
                  >
                    Pending ({clubs.filter((c) => c.status === "pending_approval").length})
                  </Button>
                  <Button
                    size="sm"
                    variant={clubFilter === "active" ? "default" : "outline"}
                    onClick={() => setClubFilter("active")}
                    className="h-7 text-xs"
                  >
                    Active ({clubs.filter((c) => c.status === "active").length})
                  </Button>
                </div>

                {filteredClubs.length === 0 ? (
                  <div className="py-12 text-center text-muted-foreground">
                    <p className="text-xs">No clubs found for the selected filter.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredClubs.map((club) => {
                      const isPending = club.status === "pending_approval";
                      return (
                        <Card key={club.id} className="p-3 border-border/80">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-sm">{club.name}</span>
                                <Badge variant="secondary" className="text-[10px] px-1.5 h-4">
                                  {club.category}
                                </Badge>
                                <Badge
                                  className={`text-[9px] px-1.5 h-4 uppercase ${
                                    club.status === "active"
                                      ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                                      : club.status === "pending_approval"
                                      ? "bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30"
                                      : "bg-destructive/20 text-destructive border-destructive/30"
                                  }`}
                                >
                                  {club.status}
                                </Badge>
                              </div>

                              <p className="text-[11px] text-muted-foreground mt-1">
                                Coordinator: {club.faculty_coordinator || "Not assigned"} · Registered{" "}
                                {formatDistanceToNow(new Date(club.created_at), { addSuffix: true })}
                              </p>
                            </div>

                            {isPending ? (
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  size="sm"
                                  onClick={() => handleSetClubStatus(club.id, club.name, "active")}
                                  disabled={actionLoadingId === club.id}
                                  className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-full gap-0.5 px-2"
                                >
                                  <Check className="h-3 w-3" /> Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleSetClubStatus(club.id, club.name, "rejected")}
                                  disabled={actionLoadingId === club.id}
                                  className="h-7 text-xs text-destructive hover:bg-destructive/10 rounded-full gap-0.5 px-2"
                                >
                                  <X className="h-3 w-3" /> Reject
                                </Button>
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => navigate(`/club/${club.id}`)}
                                className="h-7 text-xs"
                              >
                                View
                              </Button>
                            )}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 4: SYSTEM TELEMETRY & SECURITY AUDIT */}
            {activeTab === "telemetry" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Recent Authentication Activity
                  </h3>
                  <Badge variant="outline" className="text-[10px]">
                    Last 25 Events
                  </Badge>
                </div>

                {loginAudit.length === 0 ? (
                  <div className="py-12 text-center text-muted-foreground">
                    <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-xs">No recent authentication logs recorded.</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {loginAudit.map((log, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2.5 rounded-lg border bg-secondary/20 text-xs font-mono"
                      >
                        <div className="flex items-center gap-2">
                          {log.success ? (
                            <span className="h-2 w-2 rounded-full bg-emerald-500" />
                          ) : (
                            <span className="h-2 w-2 rounded-full bg-destructive animate-pulse" />
                          )}
                          <span className="font-semibold text-foreground">{log.identifier}</span>
                          {!log.success && log.failure_reason && (
                            <span className="text-[10px] text-destructive font-sans">
                              ({log.failure_reason})
                            </span>
                          )}
                        </div>

                        <span className="text-[10px] text-muted-foreground font-sans">
                          {formatDistanceToNow(new Date(log.attempt_time), { addSuffix: true })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
};

export default AdminPortal;
