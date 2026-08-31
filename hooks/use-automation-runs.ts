"use client";

// 자동화 페이지 데이터 훅 — 최근 7일 marketplace_sync_runs 조회 + 타임라인/통계 계산
// running 행이 있으면 5초, 없으면 60초 간격 폴링

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { MarketplaceSyncRun } from "@/types/database";
import {
  AUTOMATIONS, KIND_TO_KEY, buildTodayTimeline, nextScheduledRun, isStaleRunning,
  type AutomationKey, type RunKind, type TimelineSlot, type AutomationDef,
} from "@/lib/automation-schedule";

export interface AutomationWeekStat {
  total: number;
  success: number;
  partial: number;
  failed: number;
  successRate: number | null; // total 0이면 null
  lastRun: MarketplaceSyncRun | null;
  consecutiveFailures: number;
}

export function useAutomationRuns() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<MarketplaceSyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const runsRef = useRef<MarketplaceSyncRun[]>([]);

  const userId = user?.id;

  const fetchRuns = useCallback(async () => {
    if (!userId) return;
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data, error } = await supabase
      .from("marketplace_sync_runs")
      .select("*")
      .eq("user_id", userId)
      .gte("started_at", sevenDaysAgo)
      .neq("kind", "health-alert")
      .order("started_at", { ascending: false })
      .limit(1000);
    if (error) {
      console.error("[use-automation-runs] 조회 실패:", error.message);
      return;
    }
    runsRef.current = (data ?? []) as MarketplaceSyncRun[];
    setRuns(runsRef.current);
    setLoading(false);
  }, [userId]);

  // 폴링: running 있으면 5초, 없으면 60초
  useEffect(() => {
    if (!userId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      await fetchRuns();
      if (stopped) return;
      const hasRunning = runsRef.current.some((r) => r.status === "running" && !isStaleRunning(r));
      timer = setTimeout(tick, hasRunning ? 5000 : 60000);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [userId, fetchRuns]);

  const derived = useMemo(() => {
    const now = new Date();
    const todayTimeline: TimelineSlot[] = buildTodayTimeline(runs, now);
    const runningRuns = runs.filter((r) => r.status === "running" && !isStaleRunning(r, now));
    const staleRuns = runs.filter((r) => r.status === "running" && isStaleRunning(r, now));
    const errorRuns = runs
      .filter((r) => !r.dry_run && (r.status === "failed" || r.status === "partial" || isStaleRunning(r, now)))
      .slice(0, 20);

    const weekStats = {} as Record<AutomationKey, AutomationWeekStat>;
    for (const def of AUTOMATIONS) {
      const mine = runs.filter((r) => KIND_TO_KEY[(r.kind ?? "orders") as RunKind] === def.key && !r.dry_run);
      const finished = mine.filter((r) => r.status !== "running");
      const success = finished.filter((r) => r.status === "success").length;
      const partial = finished.filter((r) => r.status === "partial").length;
      const failed = finished.filter((r) => r.status === "failed").length + mine.filter((r) => isStaleRunning(r, now)).length;
      let consecutiveFailures = 0;
      for (const r of mine) {
        if (r.status === "running" && !isStaleRunning(r, now)) continue;
        if (r.status === "failed" || isStaleRunning(r, now)) consecutiveFailures++;
        else break;
      }
      weekStats[def.key] = {
        total: finished.length,
        success, partial, failed,
        successRate: finished.length > 0 ? Math.round((success / finished.length) * 100) : null,
        lastRun: mine[0] ?? null,
        consecutiveFailures,
      };
    }
    const nextRun = nextScheduledRun(now);
    return { todayTimeline, runningRuns, staleRuns, errorRuns, weekStats, nextRun };
  }, [runs]);

  return { runs, loading, refetch: fetchRuns, ...derived };
}

export type { TimelineSlot, AutomationDef };
