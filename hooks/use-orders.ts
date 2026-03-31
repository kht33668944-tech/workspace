"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import type { Order, OrderInsert, OrderUpdate } from "@/types/database";

interface UseOrdersOptions {
  month?: string | null;
  marketplace?: string | null;
  search?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  columnFilters?: Record<string, string[]>;
}

interface UndoEntry {
  type: "update";
  id: string;
  prev: OrderUpdate;
  next: OrderUpdate;
}

interface UndoGroup {
  entries: UndoEntry[];
}

const MAX_UNDO = 20;

// 중복 판별 키 생성
function makeDuplicateKey(
  bundleNo: string | null, recipientName: string | null, productName: string | null,
  orderDate: string | null, marketplace: string | null
): string | null {
  if (bundleNo) {
    // 묶음번호 + 수취인명 + 상품명
    return `B:${bundleNo}|${recipientName || ""}|${productName || ""}`;
  }
  if (orderDate && marketplace) {
    // 날짜(일자) + 판매처 + 수취인명 + 상품명
    const dateOnly = orderDate.slice(0, 10);
    return `D:${dateOnly}|${marketplace}|${recipientName || ""}|${productName || ""}`;
  }
  return null;
}

export function useOrders(options: UseOrdersOptions = {}) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState<string[]>([]);
  const undoStackRef = useRef<UndoGroup[]>([]);
  const batchUndoRef = useRef<UndoEntry[] | null>(null);
  const pinnedIdsRef = useRef<Set<string> | null>(null);
  const prevFiltersKeyRef = useRef<string>("");
  const fetchGenRef = useRef(0);
  const prevFetchGenRef = useRef(0);

  const userId = user?.id;

  const fetchOrders = useCallback(async () => {
    if (!userId) return;
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
        .eq("user_id", userId)
        .order("order_date", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      if (options.month) {
        query = query.eq("order_month", options.month);
      }
      if (options.marketplace) {
        query = query.eq("marketplace", options.marketplace);
      }
      if (options.search) {
        const s = options.search.replace(/[%_\\]/g, "\\$&").replace(/[,().]/g, "");
        query = query.or(
          `product_name.ilike.%${s}%,recipient_name.ilike.%${s}%,bundle_no.ilike.%${s}%,marketplace.ilike.%${s}%,recipient_phone.ilike.%${s}%,orderer_phone.ilike.%${s}%,address.ilike.%${s}%,address_detail.ilike.%${s}%,delivery_memo.ilike.%${s}%,purchase_id.ilike.%${s}%,purchase_source.ilike.%${s}%,purchase_order_no.ilike.%${s}%,courier.ilike.%${s}%,tracking_no.ilike.%${s}%,memo.ilike.%${s}%`
        );
      }

      const { data, error } = await query;
      if (error) {
        console.error("[use-orders] 주문 조회 실패:", error instanceof Error ? error.message : String(error));
        break;
      }

      allData.push(...(data as Order[]));
      hasMore = data.length === PAGE_SIZE;
      from += PAGE_SIZE;
    }

    setOrders(allData);
    fetchGenRef.current++;
    setLoading(false);
  }, [userId, options.month, options.marketplace, options.search]);

  const fetchMonths = useCallback(async () => {
    if (!userId) return;
    // order_month만 select하여 경량 쿼리, 클라이언트에서 unique 처리
    const { data } = await supabase
      .from("orders")
      .select("order_month")
      .eq("user_id", userId)
      .not("order_month", "is", null);

    if (data) {
      const unique = [...new Set(data.map((d) => d.order_month as string))].sort().reverse();
      setMonths(unique);
    }
  }, [userId]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  useEffect(() => { fetchMonths(); }, [fetchMonths]);

  // 클라이언트 측 컬럼 필터링 (스냅샷 방식: 필터 설정 변경 또는 DB 재조회 시에만 재평가)
  const filtersKey = JSON.stringify(options.columnFilters || {});
  const hasActiveFilters = Object.entries(options.columnFilters || {}).some(([, v]) => v.length > 0);

  if (filtersKey !== prevFiltersKeyRef.current) {
    // 필터 설정 변경 시에만 전체 재평가
    prevFiltersKeyRef.current = filtersKey;
    prevFetchGenRef.current = fetchGenRef.current;
    if (!hasActiveFilters) {
      pinnedIdsRef.current = null;
    } else {
      pinnedIdsRef.current = new Set(
        applyColumnFilters(orders, options.columnFilters || {}).map((o) => o.id)
      );
    }
  } else if (fetchGenRef.current !== prevFetchGenRef.current && hasActiveFilters && pinnedIdsRef.current) {
    // 데이터 refetch 시: 삭제된 행 제거 + 새로 매칭되는 행 추가 (기존 pinned 유지)
    prevFetchGenRef.current = fetchGenRef.current;
    const currentIds = new Set(orders.map(o => o.id));
    pinnedIdsRef.current = new Set([...pinnedIdsRef.current].filter(id => currentIds.has(id)));
    const newMatching = applyColumnFilters(orders, options.columnFilters || {});
    for (const o of newMatching) {
      pinnedIdsRef.current.add(o.id);
    }
  }

  const pinnedOrders = pinnedIdsRef.current
    ? orders.filter((o) => pinnedIdsRef.current!.has(o.id))
    : orders;

  const filteredOrders = (options.dateFrom || options.dateTo)
    ? pinnedOrders.filter((o) => {
        if (!o.order_date) return false;
        const d = o.order_date.slice(0, 10);
        if (options.dateFrom && d < options.dateFrom) return false;
        if (options.dateTo && d > options.dateTo) return false;
        return true;
      })
    : pinnedOrders;

  // 중복 체크: 엑셀 데이터와 기존 DB 주문 비교
  const checkDuplicates = async (rows: OrderInsert[]): Promise<Set<number>> => {
    if (!user || rows.length === 0) return new Set();

    // 엑셀 데이터에서 관련 월 추출
    const monthSet = new Set<string>();
    for (const r of rows) {
      if (r.order_date) monthSet.add(r.order_date.slice(0, 7));
    }
    if (monthSet.size === 0) return new Set();

    // 해당 월의 기존 주문 조회
    const existingOrders: Order[] = [];
    for (const month of monthSet) {
      let from = 0;
      let hasMore = true;
      while (hasMore) {
        const { data } = await supabase
          .from("orders")
          .select("bundle_no, recipient_name, product_name, order_date, marketplace")
          .eq("user_id", user.id)
          .eq("order_month", month)
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        existingOrders.push(...(data as Order[]));
        hasMore = data.length === 1000;
        from += 1000;
      }
    }

    // 기존 주문의 키 Set 생성
    const existingKeys = new Set<string>();
    for (const o of existingOrders) {
      const key = makeDuplicateKey(o.bundle_no, o.recipient_name, o.product_name, o.order_date, o.marketplace);
      if (key) existingKeys.add(key);
    }

    // 엑셀 행별 중복 여부 판정
    const duplicateIndices = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = makeDuplicateKey(r.bundle_no ?? null, r.recipient_name ?? null, r.product_name ?? null, r.order_date ?? null, r.marketplace ?? null);
      if (key && existingKeys.has(key)) {
        duplicateIndices.add(i);
      }
    }
    return duplicateIndices;
  };

  const insertOrders = async (rows: OrderInsert[]) => {
    if (!user) return { error: "Not authenticated" };
    const withUserId = rows.map((row) => ({ ...row, user_id: user.id }));

    const inserted: Order[] = [];
    // 배치 삽입 (한번에 최대 500행)
    const BATCH_SIZE = 500;
    for (let i = 0; i < withUserId.length; i += BATCH_SIZE) {
      const batch = withUserId.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase.from("orders").insert(batch).select();
      if (error) return { error: error.message };
      if (data) inserted.push(...(data as Order[]));
    }

    setOrders((prev) => [...prev, ...inserted]);
    fetchGenRef.current++;
    // 새 월이 추가되었을 수 있으므로 months는 갱신
    fetchMonths();
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
        const entry: UndoEntry = { type: "update", id, prev, next: autoStatusUpdates };
        if (batchUndoRef.current) {
          // 배치 모드: 그룹에 추가
          batchUndoRef.current.push(entry);
        } else {
          // 단일 업데이트: 개별 그룹으로 push
          undoStackRef.current.push({ entries: [entry] });
          if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
        }
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
          console.error("[use-orders] 주문 업데이트 실패:", error instanceof Error ? error.message : String(error));
          fetchOrders(); // 실패 시 원복
        }
      });
  };

  // 배치 undo 시작/종료: 여러 업데이트를 하나의 그룹으로 묶음
  const startBatchUndo = useCallback(() => {
    batchUndoRef.current = [];
  }, []);

  const endBatchUndo = useCallback(() => {
    if (batchUndoRef.current && batchUndoRef.current.length > 0) {
      undoStackRef.current.push({ entries: batchUndoRef.current });
      if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
    }
    batchUndoRef.current = null;
  }, []);

  const undo = useCallback(() => {
    const group = undoStackRef.current.pop();
    if (!group) {
      showToast("더 이상 취소할 수 없습니다", "info");
      return;
    }
    // 그룹 내 모든 엔트리를 역순으로 되돌림
    for (let i = group.entries.length - 1; i >= 0; i--) {
      const entry = group.entries[i];
      if (entry.type === "update") {
        updateOrder(entry.id, entry.prev, true);
      }
    }
    showToast(
      `실행 취소 (${group.entries.length}개 변경)`,
      "info"
    );
  }, [showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteOrders = async (ids: string[]) => {
    // 배치 삭제 (한번에 최대 100개 — URL 길이 제한 방지)
    const BATCH_SIZE = 100;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("orders").delete().in("id", batch);
      if (error) return { error: error.message };
    }

    const idSet = new Set(ids);
    setOrders((prev) => prev.filter((o) => !idSet.has(o.id)));
    fetchGenRef.current++;
    fetchMonths();
    return { error: null };
  };

  return {
    orders: filteredOrders,
    allOrders: orders,
    loading,
    months,
    refetch: fetchOrders,
    checkDuplicates,
    insertOrders,
    updateOrder,
    deleteOrders,
    undo,
    startBatchUndo,
    endBatchUndo,
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
