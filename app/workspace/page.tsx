"use client";

import { LayoutDashboard } from "lucide-react";

export default function WorkspacePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-white/40">
      <LayoutDashboard className="w-16 h-16 mb-4" />
      <p className="text-lg font-medium">메인 대시보드</p>
      <p className="text-sm mt-1">추후 구현 예정</p>
    </div>
  );
}
