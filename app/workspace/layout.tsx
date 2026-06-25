"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { AiTaskProvider } from "@/context/AiTaskContext";
import {
  AutoPurchaseProvider,
  TrackingCollectProvider,
  GmarketImportProvider,
} from "@/context/modal-controllers";
import { TaskBadges, AutoPurchaseHost, TrackingCollectHost, GmarketImportHost } from "@/components/workspace/task-hosts";
import Sidebar from "@/components/workspace/sidebar";
import Header from "@/components/workspace/header";

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
      <AutoPurchaseProvider>
        <TrackingCollectProvider>
          <GmarketImportProvider>
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
              {/* 백그라운드 유지 모달 호스트 (페이지 이동에도 작업 유지) */}
              <AutoPurchaseHost />
              <TrackingCollectHost />
              <GmarketImportHost />
              <TaskBadges />
            </div>
          </GmarketImportProvider>
        </TrackingCollectProvider>
      </AutoPurchaseProvider>
    </AiTaskProvider>
  );
}
