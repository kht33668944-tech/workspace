"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { Order, OrderInsert, OrderUpdate } from "@/types/database";

interface UseOrdersOptions {
  month?: string | null;
  marketplace?: string | null;
  search?: string;
  columnFilters?: Record<string, string[]>;
}

export function useOrders(options: UseOrdersOptions = {}) {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState<string[]>([]);

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
          `product_name.ilike.%${s}%,recipient_name.ilike.%${s}%,bundle_no.ilike.%${s}%,marketplace.ilike.%${s}%,recipient_phone.ilike.%${s}%,orderer_phone.ilike.%${s}%,address.ilike.%${s}%,delivery_memo.ilike.%${s}%,purchase_id.ilike.%${s}%,purchase_source.ilike.%${s}%,purchase_order_no.ilike.%${s}%,courier.ilike.%${s}%,tracking_no.ilike.%${s}%,memo.ilike.%${s}%`
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
    setLoading(false);
  }, [user, options.month, options.marketplace, options.search]);

  const fetchMonths = useCallback(async () => {
    if (!user) return;
    // distinct 대신 전체를 가져와서 클라이언트에서 unique 처리
    // RPC 없이 가장 간단한 방법
    const { data } = await supabase
      .from("orders")
      .select("order_month")
      .eq("user_id", user.id)
      .not("order_month", "is", null)
      .order("order_month", { ascending: false })
      .limit(10000);

    if (data) {
      const unique = [...new Set(data.map((d) => d.order_month as string))];
      setMonths(unique);
    }
  }, [user]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    fetchMonths();
  }, [fetchMonths]);

  // 클라이언트 측 컬럼 필터링
  const filteredOrders = applyColumnFilters(orders, options.columnFilters || {});

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
  const updateOrder = (id: string, updates: OrderUpdate) => {
    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        const updated = { ...o, ...updates };
        // margin 재계산
        updated.margin = (updated.settlement || 0) - (updated.cost || 0);
        return updated;
      })
    );

    // 백그라운드 DB 저장
    supabase
      .from("orders")
      .update(updates)
      .eq("id", id)
      .then(({ error }) => {
        if (error) {
          console.error("Update failed:", error);
          fetchOrders(); // 실패 시 원복
        }
      });
  };

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
