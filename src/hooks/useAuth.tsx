import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface SignUpMetadata {
  department?: string;
  year?: string;
  student_id?: string;
}

import {
  UserProfile,
  ProfileResolutionResult,
  validateAndNormalizeUserProfile,
  resolveProfileFromSources,
} from "@/lib/profileSecurity";

export type { UserProfile, ProfileResolutionResult };

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: UserProfile | null;
  mustChangePassword: boolean;
  loading: boolean;
  profileError: string | null;
  signIn: (rollNumberOrEmail: string, password: string) => Promise<boolean>;
  completePasswordChange: (newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  signUp?: (email: string, password: string, username: string, metadata?: SignUpMetadata) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const fetchProfile = async (userId: string): Promise<UserProfile | null> => {
    try {
      // Primary secure path: fetch caller's own full profile via dedicated RPC
      const { data: rpcData, error: rpcError } = await (supabase.rpc as any)("get_my_profile");

      let fallbackData: any = null;
      let fallbackError: any = null;

      const primaryRow = Array.isArray(rpcData) ? rpcData[0] : rpcData;

      // Fallback: If primary RPC failed or returned no data, query profiles table
      // CRITICAL SECURITY: Must explicitly select must_change_password and student_id
      if (!primaryRow || rpcError) {
        if (rpcError) {
          console.warn("Primary get_my_profile() RPC returned error, querying fallback profiles table:", rpcError);
        }
        const fallbackRes = await supabase
          .from("profiles")
          .select("id, username, college_role, is_verified, department, year, branch_id, must_change_password, student_id")
          .eq("id", userId)
          .maybeSingle();

        fallbackData = fallbackRes.data;
        fallbackError = fallbackRes.error;
      }

      const resolution = resolveProfileFromSources(primaryRow, rpcError, fallbackData, fallbackError);

      setProfile(resolution.profile);
      setProfileError(resolution.error);
      setMustChangePassword(resolution.mustChangePassword);

      return resolution.profile;
    } catch (err: any) {
      console.error("Network or unexpected error fetching user profile:", err);
      setProfile(null);
      setProfileError(err?.message || "Failed to load account profile due to a network error.");
      setMustChangePassword(true); // Fail closed
      return null;
    }
  };

  const refreshProfile = async () => {
    if (user?.id) {
      setLoading(true);
      await fetchProfile(user.id);
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;

    const resolveUserAndProfile = async (currentUser: User | null) => {
      if (!isMounted) return;
      if (!currentUser) {
        setProfile(null);
        setMustChangePassword(false);
        setLoading(false);
        return;
      }

      setLoading(true);
      const prof = await fetchProfile(currentUser.id);
      if (!isMounted) return;

      if (!prof) {
        // Fail closed: Profile could not be loaded; enforce password change/restricted mode
        console.error("Failed to load profile for user:", currentUser.id);
        setMustChangePassword(true);
      }
      setLoading(false);
    };

    const initAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!isMounted) return;
        setSession(session);
        setUser(session?.user ?? null);
        await resolveUserAndProfile(session?.user ?? null);
      } catch (err) {
        console.error("Auth init error:", err);
        if (isMounted) {
          setMustChangePassword(true);
          setLoading(false);
        }
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!isMounted) return;
      setSession(session);
      setUser(session?.user ?? null);
      if (event === "SIGNED_OUT" || !session?.user) {
        setProfile(null);
        setMustChangePassword(false);
        setLoading(false);
      } else {
        // Keep loading true while fetching profile, deferred slightly to prevent lock contention
        setLoading(true);
        setTimeout(async () => {
          if (isMounted) {
            await resolveUserAndProfile(session.user);
          }
        }, 0);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const normalizeIdentifierToEmail = (identifier: string): string => {
    const clean = identifier.trim().toLowerCase();
    if (clean.includes("@")) {
      return clean;
    }
    // Deterministic college roll-number identity mapping
    return `${clean}@campus.internal`;
  };

  const signIn = async (rollNumberOrEmail: string, password: string): Promise<boolean> => {
    const mappedEmail = normalizeIdentifierToEmail(rollNumberOrEmail);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: mappedEmail,
      password,
    });
    if (error) throw error;

    if (!data.user) {
      throw new Error("Authentication failed: No user returned by authentication provider.");
    }

    const prof = await fetchProfile(data.user.id);
    if (!prof) {
      // Fail closed: Profile could not be resolved from get_my_profile() or fallback query.
      // CRITICAL SECURITY: Never return false to mean "password change not required" when profile is unavailable!
      const reason = profileError || "Account profile record could not be loaded or verified.";
      throw new Error(
        `Profile resolution failed (${reason}). Access to campus application routes is restricted.`
      );
    }

    if (!prof.is_verified) {
      throw new Error(
        "Account directory verification is pending or incomplete. Access to campus application routes is restricted."
      );
    }

    return prof.must_change_password;
  };

  const completePasswordChange = async (newPassword: string) => {
    if (!user) throw new Error("No authenticated user");

    // Timeout helper to avoid infinite hanging
    const withTimeout = <T,>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms)),
      ]);
    };

    // 1. Update Supabase Auth password
    // Server-side trigger public.trg_auth_user_password_changed automatically sets must_change_password = false
    const { error: updateError } = await withTimeout(
      supabase.auth.updateUser({ password: newPassword }),
      10000,
      "Auth password update timed out. Please try again."
    );
    if (updateError) throw updateError;

    // 2. Strict verification: Refresh profile from database to confirm state
    const refreshed = await fetchProfile(user.id);
    if (!refreshed || refreshed.must_change_password) {
      setMustChangePassword(true);
      throw new Error(
        "Password updated, but setup is not yet confirmed. Please retry."
      );
    }

    setMustChangePassword(false);
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    setProfile(null);
    setProfileError(null);
    setMustChangePassword(false);
    if (error) throw error;
  };

  const signUp = async (email: string, password: string, username: string, metadata?: SignUpMetadata) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: {
          username,
          department: metadata?.department,
          year: metadata?.year,
          student_id: metadata?.student_id,
          must_change_password: true,
        },
      },
    });
    if (error) throw error;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        mustChangePassword,
        loading,
        profileError,
        signIn,
        completePasswordChange,
        signOut,
        refreshProfile,
        signUp,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
