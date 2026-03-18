"use client";

import Link from "next/link";
import { setOrdersFilter } from "@/lib/dashboard-filters";
import SkeletonBlock from "./skeleton-block";

interface TodoFlowProps {
  unpurchasedCount: number;
  noTrackingCount: number;
  deliveredCount: number;
  csCount: number;
  loading: boolean;
}

interface StepProps {
  label: string;
  count: number;
  sub: string;
  countColor?: string;
  borderColor?: string;
  loading: boolean;
  filter?: Record<string, string[]>;
}

function Step({ label, count, sub, countColor, borderColor, loading, filter }: StepProps) {
  return (
    <Link
      href="/workspace/orders"
      onClick={() => { if (filter) setOrdersFilter(filter); }}
      className={`flex-1 bg-[var(--bg-card)] border rounded-xl px-5 py-4 hover:bg-[var(--bg-hover)] transition-colors cursor-pointer min-w-0 ${borderColor ?? "border-[var(--border)] hover:border-blue-500/50"}`}
    >
      <p className="text-xs text-[var(--text-muted)] mb-2">{label}</p>
      {loading ? (
        <SkeletonBlock className="h-7 w-14 mb-1" />
      ) : (
        <p className={`text-2xl font-bold mb-1 ${countColor ?? "text-[var(--text-primary)]"}`}>
          {count.toLocaleString("ko-KR")}
          <span className="text-sm font-normal text-[var(--text-muted)] ml-1">건</span>
        </p>
      )}
      <p className="text-xs text-[var(--text-muted)]">{sub}</p>
    </Link>
  );
}

function Arrow() {
  return (
    <div className="hidden md:flex items-center text-[var(--text-muted)] px-2 text-lg">→</div>
  );
}

export default function TodoFlow({
  unpurchasedCount,
  noTrackingCount,
  deliveredCount,
  csCount,
  loading,
}: TodoFlowProps) {
  return (
    <div>
      <p className="text-sm font-semibold text-[var(--text-secondary)] mb-3">오늘 할일</p>
      <div className="flex flex-col md:flex-row items-stretch gap-2 md:gap-0">
        <Step
          label="결제 전"
          count={unpurchasedCount}
          sub="구매 처리 필요"
          countColor={unpurchasedCount > 0 ? "text-orange-400" : undefined}
          loading={loading}
          filter={{ delivery_status: ["결제전"] }}
        />
        <Arrow />
        <Step
          label="배송준비중"
          count={noTrackingCount}
          sub="운송장 수집 필요"
          countColor={noTrackingCount > 0 ? "text-yellow-400" : undefined}
          loading={loading}
          filter={{ delivery_status: ["배송준비"] }}
        />
        <Arrow />
        <Step
          label="배송완료"
          count={deliveredCount}
          sub="이번달 완료"
          countColor="text-green-400"
          loading={loading}
          filter={{ delivery_status: ["배송완료"] }}
        />

        {/* CS 구분선 */}
        <div className="hidden md:flex items-center px-2">
          <div className="w-px h-10 bg-[var(--border)]" />
        </div>

        <Step
          label="CS 처리"
          count={csCount}
          sub="교환·반품 준비"
          countColor={csCount > 0 ? "text-red-400" : undefined}
          borderColor={csCount > 0 ? "border-red-500/30 hover:border-red-500/60" : "border-[var(--border)] hover:border-red-400/50"}
          loading={loading}
          filter={{ delivery_status: ["교환준비", "반품준비"] }}
        />
      </div>
    </div>
  );
}
