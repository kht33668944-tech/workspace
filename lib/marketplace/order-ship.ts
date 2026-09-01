// 마켓 발송처리(송장 전송) — 쿠팡 송장 업로드 / 스마트스토어 dispatch
//
//  대상: 쿠팡·스마트스토어 판매분 중 운송장이 있고 아직 마켓에 전송되지 않은 행(shipped_to_marketplace_at IS NULL)
//  제외: 클레임 상태(취소요청 등 — 거절은 rejectCancelRequests 로 명시적으로), 택배사 코드 없음, 마켓 번호 없음
//  성공 → shipped_to_marketplace_at / 실패 → ship_error. 운송장이 바뀌면 apply.ts·use-orders 가 shipped_* 를 비워 재전송된다.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoupangInvoiceDto, CoupangOpenApiClient } from "@/lib/coupang-api";
import type { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { CLAIM_STATUSES } from "@/lib/constants";
import { isDryRun, logMarketplaceApi, sleep } from "@/lib/marketplace/common";
import { getMarketplaceCourierCode } from "@/lib/marketplace/courier-codes";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

const MARKET_LABEL: Record<SyncPlatform, string> = { coupang: "쿠팡", smartstore: "스마트스토어" };

export interface ShipCandidate {
  id: string;
  bundle_no: string | null;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number;
  marketplace: string | null;
  courier: string | null;
  tracking_no: string | null;
  delivery_status: string;
  marketplace_order_no: string | null;
  marketplace_product_order_no: string | null;
  shipped_to_marketplace_at: string | null;
  ship_error: string | null;
}

export interface ShipSkipped {
  order: ShipCandidate;
  reason: string;
}

export interface ShipResultRow {
  orderId: string;
  bundleNo: string | null;
  recipientName: string | null;
  productName: string | null;
  courier: string | null;
  trackingNo: string | null;
  status: "success" | "already" | "failed" | "dry";
  message: string;
}

export interface ShipResult {
  platform: SyncPlatform;
  dryRun: boolean;
  candidates: number;
  sent: number;
  alreadySent: number;
  failed: number;
  skipped: ShipSkipped[];
  rows: ShipResultRow[];
  errors: string[];
  runId: string | null;
}

export interface ShipOptions {
  supabase: AnySupabase;
  userId: string;
  platform: SyncPlatform;
  credentialId: string | null;
  /** 지정하면 이 발주서만 (미지정 시 미전송 전체) */
  orderIds?: string[];
  /** true 면 이미 전송된 행도 다시 보낸다(송장 수정) */
  force?: boolean;
  trigger?: "manual" | "scheduler";
  coupang?: CoupangOpenApiClient;
  smartstore?: NaverCommerceApiClient;
}

const SELECT = "id,bundle_no,recipient_name,product_name,quantity,marketplace,courier,tracking_no,delivery_status,marketplace_order_no,marketplace_product_order_no,shipped_to_marketplace_at,ship_error";

/** 전송 대상/제외 목록 */
export async function fetchShipReadyOrders(supabase: AnySupabase, userId: string, platform: SyncPlatform, opts: { orderIds?: string[]; force?: boolean } = {}) {
  let q = supabase
    .from("orders")
    .select(SELECT)
    .eq("user_id", userId)
    .ilike("marketplace", `%${MARKET_LABEL[platform]}%`)
    .not("tracking_no", "is", null)
    .neq("tracking_no", "")
    .order("order_date", { ascending: false })
    .limit(2000);
  if (opts.orderIds && opts.orderIds.length > 0) q = q.in("id", opts.orderIds);
  if (!opts.force) q = q.is("shipped_to_marketplace_at", null);
  const { data, error } = await q;
  if (error) throw new Error(`발주서 조회 실패: ${error.message}`);
  const ready: ShipCandidate[] = [];
  const skipped: ShipSkipped[] = [];
  for (const o of (data ?? []) as ShipCandidate[]) {
    if (!o.marketplace_product_order_no) { skipped.push({ order: o, reason: "마켓 상품주문번호 없음 (플레이오토 수집 주문 — 플토로 송장 전송)" }); continue; }
    if (CLAIM_STATUSES.has(o.delivery_status)) { skipped.push({ order: o, reason: `${o.delivery_status} 상태 — 취소요청은 '거절(발송)' 버튼으로 처리` }); continue; }
    if (!getMarketplaceCourierCode(o.courier, platform)) { skipped.push({ order: o, reason: `택배사 코드 없음: ${o.courier ?? "(택배사 미입력)"}` }); continue; }
    if (platform === "coupang" && !parseCoupangKey(o)) { skipped.push({ order: o, reason: "쿠팡 주문 식별자 형식 오류" }); continue; }
    ready.push(o);
  }
  return { ready, skipped };
}

function parseCoupangKey(o: ShipCandidate): { shipmentBoxId: number; vendorItemId: number; orderId: number } | null {
  const [box, item] = (o.marketplace_product_order_no ?? "").split("-");
  const shipmentBoxId = Number(box);
  const vendorItemId = Number(item);
  const orderId = Number(o.marketplace_order_no);
  if (!Number.isFinite(shipmentBoxId) || !Number.isFinite(vendorItemId) || !Number.isFinite(orderId) || !box || !item) return null;
  return { shipmentBoxId, vendorItemId, orderId };
}

function isAlreadyShippedMessage(msg: string) {
  return /이미|already|ALREADY|DUPLICATE_INVOICE|송장이 등록|발송처리된|배송중|DELIVERING|DEPARTURE/i.test(msg);
}

export async function shipOrders(opts: ShipOptions): Promise<ShipResult> {
  const { supabase, userId, platform } = opts;
  const dryRun = isDryRun();
  const result: ShipResult = { platform, dryRun, candidates: 0, sent: 0, alreadySent: 0, failed: 0, skipped: [], rows: [], errors: [], runId: null };

  const { data: run } = await supabase
    .from("marketplace_sync_runs")
    .insert({ user_id: userId, platform, kind: "shipping", trigger: opts.trigger ?? "manual", dry_run: dryRun })
    .select("id")
    .single();
  result.runId = (run as { id: string } | null)?.id ?? null;

  try {
    const { ready, skipped } = await fetchShipReadyOrders(supabase, userId, platform, { orderIds: opts.orderIds, force: opts.force });
    result.skipped = skipped;
    result.candidates = ready.length;
    if (ready.length > 0) {
      if (platform === "coupang") await shipCoupang(opts, ready, result);
      else await shipNaver(opts, ready, result);
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  if (result.runId) {
    await supabase.from("marketplace_sync_runs").update({
      finished_at: new Date().toISOString(),
      status: result.errors.length > 0 ? (result.sent > 0 ? "partial" : "failed") : result.failed > 0 ? "partial" : "success",
      remote_count: result.candidates,
      confirmed: result.sent + result.alreadySent,
      confirm_failed: result.failed,
      error: result.errors[0] ?? null,
      detail: { sent: result.sent, alreadySent: result.alreadySent, failed: result.failed, skipped: result.skipped.length, rows: result.rows.slice(0, 200) },
    }).eq("id", result.runId);
  }
  return result;
}

async function finalizeRow(opts: ShipOptions, o: ShipCandidate, status: ShipResultRow["status"], message: string, result: ShipResult, action: "ship" | "ship-fix" = "ship") {
  const { supabase, userId, platform } = opts;
  const ok = status === "success" || status === "already";
  if (status === "success") result.sent++;
  else if (status === "already") result.alreadySent++;
  else if (status === "failed") result.failed++;
  if (status !== "dry") {
    const patch: Record<string, unknown> = ok
      ? { shipped_to_marketplace_at: new Date().toISOString(), ship_error: null, marketplace_status: platform === "coupang" ? "DEPARTURE" : "DELIVERING" }
      : { ship_error: message.slice(0, 300) };
    const { error } = await supabase.from("orders").update(patch).eq("id", o.id).eq("user_id", userId);
    if (error) result.errors.push(`발주서 갱신 실패(${o.id}): ${error.message}`);
  }
  await logMarketplaceApi(supabase, {
    user_id: userId, platform, credential_id: opts.credentialId, action: status === "dry" ? `${action}:dry` : action, status: ok || status === "dry" ? "success" : "failed",
    product_name: o.product_name, target_id: o.marketplace_product_order_no, previous_value: o.tracking_no ? `${o.courier ?? ""} ${o.tracking_no}` : null,
    new_value: ok ? (status === "already" ? "이미 전송됨" : "전송") : null, error_message: ok || status === "dry" ? null : message,
  });
  result.rows.push({ orderId: o.id, bundleNo: o.bundle_no, recipientName: o.recipient_name, productName: o.product_name, courier: o.courier, trackingNo: o.tracking_no, status, message });
}

async function shipCoupang(opts: ShipOptions, ready: ShipCandidate[], result: ShipResult) {
  const client = opts.coupang!;
  // 박스 단위로 묶어 한 번에 올린다 (한 박스에 상품 여러 개면 같은 송장)
  const byBox = new Map<number, ShipCandidate[]>();
  for (const o of ready) {
    const key = parseCoupangKey(o)!.shipmentBoxId;
    byBox.set(key, [...(byBox.get(key) ?? []), o]);
  }
  const boxes = [...byBox.entries()];
  for (let i = 0; i < boxes.length; i += 20) {
    const chunk = boxes.slice(i, i + 20);
    const dtos: CoupangInvoiceDto[] = [];
    for (const [, orders] of chunk) {
      for (const o of orders) {
        const k = parseCoupangKey(o)!;
        dtos.push({ shipmentBoxId: k.shipmentBoxId, orderId: k.orderId, vendorItemId: k.vendorItemId, deliveryCompanyCode: getMarketplaceCourierCode(o.courier, "coupang")!, invoiceNumber: o.tracking_no!.trim() });
      }
    }
    const isFix = chunk.some(([, orders]) => orders.some((o) => o.shipped_to_marketplace_at));
    const res = isFix ? await client.updateInvoices(dtos) : await client.uploadInvoices(dtos);
    if (res.dryRun) { for (const [, orders] of chunk) for (const o of orders) await finalizeRow(opts, o, "dry", "DRY RUN", result); continue; }
    const list = (!res.body || typeof res.body === "string") ? [] : (res.body.data?.responseList ?? []);
    const byBoxResult = new Map<number, { succeed: boolean; msg: string; code: string }>();
    for (const r of list) byBoxResult.set(r.shipmentBoxId, { succeed: r.succeed, msg: r.resultMessage ?? r.resultCode ?? "", code: r.resultCode ?? "" });
    for (const [boxId, orders] of chunk) {
      const r = byBoxResult.get(boxId);
      let status: ShipResultRow["status"];
      let message: string;
      if (r) {
        if (r.succeed) { status = "success"; message = isFix ? "송장 수정" : "송장 전송"; }
        else if (isAlreadyShippedMessage(`${r.code} ${r.msg}`) && !/DUPLICATE_INVOICE/i.test(r.code)) { status = "already"; message = r.msg; }
        else { status = "failed"; message = `${r.code} ${r.msg}`.trim(); }
      } else if (res.ok) { status = "failed"; message = `응답에 박스 결과 없음 (${res.message})`; }
      else { status = "failed"; message = res.message; }
      // 미전송 상태에서 "이미 등록" 오류면 송장 수정 API 로 한 번 더 시도
      if (status === "failed" && !isFix && /이미|already|송장이 등록/i.test(message)) {
        const fixDtos = dtos.filter((d) => d.shipmentBoxId === boxId);
        const fix = await client.updateInvoices(fixDtos);
        const fr = (!fix.body || typeof fix.body === "string") ? undefined : fix.body.data?.responseList?.find((x) => x.shipmentBoxId === boxId);
        if (fr?.succeed) { status = "success"; message = "송장 수정(기존 등록 건 교체)"; }
        else if (fr && isAlreadyShippedMessage(`${fr.resultCode} ${fr.resultMessage}`)) { status = "already"; message = fr.resultMessage ?? "이미 전송됨"; }
      }
      for (const o of orders) await finalizeRow(opts, o, status, message, result, isFix ? "ship-fix" : "ship");
    }
    await sleep(400);
  }
}

async function shipNaver(opts: ShipOptions, ready: ShipCandidate[], result: ShipResult) {
  const client = opts.smartstore!;
  for (let i = 0; i < ready.length; i += 30) {
    const chunk = ready.slice(i, i + 30);
    const res = await client.dispatchProductOrders(chunk.map((o) => ({
      productOrderId: o.marketplace_product_order_no!,
      deliveryCompanyCode: getMarketplaceCourierCode(o.courier, "smartstore")!,
      trackingNumber: o.tracking_no!.trim(),
    })));
    if (res.dryRun) { for (const o of chunk) await finalizeRow(opts, o, "dry", "DRY RUN", result); continue; }
    const body = (!res.body || typeof res.body === "string") ? undefined : res.body.data;
    const okIds = new Set<string>([...(body?.successProductOrderIds ?? []), ...(body?.successProductOrderInfos ?? []).map((x) => x.productOrderId)]);
    const failMap = new Map<string, string>((body?.failProductOrderInfos ?? []).map((x) => [x.productOrderId, `${x.code ?? ""} ${x.message ?? ""}`.trim()]));
    for (const o of chunk) {
      const id = o.marketplace_product_order_no!;
      const isFix = !!o.shipped_to_marketplace_at;
      if (okIds.has(id)) await finalizeRow(opts, o, "success", isFix ? "송장 수정" : "발송처리", result, isFix ? "ship-fix" : "ship");
      else {
        const msg = failMap.get(id) ?? (res.ok ? "응답에 결과 없음" : res.message);
        if (isAlreadyShippedMessage(msg)) await finalizeRow(opts, o, "already", msg, result);
        else await finalizeRow(opts, o, "failed", msg, result);
      }
    }
    await sleep(600);
  }
}
