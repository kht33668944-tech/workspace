"use client";

import Link from "next/link";
import { setOrdersFilter } from "@/lib/dashboard-filters";
import SkeletonBlock from "./skeleton-block";

interface KpiCardsProps {
  currentMonthCount: number;
  lastMonthCount: number;
  currentMonthRevenue: number;
  lastMonthRevenue: number;
  currentMonthMargin: number;
  lastMonthMargin: number;
  unpaidCount: number;
  loading: boolean;
}

function calcTrend(
  curr: number,
  last: number
): { pct: string; up: boolean } | null {
  if (last === 0) return null;
  const pct = ((curr - last) / Math.abs(last)) * 100;
  return { pct: Math.abs(pct).toFixed(1), up: pct >= 0 };
}

function formatKRW(value: number): string {
  return "₩" + value.toLocaleString("ko-KR");
}

function TrendBadge({
  trend,
}: {
  trend: { pct: string; up: boolean } | null;
}) {
  if (!trend) return null;
  return (
    <span
      className={`text-xs font-medium ${trend.up ? "text-green-400" : "text-red-400"}`}
    >
      {trend.up ? "▲" : "▼"} {trend.pct}%
    </span>
  );
}

export default function KpiCards({
  currentMonthCount,
  lastMonthCount,
  currentMonthRevenue,
  lastMonthRevenue,
  currentMonthMargin,
  lastMonthMargin,
  unpaidCount,
  loading,
}: KpiCardsProps) {
  const now = new Date();
  const monthLabel = `${now.getMonth() + 1}월`;

  const countTrend = calcTrend(currentMonthCount, lastMonthCount);
  const revenueTrend = calcTrend(currentMonthRevenue, lastMonthRevenue);
  const marginTrend = calcTrend(currentMonthMargin, lastMonthMargin);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      {/* 주문수 */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 md:p-5">
        <p className="text-xs text-[var(--text-muted)] mb-2">{monthLabel} 주문수</p>
        {loading ? (
          <SkeletonBlock className="h-7 w-16 mb-2" />
        ) : (
          <p className="text-2xl font-bold text-[var(--text-primary)] mb-1">
            {currentMonthCount.toLocaleString("ko-KR")}
            <span className="text-sm font-normal text-[var(--text-muted)] ml-1">건</span>
          </p>
        )}
        {loading ? (
          <SkeletonBlock className="h-4 w-14" />
        ) : (
          <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <TrendBadge trend={countTrend} />
            {countTrend && <span>전월 대비</span>}
          </div>
        )}
      </div>

      {/* 매출 */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 md:p-5">
        <p className="text-xs text-[var(--text-muted)] mb-2">{monthLabel} 매출</p>
        {loading ? (
          <SkeletonBlock className="h-7 w-28 mb-2" />
        ) : (
          <p className="text-2xl font-bold text-[var(--text-primary)] mb-1 truncate">
            {formatKRW(currentMonthRevenue)}
          </p>
        )}
        {loading ? (
          <SkeletonBlock className="h-4 w-14" />
        ) : (
          <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <TrendBadge trend={revenueTrend} />
            {revenueTrend && <span>전월 대비</span>}
          </div>
        )}
      </div>

      {/* 마진 */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 md:p-5">
        <p className="text-xs text-[var(--text-muted)] mb-2">
          {monthLabel} 마진{" "}
          <span className="text-[var(--text-disabled)]">(배송완료)</span>
        </p>
        {loading ? (
          <SkeletonBlock className="h-7 w-28 mb-2" />
        ) : (
          <p
            className={`text-2xl font-bold mb-1 truncate ${
              currentMonthMargin >= 0
                ? "text-[var(--text-primary)]"
                : "text-red-400"
            }`}
          >
            {formatKRW(currentMonthMargin)}
          </p>
        )}
        {loading ? (
          <SkeletonBlock className="h-4 w-14" />
        ) : (
          <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <TrendBadge trend={marginTrend} />
            {marginTrend && <span>전월 대비</span>}
          </div>
        )}
      </div>

      {/* 미처리 주문 */}
      <Link
        href="/workspace/orders"
        onClick={() =>
          setOrdersFilter({ delivery_status: ["결제전", "배송준비"] })
        }
        className="bg-[var(--bg-card)] border border-red-500/30 rounded-xl p-4 md:p-5 block hover:border-red-500/60 hover:bg-[var(--bg-hover)] transition-colors"
      >
        <p className="text-xs text-[var(--text-muted)] mb-2">미처리 주문</p>
        {loading ? (
          <SkeletonBlock className="h-7 w-16 mb-2" />
        ) : (
          <p className="text-2xl font-bold text-red-400 mb-1">
            {unpaidCount.toLocaleString("ko-KR")}
            <span className="text-sm font-normal text-[var(--text-muted)] ml-1">건</span>
          </p>
        )}
        {loading ? (
          <SkeletonBlock className="h-4 w-20" />
        ) : (
          <p className="text-xs text-[var(--text-muted)]">클릭하여 바로 확인 →</p>
        )}
      </Link>
    </div>
  );
}
