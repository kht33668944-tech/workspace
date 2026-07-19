"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { getKoreanDateKey, getKoreanMonthKey } from "@/lib/date-utils";
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
const ADDRESS_UPDATE_KEYS = ["postal_code", "address", "address_detail"] as const;

function hasAddressChange(order: Order, updates: OrderUpdate): boolean {
  return ADDRESS_UPDATE_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(updates, key) &&
    String(order[key] ?? "") !== String(updates[key] ?? "")
  );
}

function describeAddress(order: Order | OrderUpdate): string {
  return [
    order.postal_code ? `(${order.postal_code})` : "",
    order.address,
    order.address_detail,
  ].filter(Boolean).join(" ") || "(비어 있음)";
}


// 중복 판별 키 생성
function makeDuplicateKey(
  bundleNo: string | null, recipientName: string | null, productName: string | null,
  orderDate: string | null, marketplace: string | null,
  marketplaceOrderNo: string | null = null, marketplaceProductOrderNo: string | null = null
): string | null {
  if (marketplaceProductOrderNo) {
    return `MP:${marketplace || ""}|${marketplaceProductOrderNo}`;
  }
  if (marketplaceOrderNo) {
    return `MO:${marketplace || ""}|${marketplaceOrderNo}`;
  }
  if (bundleNo) {
    // 묶음번호 + 수취인명 + 상품명
    return `B:${bundleNo}|${recipientName || ""}|${productName || ""}`;
  }
  if (orderDate && marketplace) {
    // 날짜(일자) + 판매처 + 수취인명 + 상품명
    const dateOnly = getKoreanDateKey(orderDate);
    if (!dateOnly) return null;
    return `D:${dateOnly}|${marketplace}|${recipientName || ""}|${productName || ""}`;
  }
  return null;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

const PURCHASE_DATA_KEYS = [
  "purchase_order_no",
  "purchased_at",
  "cost",
  "payment_method",
  "purchase_id",
  "purchase_source",
  "purchase_url",
] as const;

function hasPurchaseEvidence(order: Order): boolean {
  return Boolean(
    hasText(order.purchase_order_no) ||
    order.purchased_at ||
    hasText(order.payment_method) ||
    order.purchase_log_order_nos?.length ||
    (order.cost ?? 0) > 0
  );
}

function isClearingPurchaseData(updates: OrderUpdate): boolean {
  return PURCHASE_DATA_KEYS.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return false;
    const value = updates[key];
    return value === null || (typeof value === "string" && value.trim() === "");
  });
}

function getMonthBounds(month: string): { from: string; to: string } {
  const [year, monthNum] = month.split("-").map(Number);
  const nextYear = monthNum === 12 ? year + 1 : year;
  const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
  return {
    from: `${year}-${String(monthNum).padStart(2, "0")}-01T00:00:00+09:00`,
    to: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+09:00`,
  };
}

function applyLifecycleTimestamps(order: Order, updates: OrderUpdate): OrderUpdate {
  const next: OrderUpdate = { ...updates };
  const now = new Date().toISOString();

  if (hasText(next.purchase_order_no) && !hasText(order.purchase_order_no) && !order.purchased_at) {
    next.purchased_at = now;
  }

  if (
    ((hasText(next.tracking_no) && !hasText(order.tracking_no)) ||
      (next.delivery_status === "배송완료" && order.delivery_status !== "배송완료")) &&
    !order.delivered_at
  ) {
    next.delivered_at = now;
  }

  if (next.delivery_status === "반품완료" && order.delivery_status !== "반품완료" && !order.returned_at) {
    next.returned_at = now;
  }

  return next;
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
  const addressBatchConfirmedRef = useRef<boolean | null>(null);
  const pendingUpdatePromisesRef = useRef<Set<Promise<void>>>(new Set());


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
        const monthBounds = getMonthBounds(options.month);
        query = query.gte("order_date", monthBounds.from).lt("order_date", monthBounds.to);
      }
      if (options.marketplace) {
        query = query.eq("marketplace", options.marketplace);
      }
      if (options.search) {
        const s = options.search.replace(/[%_\\]/g, "\\$&").replace(/[,().]/g, "");
        query = query.or(
          `product_name.ilike.%${s}%,recipient_name.ilike.%${s}%,marketplace_order_no.ilike.%${s}%,marketplace_product_order_no.ilike.%${s}%,marketplace_orderer_name.ilike.%${s}%,bundle_no.ilike.%${s}%,marketplace.ilike.%${s}%,recipient_phone.ilike.%${s}%,orderer_phone.ilike.%${s}%,address.ilike.%${s}%,address_detail.ilike.%${s}%,delivery_memo.ilike.%${s}%,purchase_id.ilike.%${s}%,purchase_source.ilike.%${s}%,purchase_order_no.ilike.%${s}%,courier.ilike.%${s}%,tracking_no.ilike.%${s}%,memo.ilike.%${s}%`
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

    const purchaseNosByOrderId = new Map<string, string[]>();
    for (let i = 0; i < allData.length; i += 200) {
      const batch = allData.slice(i, i + 200).map((o) => o.id);
      if (batch.length === 0) continue;

      const { data: purchaseLogs, error: purchaseLogError } = await supabase
        .from("purchase_logs")
        .select("order_id, purchase_order_no")
        .eq("user_id", userId)
        .in("order_id", batch)
        .eq("status", "success")
        .not("purchase_order_no", "is", null)
        .neq("purchase_order_no", "");

      if (purchaseLogError) {
        console.error("[use-orders] 구매 중복 로그 조회 실패:", purchaseLogError.message);
        continue;
      }

      for (const log of purchaseLogs || []) {
        const orderId = log.order_id as string | null;
        const purchaseNo = typeof log.purchase_order_no === "string" ? log.purchase_order_no.trim() : "";
        if (!orderId || !purchaseNo) continue;
        const current = purchaseNosByOrderId.get(orderId) ?? [];
        if (!current.includes(purchaseNo)) current.push(purchaseNo);
        purchaseNosByOrderId.set(orderId, current);
      }
    }

    const enrichedData = allData.map((order) => {
      const purchaseNos = purchaseNosByOrderId.get(order.id) ?? [];
      const expectedQty = Math.max(Number(order.quantity) || 1, 1);
      const hasSavedPurchaseNo = Boolean(order.purchase_order_no?.trim());
      const duplicateLevel: Order["purchase_duplicate_level"] = purchaseNos.length > expectedQty || (!hasSavedPurchaseNo && purchaseNos.length > 0)
        ? "danger"
        : purchaseNos.length > 1
          ? "warning"
          : null;

      return {
        ...order,
        purchase_log_order_nos: purchaseNos,
        purchase_duplicate_level: duplicateLevel,
        purchase_duplicate_message: duplicateLevel === "danger"
          ? `중복구매 의심: 구매로그 ${purchaseNos.length}건 / 발주수량 ${expectedQty}개`
          : duplicateLevel === "warning"
            ? `복수구매 확인: 구매로그 ${purchaseNos.length}건 / 발주수량 ${expectedQty}개`
            : null,
      };
    });

    setOrders(enrichedData);
    fetchGenRef.current++;
    setLoading(false);
  }, [userId, options.month, options.marketplace, options.search]);

  const fetchMonths = useCallback(async () => {
    if (!userId) return;
    const PAGE_SIZE = 1000;
    const months = new Set<string>();
    let from = 0;

    while (true) {
      const { data } = await supabase
        .from("orders")
        .select("order_date")
        .eq("user_id", userId)
        .not("order_date", "is", null)
        .range(from, from + PAGE_SIZE - 1);

      if (!data || data.length === 0) break;

      for (const row of data as Array<{ order_date: string | null }>) {
        const month = getKoreanMonthKey(row.order_date);
        if (month) months.add(month);
      }

      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    setMonths([...months].sort().reverse());
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
        const d = getKoreanDateKey(o.order_date);
        if (!d) return false;
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
      if (r.order_date) {
        const month = getKoreanMonthKey(r.order_date);
        if (month) monthSet.add(month);
      }
    }
    if (monthSet.size === 0) return new Set();

    // 해당 월의 기존 주문 조회
    const existingOrders: Order[] = [];
    for (const month of monthSet) {
      let from = 0;
      let hasMore = true;
      while (hasMore) {
        const monthBounds = getMonthBounds(month);
        const { data } = await supabase
          .from("orders")
          .select("bundle_no, recipient_name, product_name, order_date, marketplace, marketplace_order_no, marketplace_product_order_no")
          .eq("user_id", user.id)
          .gte("order_date", monthBounds.from)
          .lt("order_date", monthBounds.to)
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
      const key = makeDuplicateKey(
        o.bundle_no,
        o.recipient_name,
        o.product_name,
        o.order_date,
        o.marketplace,
        o.marketplace_order_no,
        o.marketplace_product_order_no,
      );
      if (key) existingKeys.add(key);
    }

    // 엑셀 행별 중복 여부 판정
    const duplicateIndices = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = makeDuplicateKey(
        r.bundle_no ?? null,
        r.recipient_name ?? null,
        r.product_name ?? null,
        r.order_date ?? null,
        r.marketplace ?? null,
        r.marketplace_order_no ?? null,
        r.marketplace_product_order_no ?? null,
      );
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

  // Optimistic update: 즉시 UI 반영 후 DB 저장
  const updateOrder = (id: string, updates: OrderUpdate, skipUndo = false): Promise<void> => {
    let autoStatusUpdates: OrderUpdate = { ...updates };
    const currentOrder = orders.find((o) => o.id === id);

    if (currentOrder && hasPurchaseEvidence(currentOrder)) {
      if (isClearingPurchaseData(autoStatusUpdates)) {
        showToast("구매정보가 있는 주문은 항목을 직접 지울 수 없습니다. 구매취소/정리 버튼을 이용해주세요.", "error");
        return Promise.resolve();
      }
      if (autoStatusUpdates.delivery_status === "취소완료") {
        showToast("구매정보가 있는 주문은 취소완료로 바로 바꿀 수 없습니다. 구매취소/정리 버튼을 이용해주세요.", "error");
        return Promise.resolve();
      }
    }

    if (currentOrder && !skipUndo && hasAddressChange(currentOrder, autoStatusUpdates)) {
      let confirmed = true;
      if (batchUndoRef.current) {
        if (addressBatchConfirmedRef.current === null) {
          addressBatchConfirmedRef.current = window.confirm(
            "주소/우편번호를 여러 건 변경합니다.\n자동구매 배송지에 바로 반영되므로 변경하시겠습니까?"
          );
        }
        confirmed = addressBatchConfirmedRef.current;
      } else {
        const nextAddress = { ...currentOrder, ...autoStatusUpdates };
        confirmed = window.confirm(
          [
            "배송지 정보를 변경하시겠습니까?",
            "",
            `수취인: ${currentOrder.recipient_name || "-"}`,
            `기존: ${describeAddress(currentOrder)}`,
            `변경: ${describeAddress(nextAddress)}`,
            "",
            "확인하면 DB에 저장되고 자동구매에도 이 주소가 사용됩니다.",
          ].join("\n")
        );
      }

      if (!confirmed) return Promise.resolve();
    }

    if (currentOrder && !skipUndo) {
      const merged = { ...currentOrder, ...autoStatusUpdates };

      // 운송장번호 입력 → 배송완료 (취소/반품/교환 상태가 아닐 때만)
      if (hasText(autoStatusUpdates.tracking_no) && autoStatusUpdates.tracking_no !== currentOrder.tracking_no) {
        const noAutoChange = ["취소준비", "취소완료", "반품준비", "반품완료", "교환준비", "교환완료"];
        if (!noAutoChange.includes(merged.delivery_status)) {
          autoStatusUpdates.delivery_status = "배송완료";
        }
      }
      // 주문번호 입력 → 배송준비 (결제전 상태일 때만)
      else if (hasText(autoStatusUpdates.purchase_order_no) && autoStatusUpdates.purchase_order_no !== currentOrder.purchase_order_no) {
        if (merged.delivery_status === "결제전") {
          autoStatusUpdates.delivery_status = "배송준비";
        }
      }

      autoStatusUpdates = applyLifecycleTimestamps(currentOrder, autoStatusUpdates);
    }

    // undo 스택에 이전 값 저장
    if (!skipUndo && currentOrder) {
      const prev: OrderUpdate = {};
      for (const key of Object.keys(autoStatusUpdates) as (keyof OrderUpdate)[]) {
        (prev as Record<string, unknown>)[key] = currentOrder[key as keyof Order];
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

    setOrders((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        const merged = { ...o, ...autoStatusUpdates };
        merged.margin = (merged.settlement || 0) - (merged.cost || 0);
        return merged;
      })
    );

    // DB 저장. 자동구매 시작 전에는 flushPendingUpdates로 저장 완료를 기다린다.
    const savePromise: Promise<void> = (async () => {
      const { error } = await supabase
        .from("orders")
        .update(autoStatusUpdates)
        .eq("id", id);

      if (error) {
        console.error("[use-orders] 주문 업데이트 실패:", error instanceof Error ? error.message : String(error));
        showToast("주문 변경 저장에 실패했습니다. 다시 확인해주세요.", "error");
        fetchOrders(); // 실패 시 원복
      }
    })();

    void savePromise.finally(() => {
      pendingUpdatePromisesRef.current.delete(savePromise);
    });

    pendingUpdatePromisesRef.current.add(savePromise);
    return savePromise;
  };

  const flushPendingUpdates = useCallback(async () => {
    while (pendingUpdatePromisesRef.current.size > 0) {
      const pending = Array.from(pendingUpdatePromisesRef.current);
      await Promise.allSettled(pending);
    }
  }, []);

  const getOrdersByIds = useCallback(async (ids: string[]): Promise<Order[]> => {
    if (!userId || ids.length === 0) return [];
    await flushPendingUpdates();

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .in("id", ids);

    if (error) {
      console.error("[use-orders] 주문 재조회 실패:", error.message);
      showToast("최신 주문 정보를 불러오지 못했습니다.", "error");
      return [];
    }

    const orderMap = new Map((data || []).map((order) => [order.id, order as Order]));
    return ids.map((id) => orderMap.get(id)).filter((order): order is Order => Boolean(order));
  }, [flushPendingUpdates, showToast, userId]);


  // 배치 undo 시작/종료: 여러 업데이트를 하나의 그룹으로 묶음
  const startBatchUndo = useCallback(() => {
    batchUndoRef.current = [];
    addressBatchConfirmedRef.current = null;
  }, []);


  const endBatchUndo = useCallback(() => {
    if (batchUndoRef.current && batchUndoRef.current.length > 0) {
      undoStackRef.current.push({ entries: batchUndoRef.current });
      if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
    }
    batchUndoRef.current = null;
    addressBatchConfirmedRef.current = null;
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
    flushPendingUpdates,
    getOrdersByIds,
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
