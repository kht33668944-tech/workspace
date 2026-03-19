"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";

export interface DashboardRecentOrder {
  id: string;
  order_date: string | null;
  marketplace: string | null;
  recipient_name: string | null;
  product_name: string | null;
  delivery_status: string;
  tracking_no: string | null;
}

export interface ActivityLogBatch {
  batchId: string;
  type: "purchase" | "tracking";
  platform: string;
  successCount: number;
  failedCount: number;
  cancelledCount: number;
  startedAt: string;
}

export interface DashboardData {
  // KPI
  currentMonthCount: number;
  currentMonthRevenue: number;
  currentMonthMargin: number;   // 배송완료 기준
  lastMonthCount: number;
  lastMonthRevenue: number;
  lastMonthMargin: number;      // 배송완료 기준
  unpaidCount: number;
  // 할일 플로우
  unpurchasedCount: number;
  noTrackingCount: number;
  deliveredCount: number;       // 이번달만
  csCount: number;              // 교환준비 + 반품준비
  // 테이블/로그
  recentOrders: DashboardRecentOrder[];
  activityLogs: ActivityLogBatch[];
}

const EMPTY_DATA: DashboardData = {
  currentMonthCount: 0,
  currentMonthRevenue: 0,
  currentMonthMargin: 0,
  lastMonthCount: 0,
  lastMonthRevenue: 0,
  lastMonthMargin: 0,
  unpaidCount: 0,
  unpurchasedCount: 0,
  noTrackingCount: 0,
  deliveredCount: 0,
  csCount: 0,
  recentOrders: [],
  activityLogs: [],
};

// 개별 로그 행을 배치 단위로 집계
function groupIntoBatches(
  rows: Array<{ batch_id: string; platform: string; status: string; created_at: string }>,
  type: "purchase" | "tracking",
): ActivityLogBatch[] {
  const map = new Map<string, ActivityLogBatch>();
  for (const r of rows) {
    let batch = map.get(r.batch_id);
    if (!batch) {
      batch = { batchId: r.batch_id, type, platform: r.platform, successCount: 0, failedCount: 0, cancelledCount: 0, startedAt: r.created_at };
      map.set(r.batch_id, batch);
    }
    if (r.created_at < batch.startedAt) batch.startedAt = r.created_at;
    if (r.status === "success") batch.successCount++;
    else if (r.status === "failed") batch.failedCount++;
    else if (r.status === "cancelled") batch.cancelledCount++;
  }
  return Array.from(map.values());
}

function formatMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

interface MonthStats {
  count: number;
  revenue: number;
  deliveredMargin: number;
}

// 한 달치 주문 전체를 페이지네이션으로 읽어 count/revenue/deliveredMargin 계산
async function fetchMonthStats(uid: string, month: string): Promise<MonthStats> {
  const PAGE = 1000;
  let count = 0;
  let revenue = 0;
  let deliveredMargin = 0;
  let from = 0;

  while (true) {
    const { data } = await supabase
      .from("orders")
      .select("revenue,margin,delivery_status")
      .eq("user_id", uid)
      .eq("order_month", month)
      .range(from, from + PAGE - 1);

    if (!data || data.length === 0) break;

    const rows = data as Array<{ revenue: number; margin: number; delivery_status: string }>;
    count += rows.length;
    revenue += rows.reduce((s, r) => s + (r.revenue ?? 0), 0);
    deliveredMargin += rows
      .filter((r) => r.delivery_status === "배송완료")
      .reduce((s, r) => s + (r.margin ?? 0), 0);

    if (rows.length < PAGE) break;
    from += PAGE;
  }

  return { count, revenue, deliveredMargin };
}

export function useDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const uid = user.id;
    const now = new Date();
    const currentMonth = formatMonth(now);
    const lastMonth = formatMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));

    try {
      const [counts, currentStats, lastStats] = await Promise.all([
        // count 쿼리 7개 병렬 (head:true → 행 전송 없이 count만)
        Promise.all([
          // 0. 미처리 주문 (tracking_no IS NULL + 비취소)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .is("tracking_no", null)
            .not("delivery_status", "in", "(취소완료,반품완료,교환완료)"),
          // 1. 결제 전 (미구매)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "결제전"),
          // 2. 배송준비중 (운송장 미수집)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "배송준비"),
          // 3. 배송완료 — 이번달만
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "배송완료")
            .eq("order_month", currentMonth),
          // 4. CS (교환준비 + 반품준비)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .in("delivery_status", ["교환준비", "반품준비"]),
          // 5. 최근 주문 8건
          supabase
            .from("orders")
            .select(
              "id,order_date,marketplace,recipient_name,product_name,delivery_status,tracking_no"
            )
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(8),
          // 6. 최근 구매 로그 150건 (배치 집계용, 15배치 보장)
          supabase
            .from("purchase_logs")
            .select("batch_id,platform,status,created_at")
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(150),
          // 7. 최근 운송장 로그 150건 (배치 집계용, 15배치 보장)
          supabase
            .from("tracking_logs")
            .select("batch_id,platform,status,created_at")
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(150),
        ]),
        // 이번달 통계 (revenue + deliveredMargin, 페이지네이션)
        fetchMonthStats(uid, currentMonth),
        // 지난달 통계 (revenue + deliveredMargin, 페이지네이션)
        fetchMonthStats(uid, lastMonth),
      ]);

      const [c0, c1, c2, c3, c4, c5, c6, c7] = counts;

      // 구매/운송장 배치 집계 후 시간순 병합 (최신 15개)
      type LogRow = { batch_id: string; platform: string; status: string; created_at: string };
      const purchaseBatches = groupIntoBatches((c6.data ?? []) as LogRow[], "purchase");
      const trackingBatches = groupIntoBatches((c7.data ?? []) as LogRow[], "tracking");
      const activityLogs = [...purchaseBatches, ...trackingBatches]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 15);

      setData({
        currentMonthCount: currentStats.count,
        currentMonthRevenue: currentStats.revenue,
        currentMonthMargin: currentStats.deliveredMargin,
        lastMonthCount: lastStats.count,
        lastMonthRevenue: lastStats.revenue,
        lastMonthMargin: lastStats.deliveredMargin,
        unpaidCount: c0.count ?? 0,
        unpurchasedCount: c1.count ?? 0,
        noTrackingCount: c2.count ?? 0,
        deliveredCount: c3.count ?? 0,
        csCount: c4.count ?? 0,
        recentOrders: (c5.data ?? []) as DashboardRecentOrder[],
        activityLogs,
      });
    } catch (err) {
      console.error("Failed to fetch dashboard data", err);
      setData(EMPTY_DATA);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, refetch: fetchData };
}
