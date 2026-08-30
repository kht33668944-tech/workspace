// 반품/교환 처리 액션 (쿠팡·스마트스토어) — 사이드패널 버튼에서 호출
//
//  action           쿠팡                                   스토어                         발주서
//  return-receive   returnRequests/{id}/receiveConfirmation  (해당 없음)                    반품준비 유지
//  return-complete  returnRequests/{id}/approval (환불)      claim/return/approve (환불)    반품완료 + returned_at
//  return-reject    (API 없음 — 윙/고객센터)                 claim/return/reject            배송완료 복귀
//  exchange-collect exchangeRequests/{id}/receiveConfirmation claim/exchange/collect/approve 교환준비 유지
//  exchange-ship    exchangeRequests/{id}/invoices           claim/exchange/dispatch        교환완료 (+메모에 재배송 송장)
//  exchange-reject  exchangeRequests/{id}/rejection          claim/exchange/reject          배송완료 복귀

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoupangOpenApiClient } from "@/lib/coupang-api";
import type { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { isDryRun, logMarketplaceApi, sleep } from "@/lib/marketplace/common";
import { toKstDateKey } from "@/lib/date-utils";
import { getMarketplaceCourierCode } from "@/lib/marketplace/courier-codes";
import { findCoupangReceipt } from "@/lib/marketplace/order-cancel";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

export type ClaimAction = "return-receive" | "return-complete" | "return-reject" | "exchange-collect" | "exchange-ship" | "exchange-reject";

export const CLAIM_ACTION_LABEL: Record<ClaimAction, string> = {
  "return-receive": "반품 입고 확인",
  "return-complete": "반품 완료(환불)",
  "return-reject": "반품 거절",
  "exchange-collect": "교환 수거 완료",
  "exchange-ship": "교환 재배송(송장)",
  "exchange-reject": "교환 거절",
};

export interface ClaimActionPayload {
  /** 거절 사유 (스토어 반품/교환 거절 필수) */
  reason?: string;
  /** 쿠팡 교환 거절 코드 */
  rejectCode?: "SOLDOUT" | "WITHDRAW";
  /** 교환 재배송 송장 */
  courier?: string;
  trackingNo?: string;
}

export interface ClaimActionInput {
  supabase: AnySupabase;
  userId: string;
  credentialId: string | null;
  platform: SyncPlatform;
  action: ClaimAction;
  orderIds: string[];
  payload?: ClaimActionPayload;
  coupang?: CoupangOpenApiClient;
  smartstore?: NaverCommerceApiClient;
}

export interface ClaimActionRow {
  orderId: string;
  recipientName: string | null;
  productName: string | null;
  status: "success" | "failed" | "dry";
  message: string;
}

interface Row {
  id: string;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number;
  delivery_status: string;
  claim_type: string | null;
  claim_status: string | null;
  claim_receipt_id: string | null;
  marketplace_order_no: string | null;
  marketplace_product_order_no: string | null;
  delivery_memo: string | null;
}

/** 액션 후 발주서 상태 */
function nextStatus(action: ClaimAction): { delivery_status?: string; claim_status: string; returned_at?: string } {
  const now = new Date().toISOString();
  switch (action) {
    case "return-receive": return { claim_status: "RETURN_RECEIVED" };
    case "return-complete": return { delivery_status: "반품완료", claim_status: "RETURN_DONE", returned_at: now };
    case "return-reject": return { delivery_status: "배송완료", claim_status: "RETURN_REJECTED" };
    case "exchange-collect": return { claim_status: "EXCHANGE_COLLECTED" };
    case "exchange-ship": return { delivery_status: "교환완료", claim_status: "EXCHANGE_REDELIVERING" };
    case "exchange-reject": return { delivery_status: "배송완료", claim_status: "EXCHANGE_REJECTED" };
  }
}

const RETURN_ACTIONS: ClaimAction[] = ["return-receive", "return-complete", "return-reject"];

async function resolveCoupangReceiptId(client: CoupangOpenApiClient, o: Row, isReturn: boolean): Promise<number> {
  if (o.claim_receipt_id && /^\d+$/.test(o.claim_receipt_id)) return Number(o.claim_receipt_id);
  if (!o.marketplace_order_no) throw new Error("마켓 주문번호 없음");
  if (isReturn) {
    const r = await findCoupangReceipt(client, o.marketplace_order_no);
    if (!r) throw new Error("반품 접수 내역을 찾지 못함 (주문 수집을 먼저 실행)");
    return r.receiptId;
  }
  // 교환: 최근 7일 orderId 로 조회
  const to = new Date(Date.now() + 86400000);
  const from = new Date(Date.now() - 6 * 86400000);
  const res = await client.listExchangeRequests({ createdAtFrom: to2(from), createdAtTo: to2(to), orderId: Number(o.marketplace_order_no), maxPerPage: 50 });
  const hit = (!res.ok || !res.body || typeof res.body === "string") ? undefined : (res.body.data ?? []).find((x) => String(x.orderId) === o.marketplace_order_no);
  if (!hit) throw new Error("교환 접수 내역을 찾지 못함 (주문 수집을 먼저 실행)");
  return hit.exchangeId;
}
const to2 = toKstDateKey; // 쿠팡 날짜 파라미터는 KST 달력 날짜 (조회 구간에 ±1일 여유 있음)

export async function runClaimAction(input: ClaimActionInput): Promise<ClaimActionRow[]> {
  const { supabase, userId, platform, action } = input;
  const payload = input.payload ?? {};
  const dryRun = isDryRun();
  const { data } = await supabase
    .from("orders")
    .select("id,recipient_name,product_name,quantity,delivery_status,claim_type,claim_status,claim_receipt_id,marketplace_order_no,marketplace_product_order_no,delivery_memo")
    .eq("user_id", userId)
    .in("id", input.orderIds);
  const out: ClaimActionRow[] = [];
  const isReturn = RETURN_ACTIONS.includes(action);

  for (const o of (data ?? []) as Row[]) {
    const base = { orderId: o.id, recipientName: o.recipient_name, productName: o.product_name };
    const expect = isReturn ? "반품준비" : "교환준비";
    if (o.delivery_status !== expect) { out.push({ ...base, status: "failed", message: `${expect} 상태가 아님 (${o.delivery_status})` }); continue; }
    let ok = false;
    let message = "";
    let extraPatch: Record<string, unknown> = {};
    try {
      if (platform === "smartstore") {
        const id = o.marketplace_product_order_no;
        if (!id) throw new Error("상품주문번호 없음");
        const c = input.smartstore!;
        let res;
        if (action === "return-receive") throw new Error("스마트스토어는 수거 완료가 택배 연동으로 자동 처리됩니다 — '반품 완료(환불)'을 사용하세요");
        else if (action === "return-complete") res = await c.approveReturn(id);
        else if (action === "return-reject") { if (!payload.reason?.trim()) throw new Error("거절 사유를 입력하세요"); res = await c.rejectReturn(id, payload.reason.trim()); }
        else if (action === "exchange-collect") res = await c.approveCollectedExchange(id);
        else if (action === "exchange-ship") {
          const code = getMarketplaceCourierCode(payload.courier, "smartstore");
          if (!code || !payload.trackingNo?.trim()) throw new Error("재배송 택배사/운송장을 입력하세요");
          res = await c.redeliverExchange(id, { deliveryCompanyCode: code, trackingNumber: payload.trackingNo.trim() });
          extraPatch = { delivery_memo: appendMemo(o.delivery_memo, `교환 재배송 ${payload.courier} ${payload.trackingNo.trim()}`) };
        } else { if (!payload.reason?.trim()) throw new Error("거절 사유를 입력하세요"); res = await c.rejectExchange(id, payload.reason.trim()); }
        const body = (!res.body || typeof res.body === "string") ? undefined : res.body.data;
        const fail = body?.failProductOrderInfos?.find((f) => f.productOrderId === id);
        ok = res.ok && !fail;
        message = res.dryRun ? "DRY RUN" : ok ? CLAIM_ACTION_LABEL[action] : fail ? `${fail.code ?? ""} ${fail.message ?? ""}`.trim() : res.message;
        if (res.dryRun) ok = true;
      } else {
        const c = input.coupang!;
        if (action === "return-reject") throw new Error("쿠팡은 반품 거절 API가 없습니다 — 윙에서 처리하세요");
        const rid = await resolveCoupangReceiptId(c, o, isReturn);
        let res;
        if (action === "return-receive") res = await c.confirmReturnReceipt(rid);
        else if (action === "return-complete") res = await c.approveReturn(rid, o.quantity);
        else if (action === "exchange-collect") res = await c.confirmExchangeReceipt(rid);
        else if (action === "exchange-ship") {
          const code = getMarketplaceCourierCode(payload.courier, "coupang");
          if (!code || !payload.trackingNo?.trim()) throw new Error("재배송 택배사/운송장을 입력하세요");
          // 재배송 박스 ID: 교환 목록의 targetShipmentBoxId (없으면 원 박스)
          const list = await c.listExchangeRequests({ createdAtFrom: to2(new Date(Date.now() - 6 * 86400000)), createdAtTo: to2(new Date(Date.now() + 86400000)), orderId: Number(o.marketplace_order_no), maxPerPage: 50 });
          const x = (!list.ok || !list.body || typeof list.body === "string") ? undefined : (list.body.data ?? []).find((e) => e.exchangeId === rid);
          const item = x?.exchangeItemDtoV1s?.[0];
          const boxId = item?.targetShipmentBoxId ?? x?.deliveryInvoiceGroupDtos?.[0]?.shipmentBoxId ?? item?.originalShipmentBoxId ?? Number((o.marketplace_product_order_no ?? "").split("-")[0]);
          if (!boxId) throw new Error("재배송 박스 ID를 찾지 못함");
          res = await c.uploadExchangeInvoice(rid, { shipmentBoxId: boxId, goodsDeliveryCode: code, invoiceNumber: payload.trackingNo.trim() });
          extraPatch = { delivery_memo: appendMemo(o.delivery_memo, `교환 재배송 ${payload.courier} ${payload.trackingNo.trim()}`) };
        } else res = await c.rejectExchange(rid, payload.rejectCode ?? "WITHDRAW");
        const rc = (!res.body || typeof res.body === "string") ? undefined : (res.body as { data?: { resultCode?: string; resultMessage?: string } }).data?.resultCode;
        ok = res.ok && (rc == null || rc === "SUCCESS");
        message = res.dryRun ? "DRY RUN" : ok ? CLAIM_ACTION_LABEL[action] : ((!res.body || typeof res.body === "string") ? res.message : (res.body as { data?: { resultMessage?: string } }).data?.resultMessage ?? res.message);
        if (res.dryRun) ok = true;
        extraPatch.claim_receipt_id = String(rid);
      }
    } catch (err) { ok = false; message = err instanceof Error ? err.message : String(err); }

    const status: ClaimActionRow["status"] = dryRun ? "dry" : ok ? "success" : "failed";
    if (ok && !dryRun) {
      const { error } = await supabase.from("orders").update({ ...nextStatus(action), ...extraPatch, marketplace_synced_at: new Date().toISOString() }).eq("id", o.id).eq("user_id", userId);
      if (error) message += ` (발주서 갱신 실패: ${error.message})`;
    }
    await logMarketplaceApi(supabase, {
      user_id: userId, platform, credential_id: input.credentialId, action: dryRun ? `${action}:dry` : action, status: ok ? "success" : "failed",
      product_name: o.product_name, target_id: o.marketplace_product_order_no ?? o.marketplace_order_no, previous_value: o.delivery_status,
      new_value: ok && !dryRun ? (nextStatus(action).delivery_status ?? nextStatus(action).claim_status) : null, error_message: ok ? null : message,
      response_payload: { payload: { ...payload } },
    });
    out.push({ ...base, status, message });
    await sleep(platform === "coupang" ? 400 : 700);
  }
  return out;
}

function appendMemo(memo: string | null, line: string) {
  return memo ? `${memo} / ${line}` : line;
}
