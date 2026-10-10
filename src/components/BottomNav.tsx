import { LayoutDashboard, Users, Calendar, MessageSquare, User } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useUnreadMessages } from "@/hooks/useUnreadMessages";
import { cn } from "@/lib/utils";

const BottomNav = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { unreadCount, clearUnread } = useUnreadMessages();

  const profilePath = "/profile";

  const items = [
    { icon: LayoutDashboard, path: "/", label: "Campus" },
    { icon: Users, path: "/clubs", label: "Clubs" },
    { icon: Calendar, path: "/events", label: "Events" },
    { icon: MessageSquare, path: "/chats", label: "Messages", badge: unreadCount },
    { icon: User, path: profilePath, label: "Profile" },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex max-w-lg items-center justify-around py-1.5 px-2">
        {items.map(({ icon: Icon, path, label, badge }) => {
          const isActive = label === "Profile"
            ? location.pathname.startsWith("/profile")
            : location.pathname === path || (path === "/clubs" && location.pathname.startsWith("/club/"));
          return (
            <button
              key={path}
              onClick={() => {
                if (label === "Messages") clearUnread();
                navigate(path);
              }}
              className={cn(
                "relative flex flex-col items-center gap-1 py-1 px-3 rounded-lg transition-all",
                isActive
                  ? "text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-label={label}
            >
              <div className="relative">
                <Icon className={cn("h-5 w-5 transition-transform", isActive && "scale-110")} strokeWidth={isActive ? 2.5 : 1.75} />
                {badge && badge > 0 ? (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                    {badge > 99 ? "99+" : badge}
                  </span>
                ) : null}
              </div>
              <span className="text-[11px] leading-none tracking-tight">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default BottomNav;
