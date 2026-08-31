"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { groupIntoBatches, groupMarketplaceLogs, MARKETPLACE_ACTIVITY_LABELS } from "@/lib/log-format";
import { getKoreanDateKey } from "@/lib/date-utils";
import type { BatchLogEntry, MarketplaceLogEntry } from "@/lib/log-format";

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
/** 활동 로그 항목 — 구매/운송장 배치 + 마켓 API 활동 */
export type ActivityEntry = BatchLogEntry | MarketplaceLogEntry;

export interface DashboardData {
  // KPI
  currentMonthCount: number;
  currentMonthRevenue: number;
  currentMonthMargin: number;   // 주문일 기준, 배송완료 상태만 합산
  lastMonthCount: number;
  lastMonthRevenue: number;
  lastMonthMargin: number;      // 주문일 기준, 배송완료 상태만 합산
  unpaidCount: number;
  // 할일 플로우
  unpurchasedCount: number;
  outOfStockCount: number;
  noTrackingCount: number;
  deliveredCount: number;       // 이번달만
  csCount: number;              // 교환준비 + 반품준비
  cancelPendingCount: number;   // 취소준비
  reviewCount: number;          // 구매확인필요 (자동구매 이상)
  cancelRequestCount: number;   // 취소요청 (승인/거절 판단 대기)
  shipDeadlineCount: number;    // 발송불가 중 발송기한 임박(내일까지)
  // 손익/로그
  dailyProfitRows: DashboardDailyProfitRow[];
  monthlyProfitSummary: DashboardMonthlyProfitSummary;
  activityLogs: ActivityEntry[];
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
  reviewCount: 0,
  cancelRequestCount: 0,
  shipDeadlineCount: 0,
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

  const monthRange = getMonthRange(month);
  // 주문일 기준 집계: 주문수는 전체, 매출·마진은 배송완료 상태인 주문만 합산 (발주서 페이지 필터와 동일 기준)
  while (true) {
    const { data } = await supabase
      .from("orders")
      .select("revenue,margin,delivery_status")
      .eq("user_id", uid)
      .gte("order_date", monthRange.from)
      .lt("order_date", monthRange.to)
      .range(from, from + PAGE - 1);

    if (!data || data.length === 0) break;

    const rows = data as Array<{ revenue: number | null; margin: number | null; delivery_status: string | null }>;
    count += rows.length;
    for (const row of rows) {
      if (row.delivery_status !== "배송완료") continue;
      revenue += row.revenue ?? 0;
      deliveredMargin += row.margin ?? 0;
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

type PurchasedRow = {
  purchased_at: string | null;
  cost: number | null;
  payment_method: string | null;
  purchase_order_no: string | null;
  delivery_status: string | null;
};
type OrderProfitRow = FinancialOrderRow & {
  order_date: string | null;
  delivery_status: string;
  payment_method: string | null;
  purchase_order_no: string | null;
  purchased_at: string | null;
};

function localDateFromIso(value: string | null): string | null {
  if (!value) return null;
  return formatLocalDateKey(new Date(value));
}

function isActivePurchase(order: { purchase_order_no: string | null; delivery_status: string | null }): boolean {
  const purchaseOrderNo = order.purchase_order_no?.trim();
  if (!purchaseOrderNo) return false;
  return !["취소완료", "발송불가", "반품완료", "교환완료"].includes(order.delivery_status ?? "");
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

  // 매출·마진·반품은 주문일 기준으로 집계 (발주서 페이지 월 탭과 동일 기준)
  let pageStart = 0;
  while (true) {
    const { data } = await supabase
      .from("orders")
      .select("order_date,delivery_status,revenue,settlement,cost,margin,payment_method,purchase_order_no,purchased_at")
      .eq("user_id", uid)
      .gte("order_date", from)
      .lt("order_date", to)
      .range(pageStart, pageStart + PAGE - 1);

    if (!data || data.length === 0) break;

    for (const order of data as OrderProfitRow[]) {
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
      }

      // purchased_at이 비어 있는 과거·수동 변경 데이터는 주문일 기준으로 카드 사용 보완 집계
      if (!order.purchased_at && isActivePurchase(order)) {
        row.cardSpend += cost;
        row.cardCount += 1;
        addCardUsage(rowCards, order.payment_method, cost);
        addCardUsage(monthlyCards, order.payment_method, cost);
      }
    }

    if (data.length < PAGE) break;
    pageStart += PAGE;
  }

  // 카드 사용은 실제 결제(구매)일 기준 유지
  pageStart = 0;
  while (true) {
    const { data } = await supabase
      .from("orders")
      .select("purchased_at,cost,payment_method,purchase_order_no,delivery_status")
      .eq("user_id", uid)
      .gte("purchased_at", from)
      .lt("purchased_at", to)
      .range(pageStart, pageStart + PAGE - 1);

    if (!data || data.length === 0) break;

    for (const order of data as PurchasedRow[]) {
      if (!isActivePurchase(order)) continue;
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
          // 1. 구매대기 (미구매)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "구매대기"),
          // 2. 배송준비중 (운송장 미수집)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "배송준비"),
          // 3. CS (교환준비 + 반품준비)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .in("delivery_status", ["교환준비", "반품준비"]),
          // 4. 취소준비
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "취소준비"),
          // 5. 발송불가
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "발송불가"),
          // 5-1. 구매 확인 (자동구매 이상 + 부분구매)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .in("delivery_status", ["구매확인필요", "부분구매"]),
          // 5-2. 취소요청 (승인/거절 판단 대기)
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .eq("delivery_status", "취소요청"),
          // 5-3. 미발송 주문 중 발송기한 임박(내일까지) — 구매대기·확인·부분구매·발송불가·배송준비
          supabase
            .from("orders")
            .select("*", { count: "exact", head: true })
            .eq("user_id", uid)
            .in("delivery_status", ["구매대기", "구매확인필요", "부분구매", "발송불가", "배송준비"])
            .is("tracking_no", null)
            .not("ship_by_date", "is", null)
            .lte("ship_by_date", new Date(Date.now() + 9 * 3600000 + 86400000).toISOString().slice(0, 10)),
          // 6. 최근 구매 로그 150건 (배치 집계용, 15배치 보장)
          supabase
            .from("purchase_logs")
            .select("batch_id,platform,status,created_at,order_id")
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(150),
          // 7. 최근 운송장 로그 150건 (배치 집계용, 15배치 보장)
          supabase
            .from("tracking_logs")
            .select("batch_id,platform,status,created_at,order_id")
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(150),
          // 8. 최근 마켓 API 활동 150건 (주문수집·취소승인·송장전송 등)
          supabase
            .from("marketplace_api_logs")
            .select("action,status,platform,target_id,new_value,created_at")
            .eq("user_id", uid)
            .in("action", Object.keys(MARKETPLACE_ACTIVITY_LABELS))
            .order("created_at", { ascending: false })
            .limit(150),
        ]),
        fetchMonthStats(uid, currentMonth),
        fetchMonthStats(uid, lastMonth),
        fetchMonthlyProfit(uid, currentMonth),
      ]);

      const [c0, c1, c2, c4, c5, c6, c6a, c6b, c6c, c7, c8, c9] = counts;

      // 구매/운송장 배치 + 마켓 API 활동을 시간순 병합 (최신 20개)
      type LogRow = { batch_id: string; platform: string; status: string; created_at: string; order_id: string | null };
      type ApiLogRow = { action: string; status: string; platform: string; target_id: string | null; new_value: string | null; created_at: string };
      const purchaseBatches = groupIntoBatches((c7.data ?? []) as LogRow[], "purchase");
      const trackingBatches = groupIntoBatches((c8.data ?? []) as LogRow[], "tracking");
      const marketplaceEntries = groupMarketplaceLogs((c9.data ?? []) as ApiLogRow[]);
      const activityLogs: ActivityEntry[] = [...purchaseBatches, ...trackingBatches, ...marketplaceEntries]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 20);

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
        deliveredCount: profitStats.summary.deliveredCount,
        csCount: c4.count ?? 0,
        cancelPendingCount: c5.count ?? 0,
        outOfStockCount: c6.count ?? 0,
        reviewCount: c6a.count ?? 0,
        cancelRequestCount: c6b.count ?? 0,
        shipDeadlineCount: c6c.count ?? 0,
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
