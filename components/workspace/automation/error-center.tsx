"use client";

// 오류 센터 — 최근 7일 실패·일부실패 실행 + 재시도
import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { MarketplaceSyncRun } from "@/types/database";
import { KIND_TO_KEY, AUTOMATIONS, type RunKind, type AutomationKey } from "@/lib/automation-schedule";
import { formatLogTime, formatLogDate, timeAgo } from "@/lib/log-format";
import RunDetail from "./run-detail";
import { runAutomation } from "./run-actions";

export default function ErrorCenter({ errorRuns, onRefetch, showToast }: {
  errorRuns: MarketplaceSyncRun[];
  onRefetch: () => Promise<void>;
  showToast: (msg: string) => void;
}) {
  const { session } = useAuth();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const retry = async (run: MarketplaceSyncRun) => {
    if (!session?.access_token || retrying) return;
    const key = KIND_TO_KEY[(run.kind ?? "orders") as RunKind];
    const def = AUTOMATIONS.find((d) => d.key === key);
    if (!key || !def?.runVia) { showToast("이 작업은 재시도 버튼을 지원하지 않습니다."); return; }
    setRetrying(run.id);
    try {
      const r = await runAutomation(key as AutomationKey, session.access_token);
      showToast(r.message);
      if (r.ok) setTimeout(() => { void onRefetch(); }, 3000);
    } finally {
      setRetrying(null);
    }
  };

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <h2 className="text-base font-semibold text-[var(--text-primary)] mb-3">오류 센터</h2>
      {errorRuns.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" /> 최근 7일 실패 없음
        </p>
      ) : (
        <div className="space-y-1">
          {errorRuns.map((run) => {
            const key = KIND_TO_KEY[(run.kind ?? "orders") as RunKind];
            const label = AUTOMATIONS.find((d) => d.key === key)?.label ?? run.kind;
            const isOpen = expanded === run.id;
            return (
              <div key={run.id}>
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--bg-hover)]">
                  <button onClick={() => setExpanded(isOpen ? null : run.id)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />}
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${run.status === "failed" || run.status === "running" ? "bg-red-500/10 text-red-400" : "bg-amber-500/10 text-amber-400"}`}>
                      {run.status === "partial" ? "일부 실패" : run.status === "running" ? "중단됨" : "실패"}
                    </span>
                    <span className="text-xs font-medium text-[var(--text-secondary)] shrink-0">{label}</span>
                    <span className="text-xs text-[var(--text-muted)] shrink-0">{formatLogDate(run.started_at.slice(0, 10))} {formatLogTime(run.started_at)} · {timeAgo(run.started_at)}</span>
                    {run.error && <span className="text-xs text-[var(--text-muted)] truncate">{run.error}</span>}
                  </button>
                  <button
                    onClick={() => retry(run)}
                    disabled={retrying !== null}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--text-secondary)] bg-[var(--bg-hover)] border border-[var(--border)] hover:bg-[var(--bg-active)] disabled:opacity-40"
                  >
                    {retrying === run.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    재시도
                  </button>
                </div>
                {isOpen && <div className="ml-7 my-1"><RunDetail runs={[run]} /></div>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
