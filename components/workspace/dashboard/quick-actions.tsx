"use client";

import Link from "next/link";
import { setOrdersFilter } from "@/lib/dashboard-filters";

interface Action {
  icon: string;
  label: string;
  sub: string;
  filter?: Record<string, string[]>;
}

const ACTIONS: Action[] = [
  {
    icon: "📥",
    label: "엑셀 업로드",
    sub: "주문 데이터 가져오기",
  },
  {
    icon: "🤖",
    label: "자동구매",
    sub: "구매 가능 건 필터링",
    filter: { delivery_status: ["결제전"] },
  },
  {
    icon: "📦",
    label: "운송장 수집",
    sub: "수집 가능 건 필터링",
    filter: { delivery_status: ["배송준비"] },
  },
  {
    icon: "📊",
    label: "발주서 내보내기",
    sub: "엑셀 파일로 저장",
  },
];

export default function QuickActions() {
  return (
    <div>
      <p className="text-sm font-semibold text-[var(--text-secondary)] mb-3">빠른 액션</p>
      <div className="grid grid-cols-2 gap-3">
        {ACTIONS.map((action) => (
          <Link
            key={action.label}
            href="/workspace/orders"
            onClick={() => { if (action.filter) setOrdersFilter(action.filter); }}
            className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 flex flex-col items-center justify-center gap-2 text-center hover:border-blue-500/50 hover:bg-[var(--bg-hover)] transition-colors"
          >
            <span className="text-3xl">{action.icon}</span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{action.label}</span>
            <span className="text-xs text-[var(--text-muted)]">{action.sub}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
