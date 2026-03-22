"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { TrackingLog } from "@/types/database";

interface UseTrackingLogsOptions {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  platform?: string | null;
  status?: string | null;
}

export interface TrackingLogBatch {
  batchId: string;
  platform: string;
  loginId: string;
  createdAt: string;
  logs: TrackingLog[];
  successCount: number;
  failCount: number;
  notFoundCount: number;
}

export interface TrackingLogDay {
  date: string;
  batches: TrackingLogBatch[];
}

export function useTrackingLogs(options: UseTrackingLogsOptions = {}) {
  const { user } = useAuth();
  const [logs, setLogs] = useState<TrackingLog[]>([]);
  const [loading, setLoading] = useState(true);

  const userId = user?.id;

  const fetchLogs = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    const PAGE_SIZE = 1000;
    const allData: TrackingLog[] = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from("tracking_logs")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      if (options.dateFrom) {
        query = query.gte("created_at", `${options.dateFrom}T00:00:00`);
      }
      if (options.dateTo) {
        query = query.lte("created_at", `${options.dateTo}T23:59:59`);
      }
      if (options.platform) {
        query = query.eq("platform", options.platform);
      }
      if (options.status) {
        query = query.eq("status", options.status);
      }
      if (options.search) {
        const s = options.search.replace(/[%_\\]/g, "\\$&");
        query = query.or(
          `recipient_name.ilike.%${s}%,product_name.ilike.%${s}%,purchase_order_no.ilike.%${s}%,tracking_no.ilike.%${s}%`
        );
      }

      const { data, error } = await query;
      if (error) {
        console.error("Failed to fetch tracking logs:", error);
        break;
      }

      allData.push(...(data as TrackingLog[]));
      hasMore = data.length === PAGE_SIZE;
      from += PAGE_SIZE;
    }

    setLogs(allData);
    setLoading(false);
  }, [userId, options.search, options.dateFrom, options.dateTo, options.platform, options.status]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const groupedByDay: TrackingLogDay[] = useMemo(() => {
    // batch_id로 그룹핑
    const batchMap = new Map<string, TrackingLog[]>();
    for (const log of logs) {
      const arr = batchMap.get(log.batch_id) || [];
      arr.push(log);
      batchMap.set(log.batch_id, arr);
    }

    // 배치별 정보 생성
    const batches: TrackingLogBatch[] = [];
    for (const [batchId, batchLogs] of batchMap) {
      const sorted = batchLogs.sort((a, b) => a.created_at.localeCompare(b.created_at));
      batches.push({
        batchId,
        platform: sorted[0].platform,
        loginId: sorted[0].login_id,
        createdAt: sorted[0].created_at,
        logs: sorted,
        successCount: sorted.filter((l) => l.status === "success").length,
        failCount: sorted.filter((l) => l.status === "failed").length,
        notFoundCount: sorted.filter((l) => l.status === "not_found").length,
      });
    }

    // 날짜별 그룹핑
    const dayMap = new Map<string, TrackingLogBatch[]>();
    for (const batch of batches) {
      const date = batch.createdAt.slice(0, 10);
      const arr = dayMap.get(date) || [];
      arr.push(batch);
      dayMap.set(date, arr);
    }

    return [...dayMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, dayBatches]) => ({
        date,
        batches: dayBatches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }));
  }, [logs]);

  return { logs, groupedByDay, loading, refetch: fetchLogs };
}
