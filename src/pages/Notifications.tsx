import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import {
  Megaphone,
  Calendar,
  Clock,
  UserCheck,
  Users,
  ArrowLeft,
  CheckCheck,
  Bell,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { CampusNotification } from "@/types/campus";

const Notifications = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<CampusNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    try {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      setNotifications((data || []) as unknown as CampusNotification[]);
    } catch (err: unknown) {
      const error = err as Error;
      console.error("Notifications fetch error:", error);
      setLoadError(error.message || "Failed to load notifications");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchNotifications();

    if (user?.id) {
      const sub = supabase
        .channel("user_notifications")
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${user.id}`,
          },
          () => {
            fetchNotifications();
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(sub);
      };
    }
  }, [user?.id, fetchNotifications]);

  const handleMarkAllAsRead = async () => {
    if (!user) return;
    try {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", user.id)
        .eq("is_read", false);

      if (error) throw error;
      toast.success("All notifications marked as read");
      fetchNotifications();
    } catch (err: unknown) {
      const error = err as Error;
      toast.error(error.message || "Failed to mark notifications");
    }
  };

  const handleNotificationClick = async (n: CampusNotification) => {
    if (!n.is_read) {
      const { error: markErr } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("id", n.id);
      if (markErr) {
        console.warn("Could not mark notification as read:", markErr.message);
      }
    }

    if (n.resource_type === "club" && n.resource_id) {
      navigate(`/club/${n.resource_id}`);
    } else if (n.resource_type === "event") {
      navigate("/events");
    }
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "announcement":
        return <Megaphone className="h-5 w-5 text-amber-500" />;
      case "event_created":
      case "event_reminder":
        return <Calendar className="h-5 w-5 text-primary" />;
      case "membership_approved":
        return <UserCheck className="h-5 w-5 text-emerald-500" />;
      case "membership_requested":
        return <Users className="h-5 w-5 text-blue-500" />;
      default:
        return <Bell className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <AppLayout>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b bg-background/95 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="rounded-full p-1 transition-colors hover:bg-secondary"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-base font-semibold leading-none">Notifications</h1>
            {unreadCount > 0 && (
              <span className="text-[11px] text-primary font-medium">{unreadCount} unread</span>
            )}
          </div>
        </div>

        {unreadCount > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleMarkAllAsRead}
            className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
          >
            <CheckCheck className="h-3.5 w-3.5" /> Mark all read
          </Button>
        )}
      </header>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-xs">Loading notifications...</p>
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center py-20 text-center px-4">
          <AlertCircle className="h-12 w-12 text-destructive mb-3" />
          <h2 className="text-base font-semibold">Could not load notifications</h2>
          <p className="mt-1 text-xs text-muted-foreground max-w-xs">{loadError}</p>
          <Button size="sm" onClick={fetchNotifications} className="mt-4">
            Try Again
          </Button>
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center px-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary mb-3">
            <Bell className="h-8 w-8 text-muted-foreground/60" />
          </div>
          <h2 className="text-base font-semibold">All caught up!</h2>
          <p className="mt-1 text-xs text-muted-foreground max-w-xs">
            Official club notices, event reminders, and membership updates will appear here.
          </p>
        </div>
      ) : (
        <div className="divide-y">
          {notifications.map((n) => (
            <button
              key={n.id}
              onClick={() => handleNotificationClick(n)}
              className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/40 ${
                !n.is_read ? "bg-primary/5" : ""
              }`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary mt-0.5">
                {getNotificationIcon(n.type)}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <p className="text-xs font-semibold text-foreground truncate">{n.title}</p>
                  {!n.is_read && (
                    <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  {n.message}
                </p>
                <span className="text-[10px] text-muted-foreground/75 mt-1 block">
                  {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </AppLayout>
  );
};

export default Notifications;
