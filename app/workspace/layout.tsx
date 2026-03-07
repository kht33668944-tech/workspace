"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import Sidebar from "@/components/workspace/sidebar";
import Header from "@/components/workspace/header";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <main className="w-screen h-screen flex items-center justify-center bg-[#171717]">
        <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
      </main>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-[#171717] dark:bg-[#171717]">
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
