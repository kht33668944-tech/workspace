// 운송장 수집 결과를 발주서에 반영 (collect-tracking route · 스케줄러 스크립트 공용)
//
//  규칙 (hooks/use-orders.ts updateOrder 와 동일):
//   - 클레임 상태(취소요청/반품준비 등)면 상태는 두고 택배사·운송장만 기록
//   - 그 외는 배송완료 + delivered_at
//   - 운송장이 바뀌면 shipped_to_marketplace_at 을 비워 마켓에 다시 전송되게 한다

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { CLAIM_STATUSES } from "@/lib/constants";
import type { ScrapeResult } from "@/lib/scrapers/types";

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

/** purchase_order_no 로 발주서를 찾아 택배사·운송장 반영. userId 를 주면 그 사용자 행만 */
export async function applyTrackingToOrders(supabase: AnySupabase, updates: TrackingUpdate[], userId?: string): Promise<ApplyTrackingResult> {
  const out: ApplyTrackingResult = { successCount: 0, failCount: 0, errors: [], orderIds: [] };
  for (const u of updates) {
    if (!u.tracking_no || !u.purchase_order_no) continue;
    let q = supabase.from("orders").select("id,delivery_status,tracking_no,delivered_at").eq("purchase_order_no", u.purchase_order_no);
    if (userId) q = q.eq("user_id", userId);
    const { data: rows, error } = await q;
    if (error) { out.failCount++; out.errors.push(`${u.purchase_order_no}: ${error.message}`); continue; }
    if (!rows || rows.length === 0) { out.failCount++; out.errors.push(`${u.purchase_order_no}: DB에서 주문번호를 찾을 수 없음`); continue; }
    for (const row of rows as Array<{ id: string; delivery_status: string; tracking_no: string | null; delivered_at: string | null }>) {
      const patch: Record<string, unknown> = { courier: u.courier, tracking_no: u.tracking_no };
      if (!CLAIM_STATUSES.has(row.delivery_status)) {
        patch.delivery_status = "배송완료";
        if (!row.delivered_at) patch.delivered_at = new Date().toISOString();
      }
      if (row.tracking_no !== u.tracking_no) {
        patch.shipped_to_marketplace_at = null;
        patch.ship_error = null;
      }
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
  const { data: orders } = await supabase
    .from("orders")
    .select("id, purchase_order_no, recipient_name, product_name")
    .in("purchase_order_no", orderNos);
  const orderMap = new Map<string, { id: string; recipient_name: string | null; product_name: string | null }>();
  for (const o of (orders ?? []) as Array<{ id: string; purchase_order_no: string | null; recipient_name: string | null; product_name: string | null }>) {
    if (o.purchase_order_no) orderMap.set(o.purchase_order_no, o);
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
