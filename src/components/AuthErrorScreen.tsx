import React from "react";
import { ShieldAlert, RefreshCw, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AuthErrorScreenProps {
  error: string | null;
  onRetry: () => Promise<void> | void;
  onSignOut: () => Promise<void> | void;
  isLoading?: boolean;
}

export const AuthErrorScreen: React.FC<AuthErrorScreenProps> = ({
  error,
  onRetry,
  onSignOut,
  isLoading = false,
}) => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-2xl border border-destructive/20 bg-card p-6 shadow-xl text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="h-8 w-8" />
        </div>
        <h2 className="text-xl font-bold tracking-tight text-foreground">
          Profile Access Restricted
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          We could not verify your student profile with the campus database. Access is kept fail-closed to protect account security.
        </p>

        {error && (
          <div className="my-4 rounded-lg bg-muted/60 p-3 text-left text-xs font-mono text-muted-foreground border border-border">
            <span className="font-semibold text-destructive block mb-1">Details:</span>
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2.5">
          <Button
            onClick={onRetry}
            disabled={isLoading}
            className="w-full gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            {isLoading ? "Checking Connection..." : "Retry Connection"}
          </Button>

          <Button
            variant="outline"
            onClick={onSignOut}
            className="w-full gap-2 text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>

        <p className="mt-5 text-xs text-muted-foreground">
          If you believe your profile is missing or corrupted, please report this to your department administrator.
        </p>
      </div>
    </div>
  );
};

export default AuthErrorScreen;
