"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { Order, OrderInsert, OrderUpdate } from "@/types/database";

interface UseOrdersOptions {
  month?: string | null;
  marketplace?: string | null;
  search?: string;
  columnFilters?: Record<string, string[]>;
}

interface UndoEntry {
  type: "update";
  id: string;
  prev: OrderUpdate;
  next: OrderUpdate;
}

const MAX_UNDO = 20;

export function useOrders(options: UseOrdersOptions = {}) {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState<string[]>([]);
  const undoStackRef = useRef<UndoEntry[]>([]);
  const pinnedIdsRef = useRef<Set<string> | null>(null);
  const prevFiltersKeyRef = useRef<string>("");
  const fetchGenRef = useRef(0);
  const prevFetchGenRef = useRef(0);

  const fetchOrders = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    // Supabase 기본 limit이 1000이므로 페이지네이션으로 전체 데이터 로드
    const PAGE_SIZE = 1000;
    const allData: Order[] = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from("orders")
        .select("*")
        .eq("user_id", user.id)
        .order("order_date", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      if (options.month) {
        query = query.eq("order_month", options.month);
      }
      if (options.marketplace) {
        query = query.eq("marketplace", options.marketplace);
      }
      if (options.search) {
        const s = options.search.replace(/[%_\\]/g, "\\$&");
        query = query.or(
          `product_name.ilike.%${s}%,recipient_name.ilike.%${s}%,bundle_no.ilike.%${s}%,marketplace.ilike.%${s}%,recipient_phone.ilike.%${s}%,orderer_phone.ilike.%${s}%,address.ilike.%${s}%,address_detail.ilike.%${s}%,delivery_memo.ilike.%${s}%,purchase_id.ilike.%${s}%,purchase_source.ilike.%${s}%,purchase_order_no.ilike.%${s}%,courier.ilike.%${s}%,tracking_no.ilike.%${s}%,memo.ilike.%${s}%`
        );
      }

      const { data, error } = await query;
      if (error) {
        console.error("Failed to fetch orders:", error);
        break;
      }

      allData.push(...(data as Order[]));
      hasMore = data.length === PAGE_SIZE;
      from += PAGE_SIZE;
    }

    setOrders(allData);
    fetchGenRef.current++;
    setLoading(false);
  }, [user, options.month, options.marketplace, options.search]);

  const fetchMonths = useCallback(async () => {
    if (!user) return;
    // order_month만 select하여 경량 쿼리, 클라이언트에서 unique 처리
    const { data } = await supabase
      .from("orders")
      .select("order_month")
      .eq("user_id", user.id)
      .not("order_month", "is", null);

    if (data) {
      const unique = [...new Set(data.map((d) => d.order_month as string))].sort().reverse();
      setMonths(unique);
    }
  }, [user]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    fetchMonths();
  }, [fetchMonths]);

  // 클라이언트 측 컬럼 필터링 (스냅샷 방식: 필터 설정 변경 또는 DB 재조회 시에만 재평가)
  const filtersKey = JSON.stringify(options.columnFilters || {});
  const hasActiveFilters = Object.entries(options.columnFilters || {}).some(([, v]) => v.length > 0);

  if (filtersKey !== prevFiltersKeyRef.current || fetchGenRef.current !== prevFetchGenRef.current) {
    prevFiltersKeyRef.current = filtersKey;
    prevFetchGenRef.current = fetchGenRef.current;
    if (!hasActiveFilters) {
      pinnedIdsRef.current = null;
    } else {
      pinnedIdsRef.current = new Set(
        applyColumnFilters(orders, options.columnFilters || {}).map((o) => o.id)
      );
    }
  }

  const filteredOrders = pinnedIdsRef.current
    ? orders.filter((o) => pinnedIdsRef.current!.has(o.id))
    : orders;

  const insertOrders = async (rows: OrderInsert[]) => {
    if (!user) return { error: "Not authenticated" };
    const withUserId = rows.map((row) => ({ ...row, user_id: user.id }));

    // 배치 삽입 (한번에 최대 500행)
    const BATCH_SIZE = 500;
    for (let i = 0; i < withUserId.length; i += BATCH_SIZE) {
      const batch = withUserId.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("orders").insert(batch);
      if (error) return { error: error.message };
    }

    await Promise.all([fetchOrders(), fetchMonths()]);
    return { error: null };
  };

  // Optimistic update: 즉시 UI 반영 후 백그라운드에서 DB 저장
  const updateOrder = (id: string, updates: OrderUpdate, skipUndo = false) => {
    // 배송상태 자동 변경 로직
    const autoStatusUpdates = { ...updates };

    // undo 스택에 이전 값 저장
    if (!skipUndo) {
      const order = orders.find((o) => o.id === id);
      if (order) {
        const prev: OrderUpdate = {};
        for (const key of Object.keys(autoStatusUpdates) as (keyof OrderUpdate)[]) {
          (prev as Record<string, unknown>)[key] = order[key as keyof Order];
        }
        undoStackRef.current.push({ type: "update", id, prev, next: autoStatusUpdates });
        if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
      }
    }

    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        const merged = { ...o, ...autoStatusUpdates };

        // 운송장번호 입력 → 배송완료 (취소/반품/교환 상태가 아닐 때만)
        if (autoStatusUpdates.tracking_no && autoStatusUpdates.tracking_no !== o.tracking_no) {
          const noAutoChange = ["취소준비", "취소완료", "반품준비", "반품완료", "교환준비", "교환완료"];
          if (!noAutoChange.includes(merged.delivery_status)) {
            autoStatusUpdates.delivery_status = "배송완료";
            merged.delivery_status = "배송완료";
          }
        }
        // 주문번호 입력 → 배송준비 (결제전 상태일 때만)
        else if (autoStatusUpdates.purchase_order_no && autoStatusUpdates.purchase_order_no !== o.purchase_order_no) {
          if (merged.delivery_status === "결제전") {
            autoStatusUpdates.delivery_status = "배송준비";
            merged.delivery_status = "배송준비";
          }
        }

        // margin 재계산
        merged.margin = (merged.settlement || 0) - (merged.cost || 0);
        return merged;
      })
    );

    // 백그라운드 DB 저장
    supabase
      .from("orders")
      .update(autoStatusUpdates)
      .eq("id", id)
      .then(({ error }) => {
        if (error) {
          console.error("Update failed:", error);
          fetchOrders(); // 실패 시 원복
        }
      });
  };

  const undo = useCallback(() => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    if (entry.type === "update") {
      updateOrder(entry.id, entry.prev, true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteOrders = async (ids: string[]) => {
    // 배치 삭제 (한번에 최대 100개 — URL 길이 제한 방지)
    const BATCH_SIZE = 100;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("orders").delete().in("id", batch);
      if (error) return { error: error.message };
    }
    await Promise.all([fetchOrders(), fetchMonths()]);
    return { error: null };
  };

  return {
    orders: filteredOrders,
    allOrders: orders,
    loading,
    months,
    refetch: fetchOrders,
    insertOrders,
    updateOrder,
    deleteOrders,
    undo,
  };
}

function applyColumnFilters(orders: Order[], filters: Record<string, string[]>): Order[] {
  const activeFilters = Object.entries(filters).filter(([, v]) => v.length > 0);
  if (activeFilters.length === 0) return orders;

  return orders.filter((order) =>
    activeFilters.every(([key, allowedValues]) => {
      // __NONE__ = 전체 해제 (아무것도 표시하지 않음)
      if (allowedValues.length === 1 && allowedValues[0] === "__NONE__") return false;

      const raw = order[key as keyof Order];
      const cellVal = raw === null || raw === undefined || raw === "" ? "(빈 값)" : String(raw);
      return allowedValues.includes(cellVal);
    })
  );
}
