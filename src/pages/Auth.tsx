import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { GraduationCap, ShieldCheck, KeyRound, Loader2, Sparkles, Building2 } from "lucide-react";

const Auth = () => {
  const [rollNumber, setRollNumber] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [isEmailMode, setIsEmailMode] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rollNumber.trim() || !password) {
      toast.error("Please enter both your roll number and password");
      return;
    }

    setLoading(true);
    try {
      const mustChange = await signIn(rollNumber.trim(), password);
      if (mustChange) {
        toast.info("First login detected. Please create your private password.");
        navigate("/change-password", { replace: true });
      } else {
        toast.success("Welcome back to CampusConnect!");
        navigate("/", { replace: true });
      }
    } catch (err: unknown) {
      const error = err as Error;
      if (error?.message?.includes("Invalid login credentials")) {
        toast.error("Invalid credentials. If this is your first login, your password is your roll number.");
      } else if (error?.message?.includes("Failed to fetch")) {
        toast.error("Cannot connect to server. Check your connection.");
      } else {
        toast.error(error.message || "Failed to authenticate");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleFillDemo = (roll: string) => {
    setRollNumber(roll);
    setPassword(roll);
    setIsEmailMode(false);
    toast.info(`Filled demo student credentials for ${roll}`);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm space-y-4"
      >
        <Card className="border-border shadow-lg">
          <CardHeader className="text-center pb-4">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <GraduationCap className="h-8 w-8" />
            </div>
            <CardTitle className="text-2xl font-bold tracking-tight">
              CampusConnect
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground mt-1">
              College Club Community & Event Management Platform
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <form onSubmit={handleLogin} className="space-y-3.5">
              <div className="space-y-1">
                <Label htmlFor="auth-identifier" className="text-xs font-medium">
                  {isEmailMode ? "Administrator Email" : "Student Roll Number"}
                </Label>
                <Input
                  id="auth-identifier"
                  type={isEmailMode ? "email" : "text"}
                  placeholder={isEmailMode ? "admin@college.edu" : "e.g. 24CS0142"}
                  value={rollNumber}
                  onChange={(e) => setRollNumber(e.target.value)}
                  required
                  autoCapitalize={isEmailMode ? "none" : "characters"}
                  className={`h-10 text-sm ${!isEmailMode ? "font-mono tracking-wide" : ""}`}
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label htmlFor="auth-password" className="text-xs font-medium">
                    Password
                  </Label>
                  {!isEmailMode && (
                    <span className="text-[11px] text-muted-foreground">
                      First login: roll number
                    </span>
                  )}
                </div>
                <Input
                  id="auth-password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-10 text-sm"
                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full h-10 mt-1 text-sm font-semibold"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing In...
                  </>
                ) : (
                  "Log In"
                )}
              </Button>
            </form>

            {/* College Provisioning Explanation */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-[11px] text-muted-foreground space-y-1.5">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
                <span>College-Provisioned Accounts</span>
              </div>
              <p>
                Student accounts are created by your campus administration. On your first login, enter your <strong>Roll Number</strong> as both username and temporary password.
              </p>
            </div>

            {/* Demo Testing Shortcut */}
            <div className="pt-2 border-t border-border/60">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-2">
                <span className="flex items-center gap-1 font-medium text-foreground">
                  <Sparkles className="h-3 w-3 text-amber-500" />
                  Quick Demo Accounts
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleFillDemo("24CS0142")}
                  className="h-8 text-[11px] font-mono border-dashed"
                >
                  24CS0142
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleFillDemo("24IT0089")}
                  className="h-8 text-[11px] font-mono border-dashed"
                >
                  24IT0089
                </Button>
              </div>
            </div>

            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => setIsEmailMode(!isEmailMode)}
                className="text-[11px] text-muted-foreground hover:text-primary transition-colors inline-flex items-center gap-1"
              >
                <Building2 className="h-3 w-3" />
                {isEmailMode ? "Switch to Student Roll Number Login" : "College Admin / Faculty Email Login"}
              </button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
};

export default Auth;
