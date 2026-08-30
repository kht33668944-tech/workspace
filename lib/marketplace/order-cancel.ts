// 발주서 "취소준비" 건을 마켓 공식 API로 판매자 취소하는 공통 파이프라인 (쿠팡·스마트스토어)
//
//  1. orders 에서 취소준비 + 판매처 추출
//  2. 마켓 API 로 최근 주문 수집
//  3. 수취인명 + 상품명(정규화) + 수량 으로 1:1 대조
//  4. 실행 (쿠팡: cancelOrder → 상품준비중이면 stopShipment / 네이버: requestCancel)
//  5. 성공 건만 orders 를 취소완료로 갱신 + 마켓 주문번호 저장 + 로그

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoupangOpenApiClient, CoupangOrderSheet } from "@/lib/coupang-api";
import type { NaverCommerceApiClient, NaverProductOrderDetail } from "@/lib/naver-commerce-api";
import { toKstIso } from "@/lib/naver-commerce-api";
import { isDryRun, normalizeNameKey, normalizeProductKey, sleep } from "@/lib/marketplace/common";

export type CancelPlatform = "coupang" | "smartstore";

export interface CancelOrderRow {
  id: string;
  bundle_no: string | null;
  order_date: string | null;
  marketplace: string | null;
  recipient_name: string | null;
  marketplace_orderer_name: string | null;
  product_name: string | null;
  quantity: number;
  marketplace_order_no: string | null;
  marketplace_product_order_no: string | null;
}

/** 마켓에서 수집한 주문 1건 (플랫폼 공통 형태) */
export interface RemoteOrder {
  platform: CancelPlatform;
  orderId: string;
  productOrderId: string; // 쿠팡=shipmentBoxId, 네이버=productOrderId
  status: string;
  recipientName: string;
  ordererName: string;
  productName: string;
  quantity: number;
  orderedAt: string;
  /** 쿠팡 취소 API 에 필요 */
  vendorItemIds?: number[];
  receiptCounts?: number[];
}

export interface CancelMatch {
  order: CancelOrderRow;
  remote: RemoteOrder;
}

export interface CancelSkip {
  order: CancelOrderRow;
  reason: string;
}

export interface CancelPreview {
  platform: CancelPlatform;
  matched: CancelMatch[];
  skipped: CancelSkip[];
  remoteCount: number;
}

export interface CancelResultRow {
  orderId: string;
  bundleNo: string | null;
  recipientName: string | null;
  productName: string | null;
  remoteOrderId: string;
  status: "success" | "failed" | "dry";
  message: string;
}

const CANCELLABLE = {
  coupang: new Set(["ACCEPT", "INSTRUCT"]),
  smartstore: new Set(["PAYED", "DELIVERING"]),
};

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

// ───────── 1. 발주서 추출 ─────────

/**
 * 취소 대상 발주서 추출.
 * - orderIds 가 주어지면 그 주문만 대상으로 하고, 취소준비가 아니거나 판매처가 다른 건은 notReady 로 돌려준다.
 * - orderIds 가 없으면 해당 판매처의 취소준비 전건.
 */
export async function fetchCancelReadyOrders(
  supabase: SupabaseClient,
  userId: string,
  platform: CancelPlatform,
  orderIds?: string[],
): Promise<{ orders: CancelOrderRow[]; notReady: CancelSkip[] }> {
  const label = platform === "coupang" ? "쿠팡" : "스마트스토어";
  const cols =
    "id,bundle_no,order_date,marketplace,recipient_name,marketplace_orderer_name,product_name,quantity,marketplace_order_no,marketplace_product_order_no,delivery_status";
  let query = supabase.from("orders").select(cols).eq("user_id", userId).order("order_date", { ascending: false }).limit(500);
  query =
    orderIds && orderIds.length > 0
      ? query.in("id", orderIds.slice(0, 500))
      : query.eq("delivery_status", "취소준비").ilike("marketplace", `%${label}%`);
  const { data, error } = await query;
  if (error) throw new Error(`발주서 조회 실패: ${error.message}`);

  const rows = (data ?? []) as (CancelOrderRow & { delivery_status: string })[];
  const orders: CancelOrderRow[] = [];
  const notReady: CancelSkip[] = [];
  for (const row of rows) {
    const { delivery_status, ...order } = row;
    if (!(order.marketplace ?? "").includes(label)) {
      notReady.push({ order, reason: `판매처가 ${label} 아님 (${order.marketplace ?? "-"})` });
    } else if (delivery_status !== "취소준비") {
      notReady.push({ order, reason: `취소준비 상태가 아님 (현재: ${delivery_status}) — 먼저 배송상태를 취소준비로 바꾸세요` });
    } else {
      orders.push(order);
    }
  }
  return { orders, notReady };
}

// ───────── 2. 마켓 주문 수집 ─────────

export async function collectCoupangOrders(client: CoupangOpenApiClient, days = 30): Promise<RemoteOrder[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const sheets: CoupangOrderSheet[] = [];
  for (const status of ["ACCEPT", "INSTRUCT"] as const) {
    sheets.push(...(await client.listAllOrderSheets({ createdAtFrom: ymd(from), createdAtTo: ymd(to), status })));
    await sleep(300);
  }
  const out: RemoteOrder[] = [];
  for (const s of sheets) {
    const items = s.orderItems ?? [];
    // 발주서는 상품 1행 단위. 박스에 상품이 여러 개면 각 상품을 별도 후보로 낸다.
    for (const it of items) {
      out.push({
        platform: "coupang",
        orderId: String(s.orderId),
        productOrderId: String(s.shipmentBoxId),
        status: s.status,
        recipientName: s.receiver?.name ?? "",
        ordererName: s.orderer?.name ?? "",
        productName: it.vendorItemName ?? "",
        quantity: it.shippingCount ?? 0,
        orderedAt: s.orderedAt,
        vendorItemIds: [it.vendorItemId],
        receiptCounts: [it.shippingCount ?? 0],
      });
    }
  }
  return out;
}

export async function collectSmartstoreOrders(client: NaverCommerceApiClient, days = 30): Promise<RemoteOrder[]> {
  const ids = new Set<string>();
  const now = Date.now();
  // last-changed-statuses 는 24시간 구간만 허용 → 하루씩 순회 (2RPS 준수)
  for (let d = days - 1; d >= 0; d--) {
    // [now-(d+1)일, now-d일) — 항상 과거 구간이고 from < to 를 보장한다
    const from = new Date(now - (d + 1) * 86400000);
    const to = new Date(now - d * 86400000 - 1000);
    let moreSequence: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await client.getLastChangedOrders({
        lastChangedFrom: toKstIso(from),
        lastChangedTo: toKstIso(to),
        lastChangedType: "PAYED",
        moreSequence,
      });
      if (!res.ok || !res.body || typeof res.body === "string") {
        throw new Error(`네이버 주문 조회 실패 (${toKstIso(from).slice(0, 10)}): ${res.message}`);
      }
      for (const s of res.body.data?.lastChangeStatuses ?? []) ids.add(s.productOrderId);
      moreSequence = res.body.data?.more?.moreSequence;
      await sleep(600);
      if (!moreSequence) break;
    }
  }

  const details: NaverProductOrderDetail[] = [];
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 300) {
    const res = await client.queryProductOrders(idList.slice(i, i + 300));
    if (!res.ok || !res.body || typeof res.body === "string") throw new Error(`네이버 주문 상세 조회 실패: ${res.message}`);
    details.push(...(res.body.data ?? []));
    await sleep(600);
  }

  return details.map((d) => ({
    platform: "smartstore" as const,
    orderId: d.order?.orderId ?? "",
    productOrderId: d.productOrder.productOrderId,
    status: d.productOrder.productOrderStatus,
    recipientName: d.productOrder.shippingAddress?.name ?? "",
    ordererName: d.order?.ordererName ?? "",
    productName: [d.productOrder.productName, d.productOrder.productOption].filter(Boolean).join(" "),
    quantity: d.productOrder.quantity ?? 0,
    orderedAt: d.order?.orderDate ?? "",
  }));
}

// ───────── 3. 대조 ─────────

export function matchOrders(platform: CancelPlatform, orders: CancelOrderRow[], remote: RemoteOrder[]): CancelPreview {
  const matched: CancelMatch[] = [];
  const skipped: CancelSkip[] = [];
  const used = new Set<string>();
  const cancellable = CANCELLABLE[platform];

  const byProductOrderId = new Map(remote.map((r) => [r.productOrderId, r]));

  for (const order of orders) {
    // 3-a. 이미 마켓 상품주문번호를 알고 있으면 직접 매칭
    const known = order.marketplace_product_order_no ? byProductOrderId.get(order.marketplace_product_order_no) : null;
    let candidates: RemoteOrder[];
    if (known) {
      candidates = [known];
    } else {
      const nameKey = normalizeNameKey(order.recipient_name);
      const prodKey = normalizeProductKey(order.product_name ?? "");
      if (!nameKey || !prodKey) {
        skipped.push({ order, reason: "수취인명 또는 상품명이 비어 있음" });
        continue;
      }
      candidates = remote.filter((r) => {
        if (used.has(r.productOrderId)) return false;
        if (normalizeNameKey(r.recipientName) !== nameKey) return false;
        const rk = normalizeProductKey(r.productName);
        // 마켓 상품명은 옵션/브랜드가 덧붙는 경우가 있어 포함 관계까지 허용
        return rk === prodKey || rk.includes(prodKey) || prodKey.includes(rk);
      });
      if (candidates.length > 1) {
        const exactQty = candidates.filter((r) => r.quantity === order.quantity);
        if (exactQty.length >= 1) candidates = exactQty;
      }
    }

    if (candidates.length === 0) {
      skipped.push({ order, reason: "마켓에서 일치하는 주문을 찾지 못함 (수취인명·상품명)" });
      continue;
    }
    if (candidates.length > 1) {
      skipped.push({ order, reason: `일치 후보가 ${candidates.length}건 — 수동 확인 필요` });
      continue;
    }
    const remoteOrder = candidates[0];
    if (remoteOrder.quantity !== order.quantity) {
      skipped.push({ order, reason: `수량 불일치 (발주서 ${order.quantity} / 마켓 ${remoteOrder.quantity})` });
      continue;
    }
    if (!cancellable.has(remoteOrder.status)) {
      skipped.push({ order, reason: `취소 불가 상태 (${remoteOrder.status})` });
      continue;
    }
    used.add(remoteOrder.productOrderId);
    matched.push({ order, remote: remoteOrder });
  }

  return { platform, matched, skipped, remoteCount: remote.length };
}

// ───────── 4~5. 실행 + 발주서 반영 ─────────

export interface ExecuteOptions {
  supabase: SupabaseClient;
  userId: string;
  credentialId: string;
  platform: CancelPlatform;
  matches: CancelMatch[];
  coupang?: { client: CoupangOpenApiClient; wingUserId: string };
  smartstore?: { client: NaverCommerceApiClient; detailedReason?: string };
}

export async function executeCancels(opts: ExecuteOptions): Promise<CancelResultRow[]> {
  const { supabase, userId, platform, matches } = opts;
  const dry = isDryRun();
  const results: CancelResultRow[] = [];

  for (const { order, remote } of matches) {
    let ok = false;
    let message = "";
    let payload: unknown = null;

    try {
      if (platform === "coupang") {
        if (!opts.coupang) throw new Error("쿠팡 클라이언트 없음");
        const res = await opts.coupang.client.cancelOrder({
          orderId: Number(remote.orderId),
          vendorItemIds: remote.vendorItemIds ?? [],
          receiptCounts: remote.receiptCounts ?? [remote.quantity],
          middleCancelCode: "CCTTER",
          userId: opts.coupang.wingUserId,
        });
        ok = res.ok;
        message = res.dryRun ? "DRY RUN" : res.ok ? "취소 접수" : res.message;
        payload = res.body;

        // 상품준비중 건은 출고중지요청이 생성되므로 receiptId 를 찾아 출고중지완료까지 처리
        if (ok && !res.dryRun && remote.status === "INSTRUCT") {
          await sleep(1500);
          const receiptId = await findCoupangReceiptId(opts.coupang.client, remote.orderId);
          if (receiptId) {
            const stop = await opts.coupang.client.stopShipment(receiptId, remote.quantity);
            message = stop.ok ? "취소 접수 + 출고중지완료" : `취소 접수됨, 출고중지완료 실패: ${stop.message}`;
            ok = stop.ok;
          } else {
            message = "취소 접수됨, 출고중지 접수번호를 찾지 못함 — 윙에서 출고중지완료 필요";
            ok = false;
          }
        }
      } else {
        if (!opts.smartstore) throw new Error("네이버 클라이언트 없음");
        const res = await opts.smartstore.client.requestCancel(remote.productOrderId, {
          cancelReason: "SOLD_OUT",
          cancelDetailedReason: opts.smartstore.detailedReason ?? "배송 장기 지연으로 판매자 취소 처리합니다. 불편을 드려 죄송합니다.",
        });
        ok = res.ok;
        message = res.dryRun ? "DRY RUN" : res.ok ? "판매자 취소 요청 완료" : res.message;
        payload = res.body;
      }
    } catch (err) {
      ok = false;
      message = err instanceof Error ? err.message : String(err);
    }

    const status: CancelResultRow["status"] = dry ? "dry" : ok ? "success" : "failed";
    results.push({
      orderId: order.id,
      bundleNo: order.bundle_no,
      recipientName: order.recipient_name,
      productName: order.product_name,
      remoteOrderId: remote.orderId,
      status,
      message,
    });

    if (ok && !dry) {
      // 낙관적 잠금: 여전히 취소준비일 때만 취소완료로
      await supabase
        .from("orders")
        .update({
          delivery_status: "취소완료",
          marketplace_order_no: remote.orderId,
          marketplace_product_order_no: remote.productOrderId,
        })
        .eq("id", order.id)
        .eq("user_id", userId)
        .eq("delivery_status", "취소준비");
    } else if (!dry) {
      // 실패해도 매칭된 마켓 주문번호는 저장해 두면 다음 시도에서 바로 찾는다
      await supabase
        .from("orders")
        .update({ marketplace_order_no: remote.orderId, marketplace_product_order_no: remote.productOrderId })
        .eq("id", order.id)
        .eq("user_id", userId);
    }

    await supabase.from("marketplace_api_logs").insert({
      user_id: userId,
      platform,
      credential_id: opts.credentialId,
      action: dry ? "cancel:dry" : "cancel",
      status: ok ? "success" : "failed",
      product_name: order.product_name,
      target_id: remote.productOrderId,
      previous_value: "취소준비",
      new_value: ok && !dry ? "취소완료" : null,
      error_message: ok ? null : message,
      response_payload: payload && typeof payload === "object" ? payload : { body: payload, bundleNo: order.bundle_no, recipient: order.recipient_name },
    });

    if (!dry) await sleep(platform === "coupang" ? 400 : 700);
  }

  return results;
}

async function findCoupangReceiptId(client: CoupangOpenApiClient, orderId: string): Promise<number | null> {
  const to = new Date();
  const from = new Date(to.getTime() - 2 * 86400000);
  const res = await client.listReturnRequests({ createdAtFrom: ymd(from), createdAtTo: ymd(to), status: "RU", cancelType: "CANCEL" });
  if (!res.ok || !res.body || typeof res.body === "string") return null;
  const hit = (res.body.data ?? []).find((r) => String(r.orderId) === orderId);
  return hit?.receiptId ?? null;
}
