"use client";

// 자동화별 상태 카드 — 마지막 실행·7일 성공률·즉시 실행
import { useEffect, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { AUTOMATIONS, RUN_STATUS_LABEL, type AutomationKey, type SlotStatus } from "@/lib/automation-schedule";
import { timeAgo } from "@/lib/log-format";
import type { AutomationWeekStat } from "@/hooks/use-automation-runs";
import { useRunAutomation } from "./run-actions";

const STATUS_CLS: Record<string, string> = {
  success: "bg-emerald-500/10 text-emerald-400",
  partial: "bg-amber-500/10 text-amber-400",
  failed: "bg-red-500/10 text-red-400",
  running: "bg-blue-500/10 text-blue-400",
};

export default function AutomationStatusCards({ weekStats, onRefetch }: {
  weekStats: Record<AutomationKey, AutomationWeekStat>;
  onRefetch: () => Promise<void>;
}) {
  const { session } = useAuth();
  const [schtasksAvailable, setSchtasksAvailable] = useState(false);
  const { busyId, run } = useRunAutomation(onRefetch);

  useEffect(() => {
    if (!session?.access_token) return;
    fetch("/api/automation/run", { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((r) => r.json())
      .then((d: { available?: boolean }) => setSchtasksAvailable(!!d.available))
      .catch(() => setSchtasksAvailable(false));
  }, [session?.access_token]);

  return (
    <section>
      <h2 className="text-base font-semibold text-[var(--text-primary)] mb-3">자동화 상태</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {AUTOMATIONS.map((def) => {
          const stat = weekStats[def.key];
          const last = stat.lastRun;
          const badgeCls = last ? STATUS_CLS[last.status] : null;
          const disabled = def.runVia === null || (def.runVia === "schtasks" && !schtasksAvailable);
          return (
            <div key={def.key} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-[var(--text-primary)]">{def.label}</p>
                {stat.consecutiveFailures >= 2 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">연속 {stat.consecutiveFailures}회 실패</span>
                )}
              </div>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">{def.description}</p>
              <div className="flex items-center gap-2 text-xs">
                {last ? (
                  <>
                    <span className="text-[var(--text-muted)]">{timeAgo(last.started_at)}</span>
                    {badgeCls && <span className={`px-1.5 py-0.5 rounded ${badgeCls}`}>{RUN_STATUS_LABEL[last.status as SlotStatus]}</span>}
                    {last.dry_run && <span className="text-amber-400">DRY</span>}
                  </>
                ) : (
                  <span className="text-[var(--text-muted)]">최근 7일 실행 기록 없음</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-auto">
                {stat.successRate !== null ? (
                  <div className="flex-1 flex items-center gap-1.5">
                    <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${stat.successRate >= 90 ? "bg-emerald-400" : stat.successRate >= 60 ? "bg-amber-400" : "bg-red-400"}`}
                        style={{ width: `${stat.successRate}%` }}
                      />
                    </div>
                    <span className="text-xs text-[var(--text-muted)] tabular-nums">{stat.successRate}%</span>
                  </div>
                ) : <div className="flex-1" />}
                {def.runVia && (
                  <button
                    onClick={() => run(def.key)}
                    disabled={disabled || busyId !== null}
                    title={def.runVia === "schtasks" && !schtasksAvailable ? "로컬 PC에서만 실행 가능" : undefined}
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-active)] transition-colors disabled:opacity-40"
                  >
                    {busyId === def.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    지금 실행
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
