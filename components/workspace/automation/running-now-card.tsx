"use client";

// 지금 진행 중 카드 — 실행 중 작업 실시간 표시, 없으면 다음 예정 카운트다운
import { useEffect, useState } from "react";
import { Loader2, Clock, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { MarketplaceSyncRun } from "@/types/database";
import { KIND_TO_KEY, AUTOMATIONS, type RunKind, type AutomationDef } from "@/lib/automation-schedule";
import { formatLogTime, timeAgo } from "@/lib/log-format";

interface PriceRound { round: number; collected: number; soldOut: number; retry: number }

const PHASE_LABEL: Record<string, string> = {
  init: "시작 중",
  reset: "전일대비 초기화",
  scrape: "최저가 수집",
  apply: "가격 적용",
  margins: "품절/재입고 마진 처리",
  market: "마켓 API 반영",
  excel: "엑셀 저장",
};

function runLabel(run: MarketplaceSyncRun): string {
  const key = KIND_TO_KEY[(run.kind ?? "orders") as RunKind];
  return AUTOMATIONS.find((d) => d.key === key)?.label ?? run.kind ?? "자동화";
}

function priceProgress(run: MarketplaceSyncRun): string | null {
  const d = (run.detail ?? {}) as Record<string, unknown>;
  const phase = typeof d.phase === "string" ? d.phase : "init";
  if (phase === "scrape") {
    const rounds = ((d.scrape as { rounds?: PriceRound[] } | undefined)?.rounds) ?? [];
    const last = rounds[rounds.length - 1];
    if (last) {
      return last.round === 0
        ? `1차 수집 완료 — ${last.collected}건 수집 · 재시도 대상 ${last.retry}건`
        : `재시도 ${last.round}회차 — 수집 ${last.collected}건 · 남은 차단/실패 ${last.retry}건`;
    }
    return "최저가 수집 중";
  }
  return PHASE_LABEL[phase] ?? null;
}

function elapsedText(startedAt: string, now: number): string {
  const min = Math.floor((now - new Date(startedAt).getTime()) / 60000);
  return min < 1 ? "방금 시작" : `${min}분 경과`;
}

export default function RunningNowCard({ runningRuns, staleRuns, nextRun, onRefetch }: {
  runningRuns: MarketplaceSyncRun[];
  staleRuns: MarketplaceSyncRun[];
  nextRun: { def: AutomationDef; at: string } | null;
  onRefetch: () => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const cleanupStale = async (run: MarketplaceSyncRun) => {
    if (cleaning) return;
    setCleaning(true);
    try {
      const { error } = await supabase.from("marketplace_sync_runs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error: "프로세스 중단 감지 (수동 정리)" })
        .eq("id", run.id);
      if (error) console.error("[automation] 좀비 정리 실패:", error.message);
      await onRefetch();
    } finally {
      setCleaning(false);
    }
  };

  const countdown = () => {
    if (!nextRun) return null;
    const diff = new Date(nextRun.at).getTime() - now;
    if (diff <= 0) return "곧 시작";
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return h > 0 ? `${h}시간 ${m}분 후` : m > 0 ? `${m}분 ${s}초 후` : `${s}초 후`;
  };

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      {runningRuns.length > 0 ? (
        <div className="space-y-3">
          {runningRuns.map((run) => (
            <div key={run.id} className="flex items-start gap-3">
              <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  {runLabel(run)} 실행 중
                  <span className="text-xs font-normal text-[var(--text-muted)] ml-2">{formatLogTime(run.started_at)} 시작 · {elapsedText(run.started_at, now)}</span>
                </p>
                {run.kind === "price" && (
                  <p className="text-xs text-blue-400 mt-0.5">{priceProgress(run)}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Clock className="w-5 h-5 text-[var(--text-muted)] shrink-0" />
          <p className="text-sm text-[var(--text-secondary)]">
            지금 실행 중인 자동화 없음
            {nextRun && (
              <span className="text-[var(--text-muted)]">
                {" · "}다음: <b className="text-[var(--text-primary)]">{nextRun.def.label}</b> {formatLogTime(nextRun.at)} ({countdown()})
              </span>
            )}
          </p>
        </div>
      )}
      {staleRuns.map((run) => (
        <div key={run.id} className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{runLabel(run)}이(가) {timeAgo(run.started_at)}({formatLogTime(run.started_at)}) 시작된 뒤 응답이 없습니다 (프로세스 중단 의심)</span>
          <button onClick={() => cleanupStale(run)} disabled={cleaning} className="shrink-0 px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50">
            실패로 정리
          </button>
        </div>
      ))}
    </section>
  );
}
