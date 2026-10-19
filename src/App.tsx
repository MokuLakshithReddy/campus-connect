import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/hooks/useAuth";

import ReleaseUpdateDialog from "@/components/ReleaseUpdateDialog";
import ErrorBoundary from "@/components/ErrorBoundary";
import OfflineIndicator from "@/components/OfflineIndicator";
import AuthErrorScreen from "@/components/AuthErrorScreen";
import CapacitorBackButtonHandler from "@/components/CapacitorBackButtonHandler";

// Route-level Code Splitting: Pages are loaded asynchronously on-demand
const Index = lazy(() => import("./pages/Index"));
const Auth = lazy(() => import("./pages/Auth"));
const ChangePassword = lazy(() => import("./pages/ChangePassword"));
const Clubs = lazy(() => import("./pages/Clubs"));
const ClubWorkspace = lazy(() => import("./pages/ClubWorkspace"));
const Events = lazy(() => import("./pages/Events"));
const Explore = lazy(() => import("./pages/Explore"));
const CreatePost = lazy(() => import("./pages/CreatePost"));
const Profile = lazy(() => import("./pages/Profile"));
const EditProfile = lazy(() => import("./pages/EditProfile"));
const PostDetail = lazy(() => import("./pages/PostDetail"));
const Notifications = lazy(() => import("./pages/Notifications"));
const Chats = lazy(() => import("./pages/Chats"));
const ChatConversation = lazy(() => import("./pages/ChatConversation"));
const AdminPortal = lazy(() => import("./pages/AdminPortal"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

// Suspense Fallback Loader
const PageLoader = () => (
  <div className="flex min-h-screen items-center justify-center bg-background">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);

// Protected pages require an authenticated user with a loaded profile.
export const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, profile, loading, mustChangePassword, profileError, refreshProfile, signOut } = useAuth();
  if (loading) return <PageLoader />;
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

// Admin Route Guard: Restricts access exclusively to verified college administrators
export const AdminRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, profile, loading, mustChangePassword, profileError, refreshProfile, signOut } = useAuth();
  if (loading) return <PageLoader />;
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
        error="Your account directory verification is pending or incomplete."
        onRetry={refreshProfile}
        onSignOut={signOut}
        isLoading={loading}
      />
    );
  }
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (profile.college_role !== "college_admin") {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
};

// Guard for the Password Change screen (supports both mandatory onboarding and voluntary changes)
export const ForcePasswordChangeRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, profile, loading, profileError, refreshProfile, signOut } = useAuth();
  if (loading) return <PageLoader />;
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
  return <>{children}</>;
};

// Unauthenticated Route Guard
export const AuthRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, profile, loading, mustChangePassword, profileError, refreshProfile, signOut } = useAuth();
  if (loading) return <PageLoader />;
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
          <CapacitorBackButtonHandler />
          <AuthProvider>
            <ReleaseUpdateDialog />
            <Suspense fallback={<PageLoader />}>
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
                <Route path="/admin" element={<AdminRoute><AdminPortal /></AdminRoute>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
