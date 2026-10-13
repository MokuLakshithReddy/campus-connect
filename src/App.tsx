import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import ChangePassword from "./pages/ChangePassword";
import Clubs from "./pages/Clubs";
import ClubWorkspace from "./pages/ClubWorkspace";
import Events from "./pages/Events";
import Explore from "./pages/Explore";
import CreatePost from "./pages/CreatePost";
import Profile from "./pages/Profile";
import EditProfile from "./pages/EditProfile";
import PostDetail from "./pages/PostDetail";
import Notifications from "./pages/Notifications";
import Chats from "./pages/Chats";
import ChatConversation from "./pages/ChatConversation";
import NotFound from "./pages/NotFound";
import ReleaseUpdateDialog from "@/components/ReleaseUpdateDialog";
import ErrorBoundary from "@/components/ErrorBoundary";
import OfflineIndicator from "@/components/OfflineIndicator";
import AuthErrorScreen from "@/components/AuthErrorScreen";

const queryClient = new QueryClient();

// Protected pages require an authenticated user with a loaded profile.
export const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, profile, loading, mustChangePassword, profileError, refreshProfile, signOut } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;
  if (profileError || !profile) {
    return (
      <AuthErrorScreen
        error={profileError || "Account profile record could not be loaded."}
        onRetry={refreshProfile}
        onSignOut={signOut}
        isLoading={loading}
      />
    );
  }
  if (!profile.is_verified) {
    return (
      <AuthErrorScreen
        error="Your account directory verification is pending or incomplete. Access to campus application routes is restricted."
        onRetry={refreshProfile}
        onSignOut={signOut}
        isLoading={loading}
      />
    );
  }
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
};

// Guard for the Mandatory Change Password screen
export const ForcePasswordChangeRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, profile, loading, mustChangePassword, profileError, refreshProfile, signOut } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;
  if (profileError || !profile) {
    return (
      <AuthErrorScreen
        error={profileError || "Account profile record could not be loaded."}
        onRetry={refreshProfile}
        onSignOut={signOut}
        isLoading={loading}
      />
    );
  }
  if (!profile.is_verified) {
    return (
      <AuthErrorScreen
        error="Your account directory verification is pending or incomplete. Access to campus application routes is restricted."
        onRetry={refreshProfile}
        onSignOut={signOut}
        isLoading={loading}
      />
    );
  }
  // If already changed password, do not allow staying on change password screen
  if (!mustChangePassword) return <Navigate to="/" replace />;
  return <>{children}</>;
};

// Unauthenticated Route Guard
export const AuthRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, profile, loading, mustChangePassword, profileError, refreshProfile, signOut } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (user) {
    if (profileError || !profile) {
      return (
        <AuthErrorScreen
          error={profileError || "Account profile record could not be loaded."}
          onRetry={refreshProfile}
          onSignOut={signOut}
          isLoading={loading}
        />
      );
    }
    if (!profile.is_verified) {
      return (
        <AuthErrorScreen
          error="Your account directory verification is pending or incomplete. Access to campus application routes is restricted."
          onRetry={refreshProfile}
          onSignOut={signOut}
          isLoading={loading}
        />
      );
    }
    if (mustChangePassword) return <Navigate to="/change-password" replace />;
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
};

const App = () => (
  <ErrorBoundary>
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <OfflineIndicator />
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <ReleaseUpdateDialog />
          <Routes>
            <Route path="/auth" element={<AuthRoute><Auth /></AuthRoute>} />
            <Route path="/change-password" element={<ForcePasswordChangeRoute><ChangePassword /></ForcePasswordChangeRoute>} />
            <Route path="/" element={<ProtectedRoute><Index /></ProtectedRoute>} />
            <Route path="/clubs" element={<ProtectedRoute><Clubs /></ProtectedRoute>} />
            <Route path="/club/:clubId" element={<ProtectedRoute><ClubWorkspace /></ProtectedRoute>} />
            <Route path="/events" element={<ProtectedRoute><Events /></ProtectedRoute>} />
            <Route path="/explore" element={<ProtectedRoute><Explore /></ProtectedRoute>} />
            <Route path="/create" element={<ProtectedRoute><CreatePost /></ProtectedRoute>} />
            <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
            <Route path="/profile/:userId" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
            <Route path="/edit-profile" element={<ProtectedRoute><EditProfile /></ProtectedRoute>} />
            <Route path="/post/:postId" element={<ProtectedRoute><PostDetail /></ProtectedRoute>} />
            <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
            <Route path="/chats" element={<ProtectedRoute><Chats /></ProtectedRoute>} />
            <Route path="/chat/:conversationId" element={<ProtectedRoute><ChatConversation /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
