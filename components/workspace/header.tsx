"use client";

import { useState, useRef, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Bell, Moon, Sun, User, LogOut } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";
import { useAuth } from "@/context/AuthContext";

const pageTitles: Record<string, string> = {
  "/workspace": "대시보드",
  "/workspace/orders": "발주서",
  "/workspace/products": "상품 소싱",
};

export default function Header() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const { user, signOut } = useAuth();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const title = pageTitles[pathname] ?? "워크스페이스";

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <header className="h-16 flex items-center justify-between px-6 border-b border-white/10 dark:border-white/10 bg-transparent">
      <h1 className="text-xl font-semibold text-white dark:text-white">{title}</h1>

      <div className="flex items-center gap-2">
        {/* Notification bell (UI only) */}
        <button className="relative p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/5 transition-colors">
          <Bell className="w-5 h-5" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
        </button>

        {/* Dark mode toggle */}
        <button
          onClick={toggleTheme}
          className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/5 transition-colors"
        >
          {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/5 transition-colors"
          >
            <User className="w-5 h-5" />
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 py-2 bg-[#1a1a2e] border border-white/10 rounded-xl shadow-2xl z-50">
              <div className="px-4 py-2 border-b border-white/10">
                <p className="text-sm text-white font-medium truncate">{user?.email}</p>
              </div>
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  signOut();
                }}
                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-white/5 transition-colors"
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
