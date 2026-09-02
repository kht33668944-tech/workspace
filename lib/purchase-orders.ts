// 발주서 한 행의 "구매 주문 목록"(orders.purchase_orders) 공용 헬퍼 — 서버·클라이언트 공용 순수 함수.
//
//  - 수량 N개 자동구매는 구매처에서 N번 따로 결제되므로 엔트리 N건(quantity 1씩)
//  - 수동 묶음구매는 엔트리 1건(quantity N)
//  - 목록이 비어 있으면 대표 컬럼(purchase_order_no/purchase_detail_url/courier/tracking_no) 1건으로 간주한다
//  - 대표 컬럼은 항상 첫 엔트리(운송장은 운송장이 있는 첫 엔트리)와 같게 유지한다 → representativePatch

import type { Order, PurchaseOrderEntry } from "@/types/database";

export type PurchaseOrderSource = Pick<Order, "purchase_order_no"> & {
  quantity?: number | null;
  purchase_orders?: unknown; // DB jsonb 원본 그대로 받아 정규화한다
  purchase_detail_url?: string | null;
  courier?: string | null;
  tracking_no?: string | null;
  purchased_at?: string | null;
};

function normalizeEntry(e: Partial<PurchaseOrderEntry>): PurchaseOrderEntry | null {
  const orderNo = typeof e.order_no === "string" ? e.order_no.trim() : "";
  if (!orderNo) return null;
  const qty = Number(e.quantity);
  return {
    order_no: orderNo,
    pay_no: e.pay_no ?? null,
    detail_url: e.detail_url ?? null,
    quantity: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1,
    courier: e.courier ?? null,
    tracking_no: e.tracking_no ?? null,
    purchased_at: e.purchased_at ?? null,
    return_requested_at: e.return_requested_at ?? null,
    return_status: e.return_status ?? null,
    source: e.source === "auto" ? "auto" : "manual",
  };
}

/** DB 값(jsonb) → 정규화된 엔트리 배열. 잘못된 값은 버린다 */
export function parsePurchaseOrders(raw: unknown): PurchaseOrderEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PurchaseOrderEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = normalizeEntry(item as Partial<PurchaseOrderEntry>);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 행의 구매 주문 목록. 목록이 비어 있고 대표 주문번호가 있으면 대표값 1건(수량 = 주문 수량, source manual)을 만들어 돌려준다.
 * 목록이 비어 있고 대표 주문번호도 없으면 빈 배열.
 */
export function getPurchaseOrders(o: PurchaseOrderSource): PurchaseOrderEntry[] {
  const list = parsePurchaseOrders(o.purchase_orders);
  if (list.length > 0) return list;
  const rep = o.purchase_order_no?.trim();
  if (!rep) return [];
  return [{
    order_no: rep,
    pay_no: null,
    detail_url: o.purchase_detail_url ?? null,
    quantity: Math.max(Number(o.quantity) || 1, 1),
    courier: o.courier ?? null,
    tracking_no: o.tracking_no ?? null,
    purchased_at: o.purchased_at ?? null,
    return_requested_at: null,
    return_status: null,
    source: "manual",
  }];
}

/** 목록에서 대표 컬럼 값을 계산한다. 첫 엔트리 → 주문번호·상세링크, 운송장이 있는 첫 엔트리 → 택배사·운송장 */
export function representativePatch(entries: PurchaseOrderEntry[]): Pick<Order, "purchase_order_no" | "purchase_detail_url" | "courier" | "tracking_no"> {
  const first = entries[0];
  const shipped = entries.find((e) => !!e.tracking_no?.trim());
  return {
    purchase_order_no: first?.order_no ?? null,
    purchase_detail_url: first?.detail_url ?? null,
    courier: shipped?.courier ?? null,
    tracking_no: shipped?.tracking_no ?? null,
  };
}

/** 목록의 모든 구매처 주문번호 (중복 제거) */
export function allOrderNos(entries: PurchaseOrderEntry[]): string[] {
  return [...new Set(entries.map((e) => e.order_no.trim()).filter(Boolean))];
}

/** order_no 기준으로 교체(필드 병합)하거나 뒤에 추가한다. 원본은 바꾸지 않는다 */
export function upsertEntry(entries: PurchaseOrderEntry[], entry: Partial<PurchaseOrderEntry> & { order_no: string }): PurchaseOrderEntry[] {
  const key = entry.order_no.trim();
  const idx = entries.findIndex((e) => e.order_no.trim() === key);
  if (idx < 0) {
    const n = normalizeEntry(entry);
    return n ? [...entries, n] : entries;
  }
  const merged = normalizeEntry({ ...entries[idx], ...entry, order_no: key });
  if (!merged) return entries;
  return entries.map((e, i) => (i === idx ? merged : e));
}

/** 목록에 담긴 총 수량 */
export function totalQuantity(entries: PurchaseOrderEntry[]): number {
  return entries.reduce((s, e) => s + (e.quantity || 0), 0);
}

/** 엑셀 내보내기용 한 줄 표기: `주문번호(결제번호)×수량 | …` */
export function formatPurchaseOrders(entries: PurchaseOrderEntry[]): string {
  return entries
    .map((e) => `${e.order_no}${e.pay_no ? `(${e.pay_no})` : ""}×${e.quantity}`)
    .join(" | ");
}

/** 엑셀 주문번호 칸의 `A, B / C | D` 를 주문번호 목록으로 분리 */
export function splitOrderNos(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(String(value).split(/[,/|\n]+/).map((s) => s.trim()).filter(Boolean))];
}
