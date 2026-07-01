"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { groupIntoBatches } from "@/lib/log-format";
import { getKoreanDateKey } from "@/lib/date-utils";
import type { BatchLogEntry } from "@/lib/log-format";

export interface DashboardRecentOrder {
  id: string;
  order_date: string | null;
  marketplace: string | null;
  recipient_name: string | null;
  product_name: string | null;
  delivery_status: string;
  tracking_no: string | null;
}
export interface DashboardCardUsage {
  name: string;
  amount: number;
  count: number;
}

export interface DashboardDailyProfitRow {
  date: string;
  deliveredCount: number;
  deliveredRevenue: number;
  deliveredSettlement: number;
  deliveredCost: number;
  deliveredMargin: number;
  returnCount: number;
  returnRevenue: number;
  returnSettlement: number;
  returnCost: number;
  returnMargin: number;
  netRevenue: number;
  netSettlement: number;
  netCost: number;
  netMargin: number;
  cardSpend: number;
  cardCount: number;
  cards: DashboardCardUsage[];
}

export interface DashboardMonthlyProfitSummary extends Omit<DashboardDailyProfitRow, "date"> {
  month: string;
}

// backwards-compat alias
export type ActivityLogBatch = BatchLogEntry;

export interface DashboardData {
  // KPI
  currentMonthCount: number;
  currentMonthRevenue: number;
  currentMonthMargin: number;   // 배송완료 상태 기준
  lastMonthCount: number;
  lastMonthRevenue: number;
  lastMonthMargin: number;      // 배송완료 상태 기준
  unpaidCount: number;
  // 할일 플로우
  unpurchasedCount: number;
  outOfStockCount: number;
  noTrackingCount: number;
  deliveredCount: number;       // 이번달만
  csCount: number;              // 교환준비 + 반품준비
  cancelPendingCount: number;   // 취소준비
  // 손익/로그
  dailyProfitRows: DashboardDailyProfitRow[];
  monthlyProfitSummary: DashboardMonthlyProfitSummary;
  activityLogs: ActivityLogBatch[];
}

function emptyMonthlySummary(month = ""): DashboardMonthlyProfitSummary {
  return {
    month,
    deliveredCount: 0,
    deliveredRevenue: 0,
    deliveredSettlement: 0,
    deliveredCost: 0,
    deliveredMargin: 0,
    returnCount: 0,
    returnRevenue: 0,
    returnSettlement: 0,
    returnCost: 0,
    returnMargin: 0,
    netRevenue: 0,
    netSettlement: 0,
    netCost: 0,
    netMargin: 0,
    cardSpend: 0,
    cardCount: 0,
    cards: [],
  };
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
  outOfStockCount: 0,
  noTrackingCount: 0,
  deliveredCount: 0,
  csCount: 0,
  cancelPendingCount: 0,
  dailyProfitRows: [],
  monthlyProfitSummary: emptyMonthlySummary(),
  activityLogs: [],
};

function formatMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getMonthRange(month: string): { from: string; to: string; days: string[] } {
  const [year, monthNum] = month.split("-").map(Number);
  const start = new Date(year, monthNum - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, monthNum, 1, 0, 0, 0, 0);
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === monthNum - 1;
  const lastDay = isCurrentMonth ? today.getDate() : new Date(year, monthNum, 0).getDate();
  const days: string[] = [];

  for (let day = 1; day <= lastDay; day++) {
    days.push(`${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }

  return { from: start.toISOString(), to: end.toISOString(), days };
}

interface MonthStats {
  count: number;
  revenue: number;
  deliveredMargin: number;
}

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

    const rows = data as Array<{ revenue: number | null; margin: number | null; delivery_status: string }>;
    count += rows.length;

    for (const row of rows) {
      if (row.delivery_status === "배송완료") {
        revenue += row.revenue ?? 0;
        deliveredMargin += row.margin ?? 0;
      }
    }

    if (rows.length < PAGE) break;
    from += PAGE;
  }

  return { count, revenue, deliveredMargin };
}

function emptyDailyRow(date: string): DashboardDailyProfitRow {
  return {
    date,
    deliveredCount: 0,
    deliveredRevenue: 0,
    deliveredSettlement: 0,
    deliveredCost: 0,
    deliveredMargin: 0,
    returnCount: 0,
    returnRevenue: 0,
    returnSettlement: 0,
    returnCost: 0,
    returnMargin: 0,
    netRevenue: 0,
    netSettlement: 0,
    netCost: 0,
    netMargin: 0,
    cardSpend: 0,
    cardCount: 0,
    cards: [],
  };
}

function addCardUsage(map: Map<string, DashboardCardUsage>, name: string | null, amount: number) {
  const cardName = name?.trim() || "미확인";
  const current = map.get(cardName) ?? { name: cardName, amount: 0, count: 0 };
  current.amount += amount;
  current.count += 1;
  map.set(cardName, current);
}

function sortedCards(map: Map<string, DashboardCardUsage>): DashboardCardUsage[] {
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

type FinancialOrderRow = {
  revenue: number | null;
  settlement: number | null;
  cost: number | null;
  margin: number | null;
};

type DeliveredRow = FinancialOrderRow & { delivered_at: string | null };
type ReturnedRow = FinancialOrderRow & { returned_at: string | null };
type PurchasedRow = { purchased_at: string | null; cost: number | null; payment_method: string | null };
type LegacyProfitRow = FinancialOrderRow & {
  order_date: string | null;
  delivery_status: string;
  payment_method: string | null;
  purchase_order_no: string | null;
};

function localDateFromIso(value: string | null): string | null {
  if (!value) return null;
  return formatLocalDateKey(new Date(value));
}

async function fetchMonthlyProfit(uid: string, month: string): Promise<{
  rows: DashboardDailyProfitRow[];
  summary: DashboardMonthlyProfitSummary;
}> {
  const { from, to, days } = getMonthRange(month);
  const rowMap = new Map(days.map((day) => [day, emptyDailyRow(day)]));
  const rowCardMaps = new Map(days.map((day) => [day, new Map<string, DashboardCardUsage>()]));
  const monthlyCards = new Map<string, DashboardCardUsage>();
  const PAGE = 1000;

  let pageStart = 0;
  while (true) {
    const { data } = await supabase
      .from("orders")
      .select("delivered_at,revenue,settlement,cost,margin")
      .eq("user_id", uid)
      .eq("order_month", month)
      .gte("delivered_at", from)
      .lt("delivered_at", to)
      .range(pageStart, pageStart + PAGE - 1);

    if (!data || data.length === 0) break;

    for (const order of data as DeliveredRow[]) {
      const date = localDateFromIso(order.delivered_at);
      const row = date ? rowMap.get(date) : null;
      if (!row) continue;

      const revenue = order.revenue ?? 0;
      const settlement = order.settlement ?? 0;
      const cost = order.cost ?? 0;
      const margin = order.margin ?? settlement - cost;

      row.deliveredCount += 1;
      row.deliveredRevenue += revenue;
      row.deliveredSettlement += settlement;
      row.deliveredCost += cost;
      row.deliveredMargin += margin;
    }

    if (data.length < PAGE) break;
    pageStart += PAGE;
  }

  pageStart = 0;
  while (true) {
    const { data } = await supabase
      .from("orders")
      .select("returned_at,revenue,settlement,cost,margin")
      .eq("user_id", uid)
      .eq("order_month", month)
      .gte("returned_at", from)
      .lt("returned_at", to)
      .range(pageStart, pageStart + PAGE - 1);

    if (!data || data.length === 0) break;

    for (const order of data as ReturnedRow[]) {
      const date = localDateFromIso(order.returned_at);
      const row = date ? rowMap.get(date) : null;
      if (!row) continue;

      const revenue = order.revenue ?? 0;
      const settlement = order.settlement ?? 0;
      const cost = order.cost ?? 0;
      const margin = order.margin ?? settlement - cost;

      row.returnCount += 1;
      row.returnRevenue += revenue;
      row.returnSettlement += settlement;
      row.returnCost += cost;
      row.returnMargin += margin;
    }

    if (data.length < PAGE) break;
    pageStart += PAGE;
  }

  pageStart = 0;
  while (true) {
    const { data } = await supabase
      .from("orders")
      .select("purchased_at,cost,payment_method")
      .eq("user_id", uid)
      .eq("order_month", month)
      .gte("purchased_at", from)
      .lt("purchased_at", to)
      .range(pageStart, pageStart + PAGE - 1);

    if (!data || data.length === 0) break;

    for (const order of data as PurchasedRow[]) {
      const date = localDateFromIso(order.purchased_at);
      const row = date ? rowMap.get(date) : null;
      const rowCards = date ? rowCardMaps.get(date) : null;
      if (!row || !rowCards) continue;

      const amount = order.cost ?? 0;
      row.cardSpend += amount;
      row.cardCount += 1;
      addCardUsage(rowCards, order.payment_method, amount);
      addCardUsage(monthlyCards, order.payment_method, amount);
    }

    if (data.length < PAGE) break;
    pageStart += PAGE;
  }

  const hasLifecycleData = [...rowMap.values()].some(
    (row) => row.deliveredCount > 0 || row.returnCount > 0 || row.cardCount > 0
  );

  if (!hasLifecycleData) {
    pageStart = 0;
    while (true) {
      const { data } = await supabase
        .from("orders")
        .select("order_date,delivery_status,revenue,settlement,cost,margin,payment_method,purchase_order_no")
        .eq("user_id", uid)
        .eq("order_month", month)
        .range(pageStart, pageStart + PAGE - 1);

      if (!data || data.length === 0) break;

      for (const order of data as LegacyProfitRow[]) {
        if (!order.order_date) continue;
        const date = getKoreanDateKey(order.order_date);
        if (!date) continue;
        const row = rowMap.get(date);
        const rowCards = rowCardMaps.get(date);
        if (!row || !rowCards) continue;

        const revenue = order.revenue ?? 0;
        const settlement = order.settlement ?? 0;
        const cost = order.cost ?? 0;
        const margin = order.margin ?? settlement - cost;

        if (order.delivery_status === "배송완료") {
          row.deliveredCount += 1;
          row.deliveredRevenue += revenue;
          row.deliveredSettlement += settlement;
          row.deliveredCost += cost;
          row.deliveredMargin += margin;
        } else if (order.delivery_status === "반품완료") {
          row.returnCount += 1;
          row.returnRevenue += revenue;
          row.returnSettlement += settlement;
          row.returnCost += cost;
          row.returnMargin += margin;
        }

        if (order.purchase_order_no?.trim()) {
          row.cardSpend += cost;
          row.cardCount += 1;
          addCardUsage(rowCards, order.payment_method, cost);
          addCardUsage(monthlyCards, order.payment_method, cost);
        }
      }

      if (data.length < PAGE) break;
      pageStart += PAGE;
    }
  }

  const rows = [...rowMap.values()]
    .map((row) => {
      const cards = sortedCards(rowCardMaps.get(row.date) ?? new Map());
      return {
        ...row,
        netRevenue: row.deliveredRevenue - row.returnRevenue,
        netSettlement: row.deliveredSettlement - row.returnSettlement,
        netCost: row.deliveredCost - row.returnCost,
        netMargin: row.deliveredMargin - row.returnMargin,
        cards,
      };
    })
    .reverse();

  const summary = rows.reduce<DashboardMonthlyProfitSummary>((acc, row) => {
    acc.deliveredCount += row.deliveredCount;
    acc.deliveredRevenue += row.deliveredRevenue;
    acc.deliveredSettlement += row.deliveredSettlement;
    acc.deliveredCost += row.deliveredCost;
    acc.deliveredMargin += row.deliveredMargin;
    acc.returnCount += row.returnCount;
    acc.returnRevenue += row.returnRevenue;
    acc.returnSettlement += row.returnSettlement;
    acc.returnCost += row.returnCost;
    acc.returnMargin += row.returnMargin;
    acc.netRevenue += row.netRevenue;
    acc.netSettlement += row.netSettlement;
    acc.netCost += row.netCost;
    acc.netMargin += row.netMargin;
    acc.cardSpend += row.cardSpend;
    acc.cardCount += row.cardCount;
    return acc;
  }, emptyMonthlySummary(month));
  summary.cards = sortedCards(monthlyCards);

  return { rows, summary };
}

export function useDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);

  const userId = user?.id;

  const fetchData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    const uid = userId;
    const now = new Date();
    const currentMonth = formatMonth(now);
    const lastMonth = formatMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));

    try {
      const [counts, currentStats, lastStats, profitStats] = await Promise.all([
        // count 쿼리 병렬 (head:true → 행 전송 없이 count만)
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
          // 5. 취소준비
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "취소준비"),
          // 6. 재고부족
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "재고부족"),
          // 7. 최근 구매 로그 150건 (배치 집계용, 15배치 보장)
          supabase
            .from("purchase_logs")
            .select("batch_id,platform,status,created_at")
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(150),
          // 8. 최근 운송장 로그 150건 (배치 집계용, 15배치 보장)
          supabase
            .from("tracking_logs")
            .select("batch_id,platform,status,created_at")
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(150),
        ]),
        fetchMonthStats(uid, currentMonth),
        fetchMonthStats(uid, lastMonth),
        fetchMonthlyProfit(uid, currentMonth),
      ]);

      const [c0, c1, c2, c3, c4, c5, c6, c7, c8] = counts;

      // 구매/운송장 배치 집계 후 시간순 병합 (최신 15개)
      type LogRow = { batch_id: string; platform: string; status: string; created_at: string };
      const purchaseBatches = groupIntoBatches((c7.data ?? []) as LogRow[], "purchase");
      const trackingBatches = groupIntoBatches((c8.data ?? []) as LogRow[], "tracking");
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
        cancelPendingCount: c5.count ?? 0,
        outOfStockCount: c6.count ?? 0,
        dailyProfitRows: profitStats.rows,
        monthlyProfitSummary: profitStats.summary,
        activityLogs,
      });
    } catch (err) {
      console.error("[Dashboard] 데이터 조회 실패:", err instanceof Error ? err.message : String(err));
      setData(EMPTY_DATA);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, refetch: fetchData };
}
