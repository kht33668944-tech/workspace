"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/context/AuthContext";
import type { PriceHistory } from "@/types/database";

export type PriceFilter = "all" | "up" | "down" | "alert";

interface PriceHistoryItem extends PriceHistory {
  products: {
    product_name: string;
    purchase_url: string;
    category: string;
    user_id: string;
  };
}

interface PriceSummary {
  total: number;
  up: number;
  down: number;
  alert: number;
  avgUpRate: number;
  avgDownRate: number;
}

export function usePriceHistory() {
  const { session } = useAuth();
  const [allHistory, setAllHistory] = useState<PriceHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<PriceFilter>("all");
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>(() => {
    const today = new Date().toISOString().slice(0, 10);
    return { from: today, to: today };
  });

  const fetchHistory = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateRange.from) params.set("from", dateRange.from);
      if (dateRange.to) params.set("to", dateRange.to);

      const res = await fetch(`/api/products/price-history?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const json = await res.json() as { history?: PriceHistoryItem[] };
      setAllHistory(json.history ?? []);
    } catch (e) {
      console.error("[usePriceHistory]", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session?.access_token, dateRange]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // 요약은 전체 데이터 기준
  const summary = useMemo((): PriceSummary => {
    const ups = allHistory.filter(h => h.change_amount > 0);
    const downs = allHistory.filter(h => h.change_amount < 0);
    const alerts = allHistory.filter(h => Math.abs(h.change_rate) >= 10);

    return {
      total: allHistory.length,
      up: ups.length,
      down: downs.length,
      alert: alerts.length,
      avgUpRate: ups.length > 0
        ? Math.round(ups.reduce((s, h) => s + h.change_rate, 0) / ups.length * 10) / 10
        : 0,
      avgDownRate: downs.length > 0
        ? Math.round(downs.reduce((s, h) => s + h.change_rate, 0) / downs.length * 10) / 10
        : 0,
    };
  }, [allHistory]);

  // 필터는 클라이언트에서 적용
  const history = useMemo(() => {
    if (filter === "all") return allHistory;
    if (filter === "up") return allHistory.filter(h => h.change_amount > 0);
    if (filter === "down") return allHistory.filter(h => h.change_amount < 0);
    return allHistory.filter(h => Math.abs(h.change_rate) >= 10);
  }, [allHistory, filter]);

  return {
    history,
    loading,
    summary,
    filter,
    setFilter,
    dateRange,
    setDateRange,
    refetch: fetchHistory,
  };
}
