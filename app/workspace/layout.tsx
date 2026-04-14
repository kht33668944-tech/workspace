"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { AiTaskProvider, useAiTask } from "@/context/AiTaskContext";
import Sidebar from "@/components/workspace/sidebar";
import Header from "@/components/workspace/header";

/** 일괄 생성 진행 중일 때 화면 우하단에 표시되는 플로팅 배지 */
function BatchProgressBadge() {
  const { batchItems, batchActive, batchVisible, showBatch } = useAiTask();
  if (!batchActive && !batchItems.length) return null;

  const done = batchItems.filter((i) => i.status === "done" || i.status === "error").length;
  const total = batchItems.length;
  const allDone = done === total && total > 0;

  if (batchVisible && batchActive) return null; // 모달이 열려 있으면 숨김

  return (
    <button
      onClick={showBatch}
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium transition-all ${
        allDone
          ? "bg-emerald-600 text-white"
          : "bg-amber-500 text-white animate-pulse"
      }`}
    >
      {!allDone && (
        <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
      )}
      {allDone ? `✓ 상세페이지 ${total}건 완료` : `상세페이지 생성 중 ${done}/${total}`}
    </button>
  );
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const isMobile = useIsMobile();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
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

  // 모바일에서 사이드바 기본 닫힘
  useEffect(() => {
    if (isMobile) setSidebarCollapsed(true);
  }, [isMobile]);

  if (loading) {
    return (
      <main className="w-screen h-screen flex items-center justify-center bg-[var(--bg-main)]">
        <div className="w-8 h-8 border-2 border-[var(--spinner-track)] border-t-[var(--spinner-head)] rounded-full animate-spin" />
      </main>
    );
  }

  if (!user && !wasAuthenticatedRef.current) return null;

  return (
    <AiTaskProvider>
      <div className="min-h-screen bg-[var(--bg-main)]">
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
        <div
          className="transition-all duration-300 ease-in-out"
          style={{ marginLeft: isMobile ? 0 : (sidebarCollapsed ? 64 : 240) }}
        >
          <Header onMenuToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
          <main className="p-3 md:p-6">
            {children}
          </main>
        </div>
        <BatchProgressBadge />
      </div>
    </AiTaskProvider>
  );
}
