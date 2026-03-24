"use client";

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ShoppingCart, Package, Settings, ChevronsLeft, ChevronsRight, Archive, X, Wallet } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";

const menuItems = [
  { label: "대시보드", href: "/workspace", icon: LayoutDashboard },
  { label: "발주서", href: "/workspace/orders", icon: ShoppingCart },
  { label: "보관함", href: "/workspace/archive", icon: Archive },
  { label: "상품 소싱", href: "/workspace/products", icon: Package },
  { label: "입출금", href: "/workspace/finance", icon: Wallet },
  { label: "설정", href: "/workspace/settings", icon: Settings },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const touchStartX = useRef<number | null>(null);

  const isActive = (href: string) => {
    if (href === "/workspace") return pathname === "/workspace";
    return pathname.startsWith(href);
  };

  const handleMenuClick = () => {
    if (isMobile) onToggle();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = touchStartX.current - e.changedTouches[0].clientX;
    touchStartX.current = null;
    if (dx > 60) onToggle(); // 왼쪽으로 60px 이상 스와이프 → 닫기
  };

  return (
    <>
      {/* 모바일 backdrop */}
      {isMobile && !collapsed && (
        <div
          className="fixed inset-0 bg-black/50 z-30"
          onClick={onToggle}
        />
      )}
      <aside
        className={`
          fixed top-0 left-0 h-screen flex flex-col
          transition-all duration-300 ease-in-out
          bg-[var(--bg-sidebar)] backdrop-blur-xl
          border-r border-[var(--border)]
          ${isMobile
            ? `w-60 z-40 ${collapsed ? "-translate-x-full" : "translate-x-0"}`
            : `z-30 ${collapsed ? "w-16" : "w-60"}`
          }
        `}
        style={{ willChange: isMobile ? "transform" : "width" }}
        onTouchStart={isMobile && !collapsed ? handleTouchStart : undefined}
        onTouchEnd={isMobile && !collapsed ? handleTouchEnd : undefined}
      >
        {/* Title */}
        <div className={`flex items-center h-16 px-4 border-b border-[var(--border)] ${isMobile ? "justify-between" : collapsed ? "justify-center" : "gap-3"}`}>
          <div className={`flex items-center ${collapsed && !isMobile ? "justify-center" : "gap-3"}`}>
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
              <Package className="w-5 h-5 text-blue-400" />
            </div>
            {(!collapsed || isMobile) && (
              <span className="text-[var(--text-primary)] font-semibold text-lg truncate">리셀 매니저</span>
            )}
          </div>
          {isMobile && (
            <button
              onClick={onToggle}
              className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Menu */}
        <nav className="flex-1 py-4 px-2 space-y-1">
          {menuItems.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={handleMenuClick}
                className={`
                  flex items-center gap-3 px-3 py-2.5 rounded-lg
                  transition-colors duration-200 min-h-[44px]
                  ${collapsed && !isMobile ? "justify-center" : ""}
                  ${active
                    ? "bg-blue-600/20 text-blue-400"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  }
                `}
                title={collapsed && !isMobile ? item.label : undefined}
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                {(!collapsed || isMobile) && <span className="text-sm font-medium truncate">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Toggle - 데스크톱만 */}
        {!isMobile && (
          <button
            onClick={onToggle}
            className="flex items-center justify-center h-12 border-t border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            {collapsed ? <ChevronsRight className="w-5 h-5" /> : <ChevronsLeft className="w-5 h-5" />}
          </button>
        )}
      </aside>
    </>
  );
}
