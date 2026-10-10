import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { KeyRound, ShieldAlert, CheckCircle2, Loader2, LogOut } from "lucide-react";

const ChangePassword = () => {
  const { profile, user, completePasswordChange, signOut } = useAuth();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const rollNumber = profile?.student_id || profile?.username || user?.user_metadata?.student_id || "Student";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters long.");
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match. Please re-enter.");
      return;
    }

    // Security requirement: Roll number cannot be the permanent password
    if (rollNumber && newPassword.trim().toLowerCase() === rollNumber.trim().toLowerCase()) {
      toast.error("Your new password cannot be the same as your roll number.");
      return;
    }

    setLoading(true);
    try {
      await completePasswordChange(newPassword);
      toast.success("Password set successfully! Welcome to CampusConnect.");
      // Short delay to ensure state and toast register smoothly before navigation
      setTimeout(() => {
        navigate("/", { replace: true });
      }, 100);
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to update password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate("/auth", { replace: true });
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to sign out");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <Card className="border-border shadow-lg">
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500 ring-1 ring-amber-500/20">
              <KeyRound className="h-7 w-7" />
            </div>
            <CardTitle className="text-xl font-bold tracking-tight">
              Create Your New Password
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-1">
              CampusConnect requires all students to change their temporary password before accessing clubs and events.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-muted-foreground flex gap-2.5 items-start">
              <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-foreground">First-Time Setup Required</p>
                <p className="mt-0.5">
                  Logged in as <strong className="font-mono text-foreground">{rollNumber}</strong>. Your temporary password will stop working immediately after this step.
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3.5">
              <div className="space-y-1">
                <Label htmlFor="roll-display" className="text-xs text-muted-foreground">Roll Number (Username)</Label>
                <Input
                  id="roll-display"
                  value={rollNumber}
                  disabled
                  className="bg-muted font-mono text-sm cursor-not-allowed opacity-90"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="new-password" className="text-xs">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  placeholder="At least 6 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  className="h-10 text-sm"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="confirm-password" className="text-xs">Confirm New Password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  placeholder="Re-enter new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  className="h-10 text-sm"
                />
              </div>

              <div className="space-y-1 pt-1 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className={`h-3.5 w-3.5 ${newPassword.length >= 6 ? "text-emerald-500" : "text-muted-foreground"}`} />
                  <span>At least 6 characters</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className={`h-3.5 w-3.5 ${newPassword && newPassword === confirmPassword ? "text-emerald-500" : "text-muted-foreground"}`} />
                  <span>Passwords match</span>
                </div>
              </div>

              <Button
                type="submit"
                disabled={loading || newPassword.length < 6 || newPassword !== confirmPassword}
                className="w-full h-10 mt-3 font-semibold text-sm"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Updating Password...
                  </>
                ) : (
                  "Save Password & Enter Platform"
                )}
              </Button>
            </form>

            <div className="pt-2 border-t border-border/60 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSignOut}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                <LogOut className="mr-1.5 h-3.5 w-3.5" />
                Sign Out / Switch Account
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
};

export default ChangePassword;
