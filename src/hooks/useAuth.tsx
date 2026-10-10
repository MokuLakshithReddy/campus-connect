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

    const initAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!isMounted) return;
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          await fetchProfile(session.user.id);
        }
      } catch (err) {
        console.error("Auth init error:", err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    // Safety timeout: ensure loading never hangs if connection is slow
    const safetyTimer = setTimeout(() => {
      if (isMounted) setLoading(false);
    }, 2000);

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!isMounted) return;
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        await fetchProfile(session.user.id);
      } else {
        setProfile(null);
        setMustChangePassword(false);
      }
      setLoading(false);
    });

    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
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

    // 1. Update Supabase Auth password
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });
    if (updateError) throw updateError;

    // 2. Mark profile as password changed via secure RPC
    const { error: rpcError } = await supabase.rpc("complete_first_time_password_change");
    if (rpcError) throw rpcError;

    // 3. Update local state
    setMustChangePassword(false);
    if (profile) {
      setProfile({
        ...profile,
        must_change_password: false,
      });
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
