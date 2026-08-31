"use client";

// 자동화 페이지 데이터 훅 — 최근 7일 marketplace_sync_runs 조회 + 타임라인/통계 계산
// running 행이 있으면 5초, 없으면 60초 간격 폴링.
// 5초 tick 은 running 행만 좁혀 조회해 머지하고(대부분 detail.phase 만 변함),
// running 이 종료됐거나 60초 tick 이면 7일 전체를 다시 가져온다.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { MarketplaceSyncRun } from "@/types/database";
import {
  AUTOMATIONS, KIND_TO_KEY, buildTodayTimeline, nextScheduledRun, isStaleRunning,
  type AutomationKey, type RunKind, type TimelineSlot,
} from "@/lib/automation-schedule";

export interface AutomationWeekStat {
  successRate: number | null; // 완료 실행 0이면 null
  lastRun: MarketplaceSyncRun | null;
  consecutiveFailures: number;
}

/** 내용이 실제로 바뀌었을 때만 setRuns 하기 위한 저렴한 시그니처 (running 행은 detail 변화까지 포함) */
function runsSignature(rows: MarketplaceSyncRun[]): string {
  return rows
    .map((r) => `${r.id}:${r.status}:${r.finished_at ?? ""}${r.status === "running" ? `:${JSON.stringify(r.detail)}` : ""}`)
    .join("|");
}

export function useAutomationRuns() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<MarketplaceSyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const runsRef = useRef<MarketplaceSyncRun[]>([]); // 폴링 주기 판단용 최신값 (외부 refetch 도 반영)

  const userId = user?.id;

  const applyRuns = useCallback((data: MarketplaceSyncRun[]) => {
    runsRef.current = data;
    setRuns((prev) => (runsSignature(prev) === runsSignature(data) ? prev : data));
    setLoading(false);
  }, []);

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
    applyRuns((data ?? []) as MarketplaceSyncRun[]);
  }, [userId, applyRuns]);

  // 폴링: running 있으면 5초(running 행만 조회), 없으면 60초(전체)
  useEffect(() => {
    if (!userId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async () => {
      const hasRunning = runsRef.current.some((r) => r.status === "running" && !isStaleRunning(r));
      if (!hasRunning) {
        await fetchRuns();
      } else {
        const { data, error } = await supabase
          .from("marketplace_sync_runs")
          .select("*")
          .eq("user_id", userId)
          .eq("status", "running")
          .neq("kind", "health-alert");
        if (!error) {
          const fresh = (data ?? []) as MarketplaceSyncRun[];
          const freshById = new Map(fresh.map((r) => [r.id, r]));
          const ended = runsRef.current.some((r) => r.status === "running" && !freshById.has(r.id));
          if (ended) {
            await fetchRuns(); // 종료 전이 → 최종 상태(성공/실패·detail)를 전체 조회로 반영
          } else {
            const known = new Set(runsRef.current.map((r) => r.id));
            applyRuns([
              ...fresh.filter((r) => !known.has(r.id)), // 새로 시작된 실행은 맨 앞(최신순 유지)
              ...runsRef.current.map((r) => freshById.get(r.id) ?? r),
            ]);
          }
        }
      }
      if (stopped) return;
      const nextHasRunning = runsRef.current.some((r) => r.status === "running" && !isStaleRunning(r));
      timer = setTimeout(tick, nextHasRunning ? 5000 : 60000);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [userId, fetchRuns, applyRuns]);

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
      let consecutiveFailures = 0;
      for (const r of mine) {
        if (r.status === "running" && !isStaleRunning(r, now)) continue;
        if (r.status === "failed" || isStaleRunning(r, now)) consecutiveFailures++;
        else break;
      }
      weekStats[def.key] = {
        successRate: finished.length > 0 ? Math.round((success / finished.length) * 100) : null,
        lastRun: mine[0] ?? null,
        consecutiveFailures,
      };
    }
    const nextRun = nextScheduledRun(now);
    return { todayTimeline, runningRuns, staleRuns, errorRuns, weekStats, nextRun };
  }, [runs]);

  return { loading, refetch: fetchRuns, ...derived };
}
