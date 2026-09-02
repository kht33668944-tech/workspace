// 운송장 수집 결과를 발주서에 반영 (collect-tracking route · 스케줄러 스크립트 공용)
//
//  규칙 (hooks/use-orders.ts updateOrder 와 동일):
//   - 클레임 상태(취소요청/반품준비 등)면 상태는 두고 택배사·운송장만 기록
//   - 그 외는 배송완료 + delivered_at
//   - 운송장이 바뀌면 shipped_to_marketplace_at 을 비워 마켓에 다시 전송되게 한다
//  구매 주문 목록(purchase_orders)이 있는 행:
//   - 주문번호는 대표(purchase_order_no) 또는 목록 엔트리 어느 쪽으로도 찾는다
//   - 엔트리에 택배사·운송장을 채우고, 대표 운송장은 "첫 번째로 수집된 운송장" 하나만 쓴다 (마켓 송장 전송 대상).
//     대표 운송장이 이미 있으면 같은 주문번호의 변경만 반영하고, 다른 엔트리 운송장은 목록에만 남긴다

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { CLAIM_STATUSES } from "@/lib/constants";
import type { ScrapeResult } from "@/lib/scrapers/types";
import { parsePurchaseOrders, upsertEntry } from "@/lib/purchase-orders";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

export interface TrackingUpdate {
  purchase_order_no: string;
  courier: string;
  tracking_no: string;
}

export interface ApplyTrackingResult {
  successCount: number;
  failCount: number;
  errors: string[];
  /** 갱신된 발주서 id */
  orderIds: string[];
}

interface TrackingRow {
  id: string;
  delivery_status: string;
  purchase_order_no: string | null;
  tracking_no: string | null;
  delivered_at: string | null;
  purchase_orders: unknown;
}

const ROW_SELECT = "id,delivery_status,purchase_order_no,tracking_no,delivered_at,purchase_orders";

/** 대표 주문번호 또는 구매 주문 목록 엔트리로 발주서 행을 찾는다 (id 기준 합집합) */
async function findOrdersByPurchaseNo(supabase: AnySupabase, purchaseOrderNo: string, userId?: string): Promise<{ rows: TrackingRow[]; error: string | null }> {
  let byRep = supabase.from("orders").select(ROW_SELECT).eq("purchase_order_no", purchaseOrderNo);
  let byList = supabase.from("orders").select(ROW_SELECT).contains("purchase_orders", JSON.stringify([{ order_no: purchaseOrderNo }]));
  if (userId) { byRep = byRep.eq("user_id", userId); byList = byList.eq("user_id", userId); }
  const [r1, r2] = await Promise.all([byRep, byList]);
  if (r1.error) return { rows: [], error: r1.error.message };
  if (r2.error) return { rows: [], error: r2.error.message };
  const map = new Map<string, TrackingRow>();
  for (const r of [...((r1.data ?? []) as TrackingRow[]), ...((r2.data ?? []) as TrackingRow[])]) map.set(r.id, r);
  return { rows: [...map.values()], error: null };
}

/** purchase_order_no(대표 또는 목록 엔트리) 로 발주서를 찾아 택배사·운송장 반영. userId 를 주면 그 사용자 행만 */
export async function applyTrackingToOrders(supabase: AnySupabase, updates: TrackingUpdate[], userId?: string): Promise<ApplyTrackingResult> {
  const out: ApplyTrackingResult = { successCount: 0, failCount: 0, errors: [], orderIds: [] };
  for (const u of updates) {
    if (!u.tracking_no || !u.purchase_order_no) continue;
    const { rows, error } = await findOrdersByPurchaseNo(supabase, u.purchase_order_no, userId);
    if (error) { out.failCount++; out.errors.push(`${u.purchase_order_no}: ${error}`); continue; }
    if (rows.length === 0) { out.failCount++; out.errors.push(`${u.purchase_order_no}: DB에서 주문번호를 찾을 수 없음`); continue; }
    for (const row of rows) {
      const patch: Record<string, unknown> = {};
      // 구매 주문 목록 엔트리 갱신 (목록이 있는 행만 — 없는 행은 대표 컬럼 1건 체계를 유지)
      const entries = parsePurchaseOrders(row.purchase_orders);
      if (entries.length > 0 && entries.some((e) => e.order_no === u.purchase_order_no)) {
        patch.purchase_orders = upsertEntry(entries, { order_no: u.purchase_order_no, courier: u.courier, tracking_no: u.tracking_no });
      }
      // 대표 운송장: 비어 있으면 이번 것이 첫 수집 → 대표로. 이미 있으면 같은 주문번호의 변경만 반영
      const repEmpty = !row.tracking_no?.trim();
      const isRepOrder = row.purchase_order_no === u.purchase_order_no;
      const updateRep = repEmpty || (isRepOrder && row.tracking_no !== u.tracking_no);
      if (updateRep) {
        patch.courier = u.courier;
        patch.tracking_no = u.tracking_no;
        if (!CLAIM_STATUSES.has(row.delivery_status)) {
          patch.delivery_status = "배송완료";
          if (!row.delivered_at) patch.delivered_at = new Date().toISOString();
        }
        if (row.tracking_no !== u.tracking_no) {
          patch.shipped_to_marketplace_at = null;
          patch.ship_error = null;
        }
      }
      if (Object.keys(patch).length === 0) { out.successCount++; out.orderIds.push(row.id); continue; }
      const { error: upErr } = await supabase.from("orders").update(patch).eq("id", row.id);
      if (upErr) { out.failCount++; out.errors.push(`${u.purchase_order_no}: ${upErr.message}`); continue; }
      out.successCount++;
      out.orderIds.push(row.id);
    }
  }
  console.log("[tracking-apply] 발주서 반영:", { successCount: out.successCount, failCount: out.failCount });
  return out;
}

/** tracking_logs 저장 — 여러 계정 수집을 batchId 로 묶는다 */
export async function saveTrackingLogs(
  supabase: AnySupabase,
  userId: string | null,
  result: ScrapeResult,
  platform: string,
  loginId: string,
  orderNos: string[],
  sharedBatchId?: string,
) {
  const batchId = sharedBatchId ?? randomUUID();
  type LogOrder = { id: string; purchase_order_no: string | null; recipient_name: string | null; product_name: string | null; purchase_orders: unknown };
  const orderMap = new Map<string, { id: string; recipient_name: string | null; product_name: string | null }>();
  const { data: orders } = await supabase
    .from("orders")
    .select("id, purchase_order_no, recipient_name, product_name, purchase_orders")
    .in("purchase_order_no", orderNos);
  for (const o of (orders ?? []) as LogOrder[]) {
    if (o.purchase_order_no) orderMap.set(o.purchase_order_no, o);
  }
  // 목록 엔트리로만 찾히는 주문번호 (수량 N개 자동구매의 2번째 이후 주문)
  const missing = orderNos.filter((n) => !orderMap.has(n));
  for (const n of missing) {
    const { data } = await supabase
      .from("orders")
      .select("id, purchase_order_no, recipient_name, product_name, purchase_orders")
      .contains("purchase_orders", JSON.stringify([{ order_no: n }]))
      .limit(1);
    const o = ((data ?? []) as LogOrder[])[0];
    if (o) orderMap.set(n, o);
  }
  const base = { batch_id: batchId, platform, login_id: loginId, user_id: userId };
  const logs = [
    ...result.success.map((s) => { const o = orderMap.get(s.orderNo); return { ...base, status: "success", purchase_order_no: s.orderNo, courier: s.courier, tracking_no: s.trackingNo, error_message: null, recipient_name: o?.recipient_name ?? null, product_name: o?.product_name ?? s.itemName ?? null, order_id: o?.id ?? null }; }),
    ...result.failed.map((f) => { const o = orderMap.get(f.orderNo); return { ...base, status: "failed", purchase_order_no: f.orderNo, courier: null, tracking_no: null, error_message: f.reason, recipient_name: o?.recipient_name ?? null, product_name: o?.product_name ?? null, order_id: o?.id ?? null }; }),
    ...result.notFound.map((n) => { const o = orderMap.get(n); return { ...base, status: "not_found", purchase_order_no: n, courier: null, tracking_no: null, error_message: null, recipient_name: o?.recipient_name ?? null, product_name: o?.product_name ?? null, order_id: o?.id ?? null }; }),
  ];
  if (logs.length > 0) {
    const { error } = await supabase.from("tracking_logs").insert(logs);
    if (error) console.warn("[tracking-apply] 운송장 로그 저장 실패:", error.message);
  }
  return batchId;
}
