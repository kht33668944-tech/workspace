"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import Sidebar from "@/components/workspace/sidebar";
import Header from "@/components/workspace/header";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 한 번이라도 인증된 적이 있으면 일시적 null에 반응하지 않음
  const wasAuthenticatedRef = useRef(false);

  useEffect(() => {
    if (user) {
      wasAuthenticatedRef.current = true;
    }
  }, [user]);

  useEffect(() => {
    // 초기 로딩 완료 후 user가 없고, 이전에 인증된 적도 없을 때만 리다이렉트
    if (!loading && !user && !wasAuthenticatedRef.current) {
      router.replace("/");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <main className="w-screen h-screen flex items-center justify-center bg-[var(--bg-main)]">
        <div className="w-8 h-8 border-2 border-[var(--spinner-track)] border-t-[var(--spinner-head)] rounded-full animate-spin" />
      </main>
    );
  }

  if (!user && !wasAuthenticatedRef.current) return null;

  return (
    <div className="min-h-screen bg-[var(--bg-main)]">
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      <div
        className="transition-all duration-300 ease-in-out"
        style={{ marginLeft: sidebarCollapsed ? 64 : 240 }}
      >
        <Header />
        <main className="p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
