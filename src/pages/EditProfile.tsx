import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import AppLayout from "@/components/AppLayout";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Loader2, AlertCircle, ShieldCheck, Lock } from "lucide-react";

const DEPARTMENTS = [
  "Computer Science & Engineering",
  "Information Technology",
  "Electronics & Communication",
  "Electrical & Electronics",
  "Mechanical Engineering",
  "Civil Engineering",
  "Chemical & Materials",
  "Biotechnology",
  "Business & Management",
  "Design & Media Arts",
  "Sciences & Humanities",
];

const YEARS = [
  "1st Year",
  "2nd Year",
  "3rd Year",
  "4th Year",
  "Postgraduate / Masters",
  "PhD Research Scholar",
  "Faculty / Staff",
];

const EditProfile = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [department, setDepartment] = useState(DEPARTMENTS[0]);
  const [year, setYear] = useState(YEARS[2]);
  const [studentId, setStudentId] = useState("");
  const [isVerified, setIsVerified] = useState(false);
  const [collegeRole, setCollegeRole] = useState("student");
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchProfile = useCallback(async () => {
    if (!user) return;
    try {
      setInitialLoading(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from("profiles")
        .select("username, bio, department, year, student_id, is_verified, college_role")
        .eq("id", user.id)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("Student profile record not found");

      setUsername(data.username || "");
      setBio(data.bio || "");
      if (data.department) setDepartment(data.department);
      if (data.year) setYear(data.year);
      if (data.student_id) setStudentId(data.student_id);
      setIsVerified(Boolean(data.is_verified));
      setCollegeRole(data.college_role || "student");
    } catch (err: unknown) {
      const e = err as Error;
      console.error("Error loading profile:", e);
      setLoadError(e.message || "Failed to load student profile");
      toast.error("Failed to load student profile");
    } finally {
      setInitialLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const isAdmin = collegeRole === "college_admin";
  // Institution identity lock: verified students cannot alter their assigned roll number
  const isStudentIdLocked = isVerified && !isAdmin;

  const handleSave = async () => {
    if (!user || initialLoading || saving || loadError) return;
    if (!username.trim()) {
      toast.error("Username cannot be empty");
      return;
    }

    try {
      setSaving(true);
      const updatePayload: Record<string, unknown> = {
        username: username.trim(),
        bio: bio.trim(),
        updated_at: new Date().toISOString(),
      };

      // Only allow updating academic records if not locked by institution verified status
      if (!isStudentIdLocked) {
        updatePayload.student_id = studentId.trim();
        updatePayload.department = department;
        updatePayload.year = year;
      }

      const { error } = await supabase
        .from("profiles")
        .update(updatePayload)
        .eq("id", user.id);

      if (error) throw error;

      toast.success("Student profile updated!");
      navigate(`/profile/${user.id}`);
    } catch (err: unknown) {
      const e = err as Error;
      toast.error(e.message || "Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b bg-background/95 backdrop-blur px-4 py-3">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm font-medium">
          <ArrowLeft className="h-4 w-4" /> Cancel
        </button>
        <h1 className="text-base font-semibold">Edit Student Profile</h1>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || initialLoading || Boolean(loadError)}
          className="rounded-full h-8 px-4 text-xs"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </header>

      {initialLoading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-xs">Loading profile details...</p>
        </div>
      ) : loadError ? (
        <div className="p-6 flex flex-col items-center justify-center text-center py-20">
          <AlertCircle className="h-12 w-12 text-destructive mb-3" />
          <h2 className="text-base font-semibold">Could not load profile</h2>
          <p className="mt-1 text-xs text-muted-foreground max-w-xs">{loadError}</p>
          <Button size="sm" onClick={fetchProfile} className="mt-4">
            Try Again
          </Button>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Username</label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-10 rounded-lg text-sm"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-muted-foreground">Student ID / Roll Number</label>
              {isStudentIdLocked && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                  <ShieldCheck className="h-3 w-3" /> Verified by Institution
                </span>
              )}
            </div>
            <div className="relative">
              <Input
                value={studentId}
                placeholder="e.g. 24CS-0142"
                onChange={(e) => setStudentId(e.target.value)}
                disabled={isStudentIdLocked}
                className="h-10 rounded-lg font-mono text-sm disabled:opacity-80 disabled:bg-muted/50"
              />
              {isStudentIdLocked && (
                <Lock className="absolute right-3 top-3 h-4 w-4 text-muted-foreground/60" />
              )}
            </div>
            {isStudentIdLocked ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Official student roll numbers are institution-verified and locked. Contact the college administrator for record updates.
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Enter your official university roll number (e.g. 24CS-0142).
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-muted-foreground">Department / School</label>
              {isStudentIdLocked && (
                <span className="text-[10px] text-muted-foreground font-medium flex items-center gap-1">
                  <Lock className="h-3 w-3" /> Locked
                </span>
              )}
            </div>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              disabled={isStudentIdLocked}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm disabled:opacity-75 disabled:bg-muted/50"
            >
              {DEPARTMENTS.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-muted-foreground">Academic Year</label>
              {isStudentIdLocked && (
                <span className="text-[10px] text-muted-foreground font-medium flex items-center gap-1">
                  <Lock className="h-3 w-3" /> Locked
                </span>
              )}
            </div>
            <select
              value={year}
              onChange={(e) => setYear(e.target.value)}
              disabled={isStudentIdLocked}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm disabled:opacity-75 disabled:bg-muted/50"
            >
              {YEARS.map((yr) => (
                <option key={yr} value={yr}>
                  {yr}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">About / Student Bio</label>
            <Textarea
              value={bio}
              placeholder="Interests, tech stack, research areas, or goals..."
              onChange={(e) => setBio(e.target.value)}
              className="min-h-[100px] resize-none rounded-lg text-sm"
            />
          </div>
        </div>
      )}
    </AppLayout>
  );
};

export default EditProfile;
