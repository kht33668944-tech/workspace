"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Search, X, CheckCircle, AlertCircle, Square, ChevronDown, ChevronRight, Loader2, History } from "lucide-react";
import { usePurchaseLogs } from "@/hooks/use-purchase-logs";
import { formatLogDate, formatLogTime, getPlatformLabel } from "@/lib/log-format";
import type { PurchaseLog } from "@/types/database";

export default function PurchaseLogTab({ initialBatchId }: { initialBatchId?: string | null }) {
  // 검색
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  // 필터
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // 아코디언
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(
    initialBatchId ? new Set([initialBatchId]) : new Set()
  );
  const batchRef = useRef<HTMLDivElement | null>(null);

  const { groupedByDay, loading } = usePurchaseLogs({
    search: activeSearch || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    platform: platformFilter,
    status: statusFilter,
  });

  // initialBatchId가 있으면 로드 완료 후 해당 배치로 스크롤
  useEffect(() => {
    if (!initialBatchId || loading) return;
    const id = setTimeout(() => {
      batchRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => clearTimeout(id);
  }, [initialBatchId, loading]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") setActiveSearch(search);
  }, [search]);

  const handleSearchClear = useCallback(() => {
    setSearch("");
    setActiveSearch("");
  }, []);

  const toggleBatch = useCallback((batchId: string) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }, []);

  const totalLogs = groupedByDay.reduce(
    (sum, day) => sum + day.batches.reduce((s, b) => s + b.logs.length, 0),
    0
  );

  return (
    <div className="space-y-4">
      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 검색 */}
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="수취인, 상품명, 주문번호 검색 (Enter)"
            className="w-full pl-9 pr-8 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50"
          />
          {search && (
            <button onClick={handleSearchClear} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 날짜 범위 */}
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="px-2 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] outline-none focus:border-blue-500/50"
        />
        <span className="text-xs text-[var(--text-muted)]">~</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="px-2 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] outline-none focus:border-blue-500/50"
        />

        {/* 플랫폼 필터 */}
        <select
          value={platformFilter || ""}
          onChange={(e) => setPlatformFilter(e.target.value || null)}
          className="px-2 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] outline-none focus:border-blue-500/50"
        >
          <option value="">전체 플랫폼</option>
          <option value="gmarket">지마켓</option>
          <option value="ohouse">오늘의집</option>
        </select>

        {/* 상태 필터 */}
        <select
          value={statusFilter || ""}
          onChange={(e) => setStatusFilter(e.target.value || null)}
          className="px-2 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] outline-none focus:border-blue-500/50"
        >
          <option value="">전체 상태</option>
          <option value="success">성공</option>
          <option value="failed">실패</option>
          <option value="cancelled">중단</option>
        </select>
      </div>

      {/* 활성 필터 안내 */}
      {(activeSearch || dateFrom || dateTo || platformFilter || statusFilter) && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span>총 {totalLogs}건</span>
          {activeSearch && (
            <span className="px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded">
              &quot;{activeSearch}&quot;
            </span>
          )}
          <button
            onClick={() => {
              handleSearchClear();
              setDateFrom("");
              setDateTo("");
              setPlatformFilter(null);
              setStatusFilter(null);
            }}
            className="text-blue-400 hover:underline"
          >
            필터 초기화
          </button>
        </div>
      )}

      {/* 로딩 */}
      {loading && (
        <div className="flex items-center justify-center py-12 text-[var(--text-muted)]">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">로드 중...</span>
        </div>
      )}

      {/* 빈 상태 */}
      {!loading && groupedByDay.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-[var(--text-muted)]">
          <History className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">구매 로그가 없습니다.</p>
          <p className="text-xs mt-1 opacity-60">자동구매를 실행하면 여기에 이력이 기록됩니다.</p>
        </div>
      )}

      {/* 타임라인 */}
      {!loading && groupedByDay.map((day) => (
        <div key={day.date} className="space-y-2">
          {/* 날짜 헤더 */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-[var(--border)]" />
            <span className="text-xs font-medium text-[var(--text-muted)] shrink-0">
              {formatLogDate(day.date)}
            </span>
            <div className="h-px flex-1 bg-[var(--border)]" />
          </div>

          {/* 배치 목록 */}
          {day.batches.map((batch) => {
            const isExpanded = expandedBatches.has(batch.batchId);
            const isTarget = batch.batchId === initialBatchId;

            return (
              <div
                key={batch.batchId}
                ref={isTarget ? batchRef : null}
                className={`border rounded-lg overflow-hidden ${isTarget ? "border-blue-500/50" : "border-[var(--border)]"}`}
              >
                {/* 배치 헤더 */}
                <button
                  onClick={() => toggleBatch(batch.batchId)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 bg-[var(--bg-hover)] hover:bg-[var(--bg-active)] transition-colors text-left"
                >
                  {isExpanded
                    ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                  }
                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                    {formatLogTime(batch.createdAt)}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-active)] text-[var(--text-tertiary)]">
                    {getPlatformLabel(batch.platform)}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">{batch.loginId}</span>
                  <div className="ml-auto flex items-center gap-2 text-xs">
                    {batch.successCount > 0 && (
                      <span className="text-green-400">{batch.successCount}건 성공</span>
                    )}
                    {batch.failCount > 0 && (
                      <span className="text-red-400">{batch.failCount}건 실패</span>
                    )}
                    {batch.cancelledCount > 0 && (
                      <span className="text-yellow-400">{batch.cancelledCount}건 중단</span>
                    )}
                    {batch.totalCost > 0 && (
                      <span className="text-[var(--text-muted)]">
                        총 {batch.totalCost.toLocaleString()}원
                      </span>
                    )}
                  </div>
                </button>

                {/* 배치 내 개별 로그 */}
                {isExpanded && (
                  <div className="border-t border-[var(--border)]">
                    {batch.logs.map((log) => (
                      <LogRow key={log.id} log={log} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function LogRow({ log }: { log: PurchaseLog }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-[var(--bg-hover)] transition-colors">
      {/* 상태 아이콘 */}
      {log.status === "success" && <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />}
      {log.status === "failed" && <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
      {log.status === "cancelled" && <Square className="w-3.5 h-3.5 text-yellow-400 shrink-0" />}

      {/* 시간 */}
      <span className="text-[var(--text-muted)] w-11 shrink-0">{formatLogTime(log.created_at)}</span>

      {/* 수취인 */}
      <span className="text-[var(--text-tertiary)] w-16 shrink-0 truncate">{log.recipient_name || "-"}</span>

      {/* 상품명 */}
      <span className="text-[var(--text-secondary)] flex-1 truncate" title={log.product_name || ""}>
        {log.product_name || "-"}
      </span>

      {/* 주문번호 / 에러 */}
      {log.status === "success" && log.purchase_order_no && (
        <span className="text-green-400 shrink-0">주문번호: {log.purchase_order_no}</span>
      )}
      {log.status === "failed" && log.error_message && (
        <span className="text-red-400 shrink-0 max-w-48 truncate" title={log.error_message}>
          {log.error_message}
        </span>
      )}
      {log.status === "cancelled" && (
        <span className="text-yellow-400 shrink-0">중단됨</span>
      )}

      {/* 원가 */}
      {log.cost != null && log.cost > 0 && (
        <span className="text-[var(--text-muted)] shrink-0">{log.cost.toLocaleString()}원</span>
      )}
    </div>
  );
}
