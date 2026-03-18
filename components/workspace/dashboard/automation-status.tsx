"use client";

import Link from "next/link";
import type { DashboardFailedLog } from "@/hooks/use-dashboard";
import { PLATFORM_LABELS } from "@/types/database";
import type { PurchasePlatform } from "@/types/database";
import SkeletonBlock from "./skeleton-block";

interface AutomationStatusProps {
  unpurchasedCount: number;
  noTrackingCount: number;
  failedLogs: DashboardFailedLog[];
  loading: boolean;
}

interface StatBoxProps {
  label: string;
  count: number;
  countColor: string;
  loading: boolean;
}

function StatBox({ label, count, countColor, loading }: StatBoxProps) {
  return (
    <div className="bg-[var(--bg-elevated)] rounded-xl p-4 flex items-center justify-between">
      <div>
        <p className="text-xs text-[var(--text-muted)] mb-1">{label}</p>
        {loading ? (
          <SkeletonBlock className="h-6 w-12" />
        ) : (
          <p className={`text-xl font-bold ${countColor}`}>
            {count.toLocaleString("ko-KR")}
            <span className="text-xs font-normal text-[var(--text-muted)] ml-1">건</span>
          </p>
        )}
      </div>
      <Link
        href="/workspace/orders"
        className="text-xs text-blue-400 hover:underline whitespace-nowrap"
      >
        발주서로 이동 →
      </Link>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AutomationStatus({
  unpurchasedCount,
  noTrackingCount,
  failedLogs,
  loading,
}: AutomationStatusProps) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 md:p-5">
      <p className="text-sm font-semibold text-[var(--text-secondary)] mb-4">자동화 현황</p>

      <div className="grid grid-cols-2 gap-3 mb-5">
        <StatBox
          label="미구매"
          count={unpurchasedCount}
          countColor={unpurchasedCount > 0 ? "text-orange-400" : "text-[var(--text-primary)]"}
          loading={loading}
        />
        <StatBox
          label="운송장 미수집"
          count={noTrackingCount}
          countColor={noTrackingCount > 0 ? "text-yellow-400" : "text-[var(--text-primary)]"}
          loading={loading}
        />
      </div>

      <div>
        <p className="text-xs font-medium text-[var(--text-muted)] mb-2">최근 실패 구매 로그</p>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <SkeletonBlock className="h-4 flex-1" />
                <SkeletonBlock className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : failedLogs.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] text-center py-4">
            최근 실패한 자동구매가 없습니다.
          </p>
        ) : (
          <div>
            <div className="grid grid-cols-[1fr_60px_1fr_80px] gap-2 text-xs text-[var(--text-muted)] font-medium pb-1 border-b border-[var(--border-subtle)]">
              <span>상품명</span>
              <span>플랫폼</span>
              <span>오류</span>
              <span className="text-right">시간</span>
            </div>
            {failedLogs.map((log) => (
              <div
                key={log.id}
                className="grid grid-cols-[1fr_60px_1fr_80px] gap-2 py-2 text-xs border-b border-[var(--border-subtle)] last:border-0"
              >
                <span
                  className="text-[var(--text-primary)] truncate"
                  title={log.product_name ?? ""}
                >
                  {log.product_name ?? "-"}
                </span>
                <span className="text-[var(--text-secondary)]">
                  {PLATFORM_LABELS[log.platform as PurchasePlatform] ?? log.platform}
                </span>
                <span
                  className="text-red-400 truncate"
                  title={log.error_message ?? ""}
                >
                  {log.error_message ?? "-"}
                </span>
                <span className="text-[var(--text-muted)] text-right">
                  {formatTime(log.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
