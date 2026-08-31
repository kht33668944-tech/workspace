"use client";

import Link from "next/link";
import { setOrdersFilter } from "@/lib/dashboard-filters";
import SkeletonBlock from "./skeleton-block";

// 오늘 할 일 — "사람이 결정해야 하는 것"만 카드로. 자동화가 알아서 하는 흐름(배송준비→배송완료)은 아래 현황 한 줄.
interface TodoFlowProps {
  unpurchasedCount: number;     // 구매대기
  reviewCount: number;          // 구매확인필요
  outOfStockCount: number;      // 발송불가
  shipDeadlineCount: number;    // 발송불가 중 발송기한 임박
  cancelRequestCount: number;   // 취소요청
  csCount: number;              // 반품준비 + 교환준비
  cancelPendingCount: number;   // 취소준비
  noTrackingCount: number;      // 배송준비 (자동 진행 현황)
  deliveredCount: number;       // 이번달 배송완료 (현황)
  loading: boolean;
}

interface CardProps {
  label: string;
  count: number;
  sub: string;
  accent: "orange" | "purple" | "amber" | "rose" | "red";
  badge?: string;
  loading: boolean;
  filter: Record<string, string[]>;
}

const ACCENT = {
  orange: { count: "text-orange-400", border: "border-orange-500/30 hover:border-orange-500/60" },
  purple: { count: "text-purple-400", border: "border-purple-500/30 hover:border-purple-500/60" },
  amber: { count: "text-amber-400", border: "border-amber-500/30 hover:border-amber-500/60" },
  rose: { count: "text-rose-400", border: "border-rose-500/30 hover:border-rose-500/60" },
  red: { count: "text-red-400", border: "border-red-500/30 hover:border-red-500/60" },
} as const;

function Card({ label, count, sub, accent, badge, loading, filter }: CardProps) {
  const active = count > 0;
  const a = ACCENT[accent];
  return (
    <Link
      href="/workspace/orders"
      onClick={() => setOrdersFilter(filter)}
      className={`bg-[var(--bg-card)] border rounded-xl px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors cursor-pointer min-w-0 min-h-[44px] ${active ? a.border : "border-[var(--border)] hover:border-blue-500/50"}`}
    >
      <p className="text-xs text-[var(--text-muted)] mb-1.5">{label}</p>
      {loading ? (
        <SkeletonBlock className="h-7 w-14 mb-1" />
      ) : (
        <p className={`text-2xl font-bold mb-0.5 ${active ? a.count : "text-[var(--text-primary)]"}`}>
          {count.toLocaleString("ko-KR")}
          <span className="text-sm font-normal text-[var(--text-muted)] ml-1">건</span>
          {badge && <span className="ml-2 text-xs font-semibold text-red-400 align-middle">{badge}</span>}
        </p>
      )}
      <p className="text-xs text-[var(--text-muted)] truncate">{sub}</p>
    </Link>
  );
}

export default function TodoFlow({
  unpurchasedCount,
  reviewCount,
  outOfStockCount,
  shipDeadlineCount,
  cancelRequestCount,
  csCount,
  cancelPendingCount,
  noTrackingCount,
  deliveredCount,
  loading,
}: TodoFlowProps) {
  const totalTodo = unpurchasedCount + reviewCount + outOfStockCount + cancelRequestCount + csCount + cancelPendingCount;
  const allClear = !loading && totalTodo === 0;

  return (
    <div>
      <p className="text-sm font-semibold text-[var(--text-secondary)] mb-3">
        오늘 할 일{allClear && <span className="ml-2 text-green-400 font-medium">✅ 전부 처리됨</span>}
      </p>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <Card
          label="구매대기" count={unpurchasedCount} sub="자동구매 실행" accent="orange"
          loading={loading} filter={{ delivery_status: ["구매대기"] }}
        />
        <Card
          label="구매확인필요" count={reviewCount} sub="자동구매 이상 확인" accent="purple"
          loading={loading} filter={{ delivery_status: ["구매확인필요"] }}
        />
        <Card
          label="발송불가" count={outOfStockCount} sub="취소 또는 발송 결정" accent="amber"
          badge={shipDeadlineCount > 0 ? `⚠️ 기한임박 ${shipDeadlineCount}` : undefined}
          loading={loading} filter={{ delivery_status: ["발송불가"] }}
        />
        <Card
          label="취소요청" count={cancelRequestCount} sub="승인/거절 판단" accent="rose"
          loading={loading} filter={{ delivery_status: ["취소요청"] }}
        />
        <Card
          label="CS 처리" count={csCount} sub="반품·교환 준비" accent="red"
          loading={loading} filter={{ delivery_status: ["교환준비", "반품준비"] }}
        />
        <Card
          label="취소준비" count={cancelPendingCount} sub="마켓 취소 실행" accent="red"
          loading={loading} filter={{ delivery_status: ["취소준비"] }}
        />
      </div>
      <p className="text-xs text-[var(--text-muted)] mt-2">
        자동 진행 중 — 배송준비 {loading ? "…" : noTrackingCount.toLocaleString("ko-KR")}건 · 이번달 배송완료 {loading ? "…" : deliveredCount.toLocaleString("ko-KR")}건
      </p>
    </div>
  );
}
