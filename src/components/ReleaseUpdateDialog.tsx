import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GraduationCap, Users, Calendar, Ticket } from "lucide-react";

export const CURRENT_APP_VERSION = "1.2.5";
const STORAGE_KEY = "seen_release_version";

interface ReleaseUpdateDialogProps {
  forceOpen?: boolean;
  onClose?: () => void;
}

export const ReleaseUpdateDialog = ({ forceOpen, onClose }: ReleaseUpdateDialogProps) => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (forceOpen) {
      setOpen(true);
      return;
    }

    const seenVersion = localStorage.getItem(STORAGE_KEY);
    if (seenVersion !== CURRENT_APP_VERSION) {
      // Delay slightly so user sees the app load first
      const timer = setTimeout(() => {
        setOpen(true);
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [forceOpen]);

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, CURRENT_APP_VERSION);
    setOpen(false);
    onClose?.();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) handleDismiss();
      else setOpen(true);
    }}>
      <DialogContent className="max-w-md rounded-2xl p-6 sm:rounded-2xl">
        <DialogHeader className="text-center sm:text-center items-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <GraduationCap className="h-8 w-8 text-primary" />
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary mb-1">
            Welcome to CampusConnect v{CURRENT_APP_VERSION}
          </div>
          <DialogTitle className="text-xl font-bold">College Clubs & Events Platform</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Your university's dedicated digital workspace for student clubs and activities.
          </DialogDescription>
        </DialogHeader>

        <div className="my-4 space-y-3">
          <div className="flex items-start gap-3 rounded-xl bg-secondary/50 p-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
              <Users className="h-5 w-5" />
            </div>
            <div className="flex-1 text-left">
              <h4 className="text-sm font-semibold">Club Discovery & Workspaces</h4>
              <p className="text-xs text-muted-foreground">
                Join technical, cultural, and sports clubs with dedicated spaces for announcements and group discussions.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-xl bg-secondary/50 p-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
              <Calendar className="h-5 w-5" />
            </div>
            <div className="flex-1 text-left">
              <h4 className="text-sm font-semibold">Campus Event Calendar</h4>
              <p className="text-xs text-muted-foreground">
                Discover workshops, hackathons, and seminars. 1-click registration with real-time seat limits.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-xl bg-secondary/50 p-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
              <Ticket className="h-5 w-5" />
            </div>
            <div className="flex-1 text-left">
              <h4 className="text-sm font-semibold">Digital Attendance Passes</h4>
              <p className="text-xs text-muted-foreground">
                Get an instant QR attendance pass for registered events right inside your student wallet.
              </p>
            </div>
          </div>
        </div>

        <Button
          onClick={handleDismiss}
          className="h-11 w-full rounded-xl text-sm font-semibold shadow"
        >
          Explore CampusConnect
        </Button>
      </DialogContent>
    </Dialog>
  );
};

export default ReleaseUpdateDialog;
