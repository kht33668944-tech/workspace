"use client";

import { useRouter } from "next/navigation";
import type { ActivityEntry } from "@/hooks/use-dashboard";
import { getPlatformLabel, formatLogTime } from "@/lib/log-format";
import { setOrdersFilter } from "@/lib/dashboard-filters";
import SkeletonBlock from "./skeleton-block";

interface ActivityLogProps {
  activityLogs: ActivityEntry[];
  loading: boolean;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(d, today)) return "오늘";
  if (isSameDay(d, yesterday)) return "어제";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function getDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR");
}

function StatusDot({ successCount, failedCount }: { successCount: number; failedCount: number }) {
  if (failedCount === 0 && successCount > 0) {
    return <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0 mt-0.5" />;
  }
  if (successCount === 0 && failedCount > 0) {
    return <span className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0 mt-0.5" />;
  }
  return <span className="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0 mt-0.5" />;
}

function entryLabel(entry: ActivityEntry): string {
  if (entry.type === "marketplace") return entry.label;
  return entry.type === "purchase" ? "자동구매" : "운송장 수집";
}

function entryPlatform(entry: ActivityEntry): string {
  if (entry.type === "marketplace") {
    return entry.platform === "all" ? "쿠팡·스토어" : entry.platform === "coupang" ? "쿠팡" : entry.platform === "smartstore" ? "스토어" : entry.platform;
  }
  return getPlatformLabel(entry.platform);
}

export default function ActivityLog({ activityLogs, loading }: ActivityLogProps) {
  const router = useRouter();

  // 날짜별 그룹핑
  const dateMap = new Map<string, ActivityEntry[]>();
  for (const entry of activityLogs) {
    const key = getDateKey(entry.startedAt);
    if (!dateMap.has(key)) dateMap.set(key, []);
    dateMap.get(key)!.push(entry);
  }
  const grouped = Array.from(dateMap.entries()).map(([key, entries]) => ({
    dateKey: key,
    label: formatDate(entries[0].startedAt),
    entries,
  }));

  // 클릭 → 해당 작업에 포함된 주문만 필터된 발주서로 이동
  function handleClick(entry: ActivityEntry) {
    if (entry.type === "marketplace") {
      if (entry.targetNos.length > 0) {
        setOrdersFilter({ marketplace_product_order_no: entry.targetNos });
      }
      router.push("/workspace/orders?tab=orders");
      return;
    }
    if (entry.orderIds.length > 0) {
      setOrdersFilter({ id: entry.orderIds });
      router.push("/workspace/orders?tab=orders");
      return;
    }
    // 주문 연결이 없는 옛 배치는 기존처럼 로그 탭으로
    const tab = entry.type === "purchase" ? "logs" : "tracking-logs";
    router.push(`/workspace/orders?tab=${tab}&batch=${entry.batchId}`);
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 md:p-5">
      <p className="text-sm font-semibold text-[var(--text-secondary)] mb-4">활동 로그</p>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <SkeletonBlock className="w-2 h-2 rounded-full flex-shrink-0" />
              <SkeletonBlock className="h-4 w-16" />
              <SkeletonBlock className="h-4 flex-1" />
              <SkeletonBlock className="h-4 w-12" />
            </div>
          ))}
        </div>
      ) : activityLogs.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)] text-center py-6">
          아직 자동화 작업 기록이 없습니다.
        </p>
      ) : (
        <div className="overflow-y-auto max-h-56 space-y-4 pr-1">
          {grouped.map((group) => (
            <div key={group.dateKey}>
              <p className="text-xs font-medium text-[var(--text-muted)] mb-2">{group.label}</p>
              <div className="space-y-1">
                {group.entries.map((entry) => (
                  <button
                    key={`${entry.type}-${entry.batchId}`}
                    onClick={() => handleClick(entry)}
                    className="w-full flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-elevated)] transition-colors text-left group min-h-[44px]"
                  >
                    <StatusDot successCount={entry.successCount} failedCount={entry.failedCount} />
                    <span className="text-xs text-[var(--text-muted)] w-11 flex-shrink-0 pt-px">
                      {formatLogTime(entry.startedAt)}
                    </span>
                    <span className="text-xs font-medium text-[var(--text-secondary)] w-20 flex-shrink-0 pt-px">
                      {entryLabel(entry)}
                    </span>
                    <span className="text-xs text-[var(--text-muted)] w-16 flex-shrink-0 pt-px">
                      {entryPlatform(entry)}
                    </span>
                    <span className="text-xs text-[var(--text-primary)] flex-1 pt-px">
                      {entry.type === "marketplace" && entry.detail ? (
                        <span className="text-emerald-400">{entry.detail}</span>
                      ) : (
                        <>
                          {entry.successCount > 0 && (
                            <span className="text-emerald-400">성공 {entry.successCount}건</span>
                          )}
                          {entry.successCount > 0 && entry.failedCount > 0 && (
                            <span className="text-[var(--text-muted)]"> / </span>
                          )}
                          {entry.failedCount > 0 && (
                            <span className="text-red-400">실패 {entry.failedCount}건</span>
                          )}
                          {entry.type !== "marketplace" && entry.cancelledCount > 0 && (
                            <span className="text-[var(--text-muted)] ml-1">취소 {entry.cancelledCount}건</span>
                          )}
                        </>
                      )}
                    </span>
                    <span className="text-xs text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 pt-px">
                      주문 보기 →
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
