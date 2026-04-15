"use client";

import { useState, useRef, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Bell, Moon, Sun, User, LogOut, Menu, ShoppingCart, Truck, CheckCircle, XCircle } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";
import { useAuth } from "@/context/AuthContext";
import { useNotifications } from "@/hooks/use-notifications";
import { getPlatformLabel, timeAgo } from "@/lib/log-format";
import type { BatchLogEntry } from "@/lib/log-format";

const pageTitles: Record<string, string> = {
  "/workspace": "대시보드",
  "/workspace/orders": "발주서",
  "/workspace/products": "상품 소싱",
};

interface HeaderProps {
  onMenuToggle?: () => void;
}

function NotificationItem({ batch, isNew }: { batch: BatchLogEntry; isNew: boolean }) {
  const icon =
    batch.type === "purchase" ? (
      <ShoppingCart className="w-3.5 h-3.5" />
    ) : (
      <Truck className="w-3.5 h-3.5" />
    );

  const label = batch.type === "purchase" ? "자동구매" : "운송장 수집";
  const total = batch.successCount + batch.failedCount + batch.cancelledCount;

  return (
    <div className={`px-4 py-3 border-b border-[var(--border)] last:border-0 ${isNew ? "bg-blue-500/5" : ""}`}>
      <div className="flex items-start gap-2.5">
        <div className={`mt-0.5 p-1.5 rounded-lg shrink-0 ${batch.type === "purchase" ? "bg-blue-500/15 text-blue-400" : "bg-green-500/15 text-green-400"}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-medium text-[var(--text-primary)]">{getPlatformLabel(batch.platform)} {label}</span>
            {isNew && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />}
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            {batch.successCount > 0 && (
              <span className="flex items-center gap-1 text-green-400">
                <CheckCircle className="w-3 h-3" />
                성공 {batch.successCount}
              </span>
            )}
            {batch.failedCount > 0 && (
              <span className="flex items-center gap-1 text-red-400">
                <XCircle className="w-3 h-3" />
                실패 {batch.failedCount}
              </span>
            )}
            {batch.cancelledCount > 0 && (
              <span className="text-[var(--text-disabled)]">취소 {batch.cancelledCount}</span>
            )}
            {total === 0 && <span className="text-[var(--text-disabled)]">결과 없음</span>}
          </div>
        </div>
        <span className="text-[10px] text-[var(--text-disabled)] shrink-0 mt-0.5">{timeAgo(batch.startedAt)}</span>
      </div>
    </div>
  );
}

export default function Header({ onMenuToggle }: HeaderProps) {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const { user, signOut } = useAuth();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);

  const { batches, loading: notiLoading, unreadCount, lastRead, fetchNotifications, markAsRead } = useNotifications();

  const title = pageTitles[pathname] ?? "워크스페이스";

  // 드롭다운 외부 클릭 닫기 (유저메뉴 + 알림벨 통합)
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleBellClick = () => {
    const next = !bellOpen;
    setBellOpen(next);
    if (next) fetchNotifications();
  };

  return (
    <header className="h-14 md:h-16 flex items-center justify-between px-3 md:px-6 border-b border-[var(--border)] bg-transparent">
      <div className="flex items-center gap-2">
        {/* 모바일 햄버거 메뉴 */}
        {onMenuToggle && (
          <button
            onClick={onMenuToggle}
            className="md:hidden flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}
        <h1 className="text-lg md:text-xl font-semibold text-[var(--text-primary)]">{title}</h1>
      </div>

      <div className="flex items-center gap-1 md:gap-2">
        {/* 알림 벨 */}
        <div className="relative" ref={bellRef}>
          <button
            onClick={handleBellClick}
            className="relative flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 ? (
              <span className="absolute top-2 right-2 flex items-center justify-center min-w-[16px] h-4 px-0.5 bg-red-500 rounded-full text-[10px] font-bold text-white leading-none">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : (
              batches.length > 0 && (
                <span className="absolute top-2.5 right-2.5 w-2 h-2 bg-[var(--text-disabled)] rounded-full" />
              )
            )}
          </button>

          {bellOpen && (
            <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-24px)] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl z-50 overflow-hidden">
              {/* 드롭다운 헤더 */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">알림</h3>
                {unreadCount > 0 && (
                  <button
                    onClick={markAsRead}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    모두 읽음
                  </button>
                )}
              </div>

              {/* 알림 목록 */}
              <div className="max-h-80 overflow-y-auto">
                {notiLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="w-5 h-5 border-2 border-[var(--text-muted)] border-t-[var(--text-primary)] rounded-full animate-spin" />
                  </div>
                ) : batches.length === 0 ? (
                  <div className="py-8 text-center">
                    <Bell className="w-8 h-8 text-[var(--text-disabled)] mx-auto mb-2" />
                    <p className="text-xs text-[var(--text-muted)]">최근 알림이 없습니다</p>
                  </div>
                ) : (
                  batches.map((batch) => (
                    <NotificationItem
                      key={batch.batchId}
                      batch={batch}
                      isNew={!lastRead || batch.startedAt > lastRead}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Dark mode toggle */}
        <button
          onClick={toggleTheme}
          className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <User className="w-5 h-5" />
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 max-w-[calc(100vw-24px)] py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl z-50">
              <div className="px-4 py-2 border-b border-[var(--border)]">
                <p className="text-sm text-[var(--text-primary)] font-medium truncate">{user?.email}</p>
              </div>
              <button
                onClick={async () => {
                  setUserMenuOpen(false);
                  await signOut();
                  window.location.href = "/";
                }}
                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-[var(--bg-hover)] transition-colors"
              >
                <LogOut className="w-4 h-4" />
                로그아웃
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
