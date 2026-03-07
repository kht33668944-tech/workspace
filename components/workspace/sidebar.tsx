"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ShoppingCart, Package, ChevronsLeft, ChevronsRight } from "lucide-react";

const menuItems = [
  { label: "대시보드", href: "/workspace", icon: LayoutDashboard },
  { label: "발주서", href: "/workspace/orders", icon: ShoppingCart },
  { label: "상품 소싱", href: "/workspace/products", icon: Package },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/workspace") return pathname === "/workspace";
    return pathname.startsWith(href);
  };

  return (
    <aside
      className={`
        fixed top-0 left-0 h-screen z-30 flex flex-col
        transition-all duration-300 ease-in-out
        bg-[#1a1a2e]/80 dark:bg-[#1a1a2e]/80 backdrop-blur-xl
        border-r border-white/10
        ${collapsed ? "w-16" : "w-60"}
      `}
      style={{ willChange: "width" }}
    >
      {/* Title */}
      <div className={`flex items-center h-16 px-4 border-b border-white/10 ${collapsed ? "justify-center" : "gap-3"}`}>
        <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
          <Package className="w-5 h-5 text-blue-400" />
        </div>
        {!collapsed && (
          <span className="text-white font-semibold text-lg truncate">리셀 매니저</span>
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
              className={`
                flex items-center gap-3 px-3 py-2.5 rounded-lg
                transition-colors duration-200
                ${collapsed ? "justify-center" : ""}
                ${active
                  ? "bg-blue-600/20 text-blue-400"
                  : "text-white/60 hover:text-white hover:bg-white/5"
                }
              `}
              title={collapsed ? item.label : undefined}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              {!collapsed && <span className="text-sm font-medium truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Toggle */}
      <button
        onClick={onToggle}
        className="flex items-center justify-center h-12 border-t border-white/10 text-white/40 hover:text-white hover:bg-white/5 transition-colors"
      >
        {collapsed ? <ChevronsRight className="w-5 h-5" /> : <ChevronsLeft className="w-5 h-5" />}
      </button>
    </aside>
  );
}
