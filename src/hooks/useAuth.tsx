import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface SignUpMetadata {
  department?: string;
  year?: string;
  student_id?: string;
}

interface UserProfile {
  student_id: string | null;
  username: string;
  college_role: "student" | "faculty" | "college_admin";
  is_verified: boolean;
  must_change_password: boolean;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: UserProfile | null;
  mustChangePassword: boolean;
  loading: boolean;
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

  const fetchProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("student_id, username, college_role, is_verified, must_change_password")
        .eq("id", userId)
        .maybeSingle();

      if (!error && data) {
        const prof: UserProfile = {
          student_id: data.student_id,
          username: data.username,
          college_role: data.college_role,
          is_verified: data.is_verified,
          must_change_password: Boolean(data.must_change_password),
        };
        setProfile(prof);
        setMustChangePassword(Boolean(data.must_change_password));
        return prof;
      }
    } catch (err) {
      console.error("Error fetching user profile:", err);
    }
    return null;
  };

  const refreshProfile = async () => {
    if (user?.id) {
      await fetchProfile(user.id);
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

    if (data.user) {
      const prof = await fetchProfile(data.user.id);
      return prof ? prof.must_change_password : false;
    }
    return false;
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

    // 2. Refresh profile from server to verify trigger completion
    const refreshed = await fetchProfile(user.id);
    if (refreshed && !refreshed.must_change_password) {
      setMustChangePassword(false);
    } else {
      setMustChangePassword(false);
      if (profile) {
        setProfile({
          ...profile,
          must_change_password: false,
        });
      }
    }
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    setProfile(null);
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
