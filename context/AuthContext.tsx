"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string) => Promise<string | null>;
  sendPasswordResetEmail: (email: string) => Promise<string | null>;
  updatePassword: (password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signInWithGoogle: async () => {},
  signInWithEmail: async () => null,
  signUp: async () => null,
  sendPasswordResetEmail: async () => null,
  updatePassword: async () => null,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const initializedRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      initializedRef.current = true;
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // TOKEN_REFRESHED 이벤트에서 세션이 일시적으로 null이 되는 경우 무시
      // 실제 로그아웃(SIGNED_OUT)만 user를 null로 설정
      if (event === "SIGNED_OUT") {
        setSession(null);
        setUser(null);
        setLoading(false);
      } else if (session) {
        setSession(session);
        // 같은 유저의 토큰 갱신인 경우 user 객체 참조를 유지하여 불필요한 리렌더 방지
        setUser((prev) =>
          prev?.id === session.user.id ? prev : session.user
        );
        setLoading(false);
      }
      // session이 null이고 SIGNED_OUT이 아닌 경우 (예: TOKEN_REFRESHED 중간 상태) → 무시
    });

    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/handle`,
      },
    });
  };

  const signInWithEmail = async (email: string, password: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  };

  const signUp = async (email: string, password: string): Promise<string | null> => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/handle`,
      },
    });
    return error ? error.message : null;
  };

  const sendPasswordResetEmail = async (email: string): Promise<string | null> => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/handle?type=recovery`,
    });
    return error ? error.message : null;
  };

  const updatePassword = async (password: string): Promise<string | null> => {
    const { error } = await supabase.auth.updateUser({ password });
    return error ? error.message : null;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signInWithGoogle, signInWithEmail, signUp, sendPasswordResetEmail, updatePassword, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
