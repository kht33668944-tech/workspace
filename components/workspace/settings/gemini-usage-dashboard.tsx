"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw, Sparkles, ExternalLink } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface SourceRow {
  callSource: string;
  promptTokens: number;
  candidateTokens: number;
  imageCount: number;
  costUsd: number;
  costKrw: number;
}

interface DaySummary {
  date: string;
  costKrw: number;
}

interface UsageSummary {
  month: {
    from: string;
    to: string;
    totalPromptTokens: number;
    totalCandidateTokens: number;
    totalImageCount: number;
    estimatedCostUsd: number;
    estimatedCostKrw: number;
  };
  bySource: SourceRow[];
  last7Days: DaySummary[];
}

const SOURCE_LABELS: Record<string, string> = {
  product_name_normalize: "상품명 정규화",
  thumbnail_gen: "썸네일 생성",
  detail_html: "상세페이지 생성",
  category_classify: "카테고리 분류",
  ohouse_purchase: "오늘의집 자동구매",
  unknown: "미분류",
};

function labelOf(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function formatNumber(n: number): string {
  return n.toLocaleString("ko-KR");
}

export default function GeminiUsageDashboard() {
  const { session } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gemini-usage/summary", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "조회 실패");
        setData(null);
      } else {
        const json = (await res.json()) as UsageSummary;
        setData(json);
      }
    } catch (e) {
      console.error("[gemini-usage-dashboard]", e instanceof Error ? e.message : String(e));
      setError("네트워크 오류");
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (expanded && !initialized) {
      fetchSummary();
    }
  }, [expanded, initialized, fetchSummary]);

  const maxSourceCost = data?.bySource.reduce((m, s) => Math.max(m, s.costKrw), 0) ?? 0;
  const max7DayCost = data?.last7Days.reduce((m, d) => Math.max(m, d.costKrw), 0) ?? 0;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 min-h-[44px] hover:bg-[var(--bg-subtle)] transition-colors rounded-2xl"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-emerald-400" />
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Gemini API 사용량</h2>
          <span className="text-xs text-[var(--text-muted)] ml-1">이번 달 토큰/예상 비용</span>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-[var(--text-muted)]" />
        ) : (
          <ChevronDown className="w-5 h-5 text-[var(--text-muted)]" />
        )}
      </button>

      {expanded && (
        <div className="px-6 pb-6 space-y-5 border-t border-[var(--border)] pt-5">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-[var(--text-muted)] animate-spin" />
            </div>
          )}

          {!loading && error && (
            <div className="text-xs text-red-400 py-4">
              {error}
              <button
                onClick={fetchSummary}
                className="ml-2 underline text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                다시 시도
              </button>
            </div>
          )}

          {!loading && !error && data && (
            <>
              {/* 1) 이번 달 예상 비용 */}
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">이번 달 예상 비용</div>
                <div className="flex items-baseline gap-3">
                  <span className="text-3xl font-bold text-[var(--text-primary)]">
                    ₩{formatNumber(data.month.estimatedCostKrw)}
                  </span>
                  <span className="text-sm text-[var(--text-muted)]">
                    ${data.month.estimatedCostUsd.toFixed(2)}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--text-disabled)] mt-1">
                  {data.month.from} ~ {data.month.to} · 환율 1,380원 가정 · 실제 청구액과 다를 수 있음
                </div>
              </div>

              {/* 2) 토큰 사용량 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-[var(--bg-hover)] rounded-lg p-3">
                  <div className="text-[11px] text-[var(--text-muted)]">입력 토큰</div>
                  <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">
                    {formatNumber(data.month.totalPromptTokens)}
                  </div>
                </div>
                <div className="bg-[var(--bg-hover)] rounded-lg p-3">
                  <div className="text-[11px] text-[var(--text-muted)]">출력 토큰</div>
                  <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">
                    {formatNumber(data.month.totalCandidateTokens)}
                  </div>
                </div>
                <div className="bg-[var(--bg-hover)] rounded-lg p-3">
                  <div className="text-[11px] text-[var(--text-muted)]">생성 이미지</div>
                  <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">
                    {formatNumber(data.month.totalImageCount)}장
                  </div>
                </div>
              </div>

              {/* 3) 기능별 비용 */}
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-2">기능별 비용 (이번 달)</div>
                {data.bySource.length === 0 ? (
                  <div className="text-xs text-[var(--text-disabled)] py-3">
                    이번 달 사용 내역이 없습니다.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {data.bySource.map((s) => {
                      const pct = maxSourceCost > 0 ? (s.costKrw / maxSourceCost) * 100 : 0;
                      const totalPct = data.month.estimatedCostKrw > 0
                        ? Math.round((s.costKrw / data.month.estimatedCostKrw) * 100)
                        : 0;
                      return (
                        <div key={s.callSource} className="text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[var(--text-secondary)]">{labelOf(s.callSource)}</span>
                            <span className="text-[var(--text-muted)]">
                              ₩{formatNumber(s.costKrw)} <span className="text-[var(--text-disabled)]">({totalPct}%)</span>
                            </span>
                          </div>
                          <div className="h-1.5 bg-[var(--bg-hover)] rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-500/70"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 4) 최근 7일 추이 */}
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-2">최근 7일 추이</div>
                <div className="flex items-end gap-1 h-24">
                  {data.last7Days.map((d) => {
                    const h = max7DayCost > 0 ? (d.costKrw / max7DayCost) * 100 : 0;
                    return (
                      <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full flex-1 flex items-end">
                          <div
                            className="w-full bg-emerald-500/60 rounded-t"
                            style={{ height: `${Math.max(h, 2)}%` }}
                            title={`${d.date}: ₩${formatNumber(d.costKrw)}`}
                          />
                        </div>
                        <div className="text-[10px] text-[var(--text-disabled)]">
                          {d.date.slice(5)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 5) GCP 콘솔 링크 + 새로고침 */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--border)]">
                <a
                  href="https://console.cloud.google.com/billing"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 min-h-[36px] bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  GCP 콘솔에서 실제 청구액 확인
                </a>
                <a
                  href="https://console.cloud.google.com/billing/payment-methods"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 min-h-[36px] bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  결제 수단 관리
                </a>
                <button
                  onClick={fetchSummary}
                  disabled={loading}
                  className="ml-auto flex items-center gap-1.5 px-3 min-h-[36px] bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                  새로고침
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
