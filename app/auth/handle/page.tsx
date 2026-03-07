"use client";
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

function AuthHandleInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const code = searchParams.get("code");

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        router.replace("/auth/reset-password");
      } else if (event === "SIGNED_IN") {
        router.replace("/workspace");
      }
    });

    if (code) {
      supabase.auth.exchangeCodeForSession(code);
    }

    return () => subscription.unsubscribe();
  }, [router, searchParams]);

  return (
    <div className="text-center space-y-3">
      <div className="w-10 h-10 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" />
      <p className="text-white text-sm">로그인 처리 중...</p>
    </div>
  );
}

export default function AuthHandle() {
  return (
    <main className="relative w-screen h-screen bg-gray-900 flex items-center justify-center">
      <Suspense fallback={
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-white text-sm">로그인 처리 중...</p>
        </div>
      }>
        <AuthHandleInner />
      </Suspense>
    </main>
  );
}
