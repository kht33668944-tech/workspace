// 마켓 API 주문 수집 · 발주확인 · 클레임 동기화 (쿠팡·스마트스토어)
//
//  수집  : 마켓 결제완료/상품준비중 주문 → 발주서에 없는 건만 "구매대기"으로 등록 (source='api')
//  확인  : 새로 등록한 건 즉시 발주확인(상품준비중) → 플레이오토가 더 이상 가져가지 못함
//  클레임: 구매자 취소요청 → "취소요청" / 자동취소·승인 → "취소완료" / 반품 → "반품준비" / 교환 → "교환준비"
//
//  방향 규칙: 마켓→발주서 는 클레임·배송 상태만, 발주서→마켓 은 발주확인·취소승인·판매자취소만.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoupangExchangeRequest, CoupangOpenApiClient, CoupangOrderSheet, CoupangOrderStatus, CoupangReturnRequest } from "@/lib/coupang-api";
import type { NaverCommerceApiClient, NaverProductOrderDetail } from "@/lib/naver-commerce-api";
import { toKstIso } from "@/lib/naver-commerce-api";
import { getSettlementRate, splitAddress } from "@/lib/excel-parser";
import { toKstDateKey } from "@/lib/date-utils";
import { sanitizeAddressDetail } from "@/lib/scrapers/types";
import { isDryRun, logMarketplaceApi, normalizeNameKey, normalizeProductKey, sleep } from "@/lib/marketplace/common";
import { LOCKED_STATUSES, TERMINAL_STATUSES, returnRank } from "@/lib/constants";
import { getMarketplaceCourierCode } from "@/lib/marketplace/courier-codes";
import { getAppSetting } from "@/lib/app-settings";
import { findCoupangReceipt } from "@/lib/marketplace/order-cancel";
import type { OrderInsert } from "@/types/database";

export type SyncPlatform = "coupang" | "smartstore";

const MARKET_LABEL: Record<SyncPlatform, string> = { coupang: "쿠팡", smartstore: "스마트스토어" };
const TERMINAL = TERMINAL_STATUSES;
const LOCKED = LOCKED_STATUSES;

export interface SyncedOrderSummary {
  id?: string;
  bundleNo: string | null;
  recipientName: string | null;
  productName: string | null;
  quantity: number;
  revenue: number;
  marketplaceStatus: string | null;
}

export interface ClaimChange {
  orderId: string;
  bundleNo: string | null;
  recipientName: string | null;
  productName: string | null;
  from: string;
  to: string;
  claimType: string;
  claimStatus: string;
  reason?: string;
}

export interface SyncResult {
  platform: SyncPlatform;
  dryRun: boolean;
  remoteCount: number;
  newOrders: SyncedOrderSummary[];
  skippedExisting: number;
  confirmed: number;
  confirmFailed: number;
  confirmErrors: string[];
  claims: ClaimChange[];
  claimCounts: Record<string, number>;
  /** 자동 승인된 취소요청 (설정 auto_approve_cancel) */
  autoApproved: ApproveResultRow[];
  errors: string[];
  runId: string | null;
}

export interface SyncOptions {
  supabase: SupabaseClient;
  userId: string;
  platform: SyncPlatform;
  credentialId: string | null;
  days?: number;
  trigger?: "manual" | "scheduler";
  coupang?: CoupangOpenApiClient;
  smartstore?: NaverCommerceApiClient;
}

const ymd = toKstDateKey; // 쿠팡·네이버 날짜 파라미터는 KST 달력 날짜
/** 쿠팡 시각은 tz 없는 KST 문자열 → +09:00 부여 */
function kst(s: string | undefined | null) {
  if (!s) return null;
  return /[+Z]/.test(s.slice(10)) ? s : `${s}+09:00`;
}
function dateKeyKst(iso: string | null) {
  return iso ? toKstDateKey(new Date(iso)) : "";
}

// ───────────────────────── 매핑 ─────────────────────────

/** 취소되지 않은 유효 주문 아이템 판정 — 발주서 등록·대조 스크립트가 같은 기준을 공유한다 */
export function isActiveCoupangItem(it: { shippingCount?: number | null; canceled?: boolean; cancelCount?: number | null }): boolean {
  const qty = it.shippingCount ?? 0;
  return qty > 0 && !it.canceled && (it.cancelCount ?? 0) < qty;
}

export function mapCoupangOrderSheet(sheet: CoupangOrderSheet, userId: string): OrderInsert[] {
  const now = new Date().toISOString();
  const rate = getSettlementRate("쿠팡");
  const addr = splitAddress([sheet.receiver?.addr1 ?? "", sheet.receiver?.addr2 ?? ""].filter(Boolean).join(" "));
  const out: OrderInsert[] = [];
  for (const it of sheet.orderItems ?? []) {
    const qty = it.shippingCount ?? 0;
    if (!isActiveCoupangItem(it)) continue;
    const revenue = Math.max(0, Math.round((it.orderPrice ?? (it.salesPrice ?? 0) * qty) - 0));
    out.push({
      user_id: userId,
      bundle_no: String(sheet.shipmentBoxId),
      order_date: kst(sheet.paidAt ?? sheet.orderedAt),
      marketplace: "쿠팡",
      marketplace_order_no: String(sheet.orderId),
      marketplace_product_order_no: `${sheet.shipmentBoxId}-${it.vendorItemId}`,
      marketplace_orderer_name: sheet.orderer?.name ?? null,
      recipient_name: sheet.receiver?.name ?? null,
      product_name: it.sellerProductName || it.vendorItemName || null,
      quantity: qty,
      recipient_phone: sheet.receiver?.safeNumber || sheet.receiver?.receiverNumber || null,
      orderer_phone: sheet.orderer?.safeNumber || sheet.orderer?.ordererNumber || null,
      postal_code: sheet.receiver?.postCode ?? null,
      address: addr.base || sheet.receiver?.addr1 || null,
      address_detail: sanitizeAddressDetail(addr.detail) || null,
      delivery_memo: sheet.parcelPrintMessage || null,
      revenue,
      settlement: Math.round(revenue * rate),
      cost: 0,
      payment_method: null,
      purchase_id: null,
      purchase_source: null,
      purchase_url: null,
      purchase_order_no: null,
      courier: null,
      tracking_no: null,
      delivery_status: "구매대기",
      consultation_logs: [],
      memo: null,
      source: "api",
      marketplace_status: sheet.status,
      confirmed_at: it.confirmDate ? kst(it.confirmDate) : sheet.status === "INSTRUCT" ? kst(sheet.orderedAt) : null,
      ship_by_date: it.estimatedShippingDate || null,
      marketplace_synced_at: now,
    });
  }
  return out;
}

export function mapNaverProductOrder(d: NaverProductOrderDetail, userId: string): OrderInsert | null {
  const po = d.productOrder;
  if (!po) return null;
  const now = new Date().toISOString();
  const qty = po.quantity ?? 0;
  if (qty <= 0) return null;
  const sa = po.shippingAddress ?? {};
  const revenue = Math.max(0, Math.round(po.totalProductAmount ?? (po.unitPrice ?? 0) * qty));
  const settlement = po.expectedSettlementAmount != null ? Math.round(po.expectedSettlementAmount) : Math.round(revenue * getSettlementRate("스마트스토어"));
  const detail = sanitizeAddressDetail(sa.detailedAddress ?? "");
  return {
    user_id: userId,
    bundle_no: d.order?.orderId ?? po.productOrderId,
    order_date: d.order?.paymentDate ?? d.order?.orderDate ?? null,
    marketplace: "스마트스토어",
    marketplace_order_no: d.order?.orderId ?? null,
    marketplace_product_order_no: po.productOrderId,
    marketplace_orderer_name: d.order?.ordererName ?? null,
    recipient_name: sa.name ?? null,
    product_name: [po.productName, po.productOption].filter(Boolean).join(" ") || null,
    quantity: qty,
    recipient_phone: sa.tel1 ?? null,
    orderer_phone: d.order?.ordererTel ?? null,
    postal_code: sa.zipCode ?? null,
    address: sa.baseAddress ?? null,
    address_detail: detail || null,
    delivery_memo: po.shippingMemo || null,
    revenue,
    settlement,
    cost: 0,
    payment_method: d.order?.paymentMeans ?? null,
    purchase_id: null,
    purchase_source: null,
    purchase_url: null,
    purchase_order_no: null,
    courier: null,
    tracking_no: null,
    delivery_status: "구매대기",
    consultation_logs: [],
    memo: null,
    source: "api",
    marketplace_status: po.productOrderStatus,
    confirmed_at: po.placeOrderStatus === "OK" ? (po.placeOrderDate ?? now) : null,
    ship_by_date: po.shippingDueDate ? po.shippingDueDate.slice(0, 10) : null,
    marketplace_synced_at: now,
  };
}

// ───────────────────────── 원격 조회 ─────────────────────────

export async function fetchCoupangSheets(client: CoupangOpenApiClient, days: number, statuses: CoupangOrderStatus[] = ["ACCEPT", "INSTRUCT"]) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const sheets: CoupangOrderSheet[] = [];
  for (const status of statuses) {
    sheets.push(...(await client.listAllOrderSheets({ createdAtFrom: ymd(from), createdAtTo: ymd(to), status })));
    await sleep(300);
  }
  return sheets;
}

/** 네이버 결제일시 기준 상품주문 상세 (24h 구간 순회, 페이지 300) — 오래된 주문도 조회 가능 */
export async function searchNaverOrdersByPaidDate(client: NaverCommerceApiClient, days: number, errors: string[]) {
  const out: NaverProductOrderDetail[] = [];
  const now = Date.now();
  for (let d = days - 1; d >= 0; d--) {
    const from = new Date(now - (d + 1) * 86400000);
    const to = new Date(now - d * 86400000 - 1000);
    for (let page = 1; page < 30; page++) {
      const res = await client.searchProductOrders({ from: toKstIso(from), to: toKstIso(to), page, pageSize: 300 });
      if (!res.ok || !res.body || typeof res.body === "string") { errors.push(`네이버 주문 조회 실패(${ymd(from)}): ${res.message}`); break; }
      const data = res.body.data;
      const list = Array.isArray(data) ? data : (data?.contents ?? []).map((c) => c.content).filter((c) => !!c?.productOrder);
      out.push(...list);
      const totalPages = Array.isArray(data) ? 1 : (data?.pagination?.totalPages ?? 1);
      if (page >= totalPages || list.length === 0) break;
      await sleep(600);
    }
  }
  return out;
}

/** 네이버 변경 상품주문 ID 수집 (24h 구간 순회) */
async function fetchNaverChangedIds(client: NaverCommerceApiClient, days: number, type: "PAYED" | "CLAIM_REQUESTED" | "CLAIM_COMPLETED") {
  const ids = new Set<string>();
  const now = Date.now();
  for (let d = days - 1; d >= 0; d--) {
    const from = new Date(now - (d + 1) * 86400000);
    const to = new Date(now - d * 86400000 - 1000);
    let moreSequence: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await client.getLastChangedOrders({ lastChangedFrom: toKstIso(from), lastChangedTo: toKstIso(to), lastChangedType: type, moreSequence });
      if (!res.ok || !res.body || typeof res.body === "string") throw new Error(`네이버 ${type} 조회 실패: ${res.message}`);
      for (const s of res.body.data?.lastChangeStatuses ?? []) ids.add(s.productOrderId);
      moreSequence = res.body.data?.more?.moreSequence;
      await sleep(600);
      if (!moreSequence) break;
    }
  }
  return [...ids];
}

async function fetchNaverDetails(client: NaverCommerceApiClient, ids: string[]) {
  const out: NaverProductOrderDetail[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const res = await client.queryProductOrders(ids.slice(i, i + 300));
    if (!res.ok || !res.body || typeof res.body === "string") throw new Error(`네이버 주문 상세 조회 실패: ${res.message}`);
    out.push(...(res.body.data ?? []));
    await sleep(600);
  }
  return out;
}

// ───────────────────────── 기존 발주서 인덱스 ─────────────────────────

interface ExistingOrder {
  id: string;
  order_date: string | null;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number;
  delivery_status: string;
  marketplace_order_no: string | null;
  marketplace_product_order_no: string | null;
  bundle_no: string | null;
}

async function loadExistingOrders(supabase: SupabaseClient, userId: string, platform: SyncPlatform, days: number) {
  const since = new Date(Date.now() - (days + 3) * 86400000).toISOString();
  const rows: ExistingOrder[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("orders")
      .select("id,order_date,recipient_name,product_name,quantity,delivery_status,marketplace_order_no,marketplace_product_order_no,bundle_no")
      .eq("user_id", userId)
      .ilike("marketplace", `%${MARKET_LABEL[platform]}%`)
      .gte("order_date", since)
      .range(from, from + 999);
    if (error) throw new Error(`발주서 조회 실패: ${error.message}`);
    rows.push(...((data ?? []) as ExistingOrder[]));
    if (!data || data.length < 1000) break;
  }
  const byProductOrderNo = new Map<string, ExistingOrder>();
  const byOrderNo = new Map<string, ExistingOrder[]>();
  const byFuzzy = new Map<string, ExistingOrder[]>(); // 같은 사람이 같은 상품을 여러 번 주문할 수 있어 개수로 관리
  for (const r of rows) {
    if (r.marketplace_product_order_no) byProductOrderNo.set(r.marketplace_product_order_no, r);
    if (r.marketplace_order_no) byOrderNo.set(r.marketplace_order_no, [...(byOrderNo.get(r.marketplace_order_no) ?? []), r]);
    // fuzzy 풀에는 마켓 번호가 없는 행(플토 엑셀 입력분)만 — 번호 있는 행까지 넣으면 동일인·동일상품 재주문이 중복으로 오인돼 수집 누락된다
    if (r.marketplace_product_order_no) continue;
    const fk = fuzzyKey(r.order_date, r.recipient_name, r.product_name);
    byFuzzy.set(fk, [...(byFuzzy.get(fk) ?? []), r]);
  }
  return { rows, byProductOrderNo, byOrderNo, byFuzzy };
}

/** 플레이오토 엑셀로 들어온 행(마켓 번호 없음)과의 중복 방지 키: 결제일(KST) + 수취인 + 상품명 */
export function fuzzyKey(orderDate: string | null, recipient: string | null, product: string | null) {
  return `${dateKeyKst(orderDate)}|${normalizeNameKey(recipient)}|${normalizeProductKey(product ?? "")}`;
}

// ───────────────────────── 메인 ─────────────────────────

export async function syncOrders(opts: SyncOptions): Promise<SyncResult> {
  const { supabase, userId, platform } = opts;
  const days = opts.days ?? 3;
  const dryRun = isDryRun();
  const result: SyncResult = {
    platform,
    dryRun,
    remoteCount: 0,
    newOrders: [],
    skippedExisting: 0,
    confirmed: 0,
    confirmFailed: 0,
    confirmErrors: [],
    claims: [],
    claimCounts: {},
    autoApproved: [],
    errors: [],
    runId: null,
  };

  const { data: run } = await supabase
    .from("marketplace_sync_runs")
    .insert({ user_id: userId, platform, trigger: opts.trigger ?? "manual", dry_run: dryRun })
    .select("id")
    .single();
  result.runId = run?.id ?? null;

  try {
    const existing = await loadExistingOrders(supabase, userId, platform, days);

    // ── 1. 수집 + 매핑
    let candidates: OrderInsert[] = [];
    let coupangSheets: CoupangOrderSheet[] = [];
    let naverDetails: NaverProductOrderDetail[] = [];
    if (platform === "coupang") {
      if (!opts.coupang) throw new Error("쿠팡 클라이언트 없음");
      coupangSheets = await fetchCoupangSheets(opts.coupang, days);
      result.remoteCount = coupangSheets.length;
      candidates = coupangSheets.flatMap((s) => mapCoupangOrderSheet(s, userId));
    } else {
      if (!opts.smartstore) throw new Error("네이버 클라이언트 없음");
      const ids = await fetchNaverChangedIds(opts.smartstore, days, "PAYED");
      naverDetails = await fetchNaverDetails(opts.smartstore, ids);
      result.remoteCount = naverDetails.length;
      candidates = naverDetails
        .filter((d) => d.productOrder?.productOrderStatus === "PAYED")
        .map((d) => mapNaverProductOrder(d, userId))
        .filter((o): o is OrderInsert => !!o);
    }

    // ── 2. 중복 제거 (마켓 상품주문번호 → 플토 행과의 fuzzy 키)
    const toInsert: OrderInsert[] = [];
    const seen = new Set<string>();
    for (const o of candidates) {
      const pon = o.marketplace_product_order_no ?? "";
      if (seen.has(pon)) continue;
      seen.add(pon);
      if (existing.byProductOrderNo.has(pon)) { result.skippedExisting++; continue; }
      const fz = fuzzyKey(o.order_date, o.recipient_name, o.product_name);
      const fuzzyPool = existing.byFuzzy.get(fz) ?? [];
      if (fuzzyPool.length > 0) {
        result.skippedExisting++;
        // 같은 키의 기존 행 하나를 소비한다 (동일인·동일상품 다건 주문 대응)
        const plto = fuzzyPool.shift()!;
        // 플토 행에 마켓 번호를 채워 두면 다음부터 정확 매칭·취소 API 에서 바로 쓴다
        if (!dryRun) {
          await supabase
            .from("orders")
            .update({ marketplace_order_no: o.marketplace_order_no, marketplace_product_order_no: pon, marketplace_status: o.marketplace_status, marketplace_synced_at: o.marketplace_synced_at })
            .eq("id", plto.id)
            .eq("user_id", userId);
          plto.marketplace_product_order_no = pon;
          existing.byProductOrderNo.set(pon, plto);
        }
        continue;
      }
      toInsert.push(o);
    }

    // ── 2-b. 상품 소싱 정보 보강 (엑셀 임포트와 동일 규칙: 상품명 일치 시 최저가 링크 + 원가=최저가×수량)
    await enrichOrdersWithProducts(supabase, userId, toInsert);

    // ── 3. 등록
    const insertedIds = new Map<string, string>(); // productOrderNo → order id
    if (!dryRun) {
      for (let i = 0; i < toInsert.length; i += 200) {
        const chunk = toInsert.slice(i, i + 200);
        const { data, error } = await supabase.from("orders").insert(chunk).select("id,marketplace_product_order_no");
        if (error) {
          result.errors.push(`발주서 등록 실패: ${error.message}`);
          continue;
        }
        for (const r of (data ?? []) as Array<{ id: string; marketplace_product_order_no: string }>) insertedIds.set(r.marketplace_product_order_no, r.id);
      }
    }
    result.newOrders = toInsert.map((o) => ({
      id: insertedIds.get(o.marketplace_product_order_no ?? ""),
      bundleNo: o.bundle_no,
      recipientName: o.recipient_name,
      productName: o.product_name,
      quantity: o.quantity,
      revenue: o.revenue,
      marketplaceStatus: o.marketplace_status ?? null,
    }));
    await logMarketplaceApi(supabase, {
      user_id: userId,
      platform,
      credential_id: opts.credentialId,
      action: dryRun ? "sync-orders:dry" : "sync-orders",
      status: "success",
      new_value: `remote=${result.remoteCount} new=${toInsert.length} existing=${result.skippedExisting}`,
      // 대시보드 활동 로그 클릭 시 이번에 수집된 주문만 필터하기 위한 마켓주문번호 목록
      response_payload: toInsert.length > 0 ? { newProductOrderNos: toInsert.map((o) => o.marketplace_product_order_no).filter(Boolean).slice(0, 200) } : null,
    });

    // ── 4. 발주확인 (미확인 건만)
    const pending = toInsert.filter((o) => !o.confirmed_at);
    if (pending.length > 0) {
      if (platform === "coupang") {
        const boxIds = [...new Set(pending.map((o) => Number(o.bundle_no)))];
        for (let i = 0; i < boxIds.length; i += 50) {
          const batch = boxIds.slice(i, i + 50);
          const res = await opts.coupang!.acknowledgeOrderSheets(batch);
          const list = res.ok && res.body && typeof res.body === "object" ? res.body.data?.responseList ?? [] : [];
          const okIds = new Set(res.dryRun ? batch : list.filter((r) => r.succeed).map((r) => r.shipmentBoxId));
          const failed = res.dryRun ? [] : batch.filter((b) => !okIds.has(b));
          if (!res.ok && !res.dryRun) failed.push(...batch.filter((b) => !failed.includes(b)));
          for (const o of pending.filter((o) => batch.includes(Number(o.bundle_no)))) {
            const id = insertedIds.get(o.marketplace_product_order_no ?? "");
            if (okIds.has(Number(o.bundle_no)) && !failed.includes(Number(o.bundle_no))) {
              result.confirmed++;
              if (id && !res.dryRun) await supabase.from("orders").update({ confirmed_at: new Date().toISOString(), marketplace_status: "INSTRUCT" }).eq("id", id);
            } else {
              result.confirmFailed++;
            }
          }
          if (failed.length > 0) result.confirmErrors.push(`쿠팡 발주확인 실패 ${failed.length}건: ${res.message}`);
          await logMarketplaceApi(supabase, {
            user_id: userId, platform, credential_id: opts.credentialId,
            action: res.dryRun ? "confirm:dry" : "confirm", status: res.ok ? "success" : "failed",
            new_value: `boxes=${batch.length} ok=${okIds.size}`, error_message: res.ok ? null : res.message,
            response_payload: typeof res.body === "object" ? res.body : { body: res.body },
          });
          await sleep(300);
        }
      } else {
        const ids = pending.map((o) => o.marketplace_product_order_no!).filter(Boolean);
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          const res = await opts.smartstore!.confirmProductOrders(batch);
          const okBody = res.ok && res.body && typeof res.body === "object" ? res.body.data : undefined;
          const okIds = new Set(res.dryRun ? batch : [...(okBody?.successProductOrderIds ?? []), ...(okBody?.successProductOrderInfos ?? []).map((x) => x.productOrderId)]);
          const fails = res.ok && res.body && typeof res.body === "object" ? res.body.data?.failProductOrderInfos ?? [] : [];
          for (const pon of batch) {
            if (okIds.has(pon)) {
              result.confirmed++;
              const id = insertedIds.get(pon);
              if (id && !res.dryRun) await supabase.from("orders").update({ confirmed_at: new Date().toISOString() }).eq("id", id);
            } else {
              result.confirmFailed++;
            }
          }
          if (fails.length > 0 || !res.ok) result.confirmErrors.push(`스토어 발주확인 실패 ${res.ok ? fails.length : batch.length}건: ${fails.map((f) => f.message).join("; ") || res.message}`);
          await logMarketplaceApi(supabase, {
            user_id: userId, platform, credential_id: opts.credentialId,
            action: res.dryRun ? "confirm:dry" : "confirm", status: res.ok ? "success" : "failed",
            new_value: `ids=${batch.length} ok=${okIds.size}`, error_message: res.ok ? null : res.message,
            response_payload: typeof res.body === "object" ? res.body : { body: res.body },
          });
          await sleep(600);
        }
      }
    }

    // ── 5. 클레임 동기화
    if (platform === "coupang") {
      await syncCoupangClaims(opts, existing, days, result, dryRun);
    } else {
      await syncNaverClaims(opts, existing, days, result, dryRun);
    }
    for (const c of result.claims) result.claimCounts[c.to] = (result.claimCounts[c.to] ?? 0) + 1;

    // ── 7. 취소요청 자동 승인 (설정 on 일 때, 운송장·구매 전 건만)
    const newCancelReq = result.claims.filter((c) => c.to === "취소요청").map((c) => c.orderId);
    if (newCancelReq.length > 0) {
      const setting = await getAppSetting<{ enabled?: boolean }>(supabase, userId, "auto_approve_cancel");
      if (setting?.enabled) {
        const { data: rows } = await supabase.from("orders").select("id,tracking_no,purchased_at,purchase_order_no,delivery_status").eq("user_id", userId).in("id", newCancelReq);
        const eligible = (rows ?? []).filter((r) => r.delivery_status === "취소요청" && !r.tracking_no && !r.purchased_at && !r.purchase_order_no).map((r) => r.id);
        if (eligible.length > 0) {
          result.autoApproved = await approveCancelRequests({ supabase, userId, credentialId: opts.credentialId, platform, orderIds: eligible, coupang: opts.coupang, smartstore: opts.smartstore, action: "auto-approve-cancel" });
        }
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  if (result.runId) {
    await supabase
      .from("marketplace_sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: result.errors.length > 0 ? (result.newOrders.length > 0 || result.claims.length > 0 ? "partial" : "failed") : "success",
        remote_count: result.remoteCount,
        new_orders: result.newOrders.length,
        confirmed: result.confirmed,
        confirm_failed: result.confirmFailed,
        claims: result.claimCounts,
        error: result.errors.length > 0 ? result.errors.join(" | ").slice(0, 2000) : null,
        detail: { skippedExisting: result.skippedExisting, confirmErrors: result.confirmErrors, claims: result.claims.slice(0, 50), autoApproved: result.autoApproved },
      })
      .eq("id", result.runId);
  }
  return result;
}

// ───────────────────────── 클레임 ─────────────────────────

type Existing = Awaited<ReturnType<typeof loadExistingOrders>>;

export async function applyClaim(
  supabase: SupabaseClient,
  userId: string,
  credentialId: string | null,
  platform: SyncPlatform,
  order: ExistingOrder,
  to: string,
  claimType: string,
  claimStatus: string,
  reason: string | undefined,
  result: SyncResult,
  dryRun: boolean,
  receiptId?: string | number | null,
) {
  if (TERMINAL.has(order.delivery_status)) return;
  if (order.delivery_status === to) {
    // 상태는 같아도 접수번호·세부 단계는 최신으로 (반품 입고확인 등 단계 표시용)
    if (!dryRun && (receiptId != null || claimStatus)) {
      await supabase.from("orders").update({ claim_status: claimStatus, claim_receipt_id: receiptId != null ? String(receiptId) : undefined, ...(reason ? { claim_reason: reason } : {}), marketplace_synced_at: new Date().toISOString() }).eq("id", order.id).eq("user_id", userId);
    }
    return;
  }
  // 취소요청이 이미 취소준비(판매자 취소 진행 중)면 상태 유지
  if (to === "취소요청" && order.delivery_status === "취소준비") return;
  // 반품 역행 방지: 우리가 지마켓 반품신청/완료로 올린 단계를, 마켓이 보내는 낮은 반품단계(진행중=반품준비)로 되돌리지 않는다.
  // 상태는 유지하고 claim_* 만 최신화 (준비<접수<완료 rank; 반품 아닌 to 는 rank 0 이라 영향 없음)
  const toRank = returnRank(to);
  const curRank = returnRank(order.delivery_status);
  if (toRank > 0 && curRank > 0 && toRank < curRank) {
    if (!dryRun && (receiptId != null || claimStatus)) {
      await supabase.from("orders").update({ claim_status: claimStatus, claim_receipt_id: receiptId != null ? String(receiptId) : undefined, ...(reason ? { claim_reason: reason } : {}), marketplace_synced_at: new Date().toISOString() }).eq("id", order.id).eq("user_id", userId);
    }
    return;
  }
  const locked = LOCKED.has(order.delivery_status);
  const patch: Record<string, unknown> = { claim_type: claimType, claim_status: claimStatus, marketplace_synced_at: new Date().toISOString() };
  if (receiptId != null) patch.claim_receipt_id = String(receiptId);
  if (reason) patch.claim_reason = reason; // 구매처 반품신청 자동화의 사유 분기·인용용
  if (!locked) {
    patch.delivery_status = to;
    if (to === "취소완료") patch.canceled_at = new Date().toISOString();
    if (to === "반품완료") patch.returned_at = new Date().toISOString();
  }
  if (!dryRun) {
    const { error } = await supabase.from("orders").update(patch).eq("id", order.id).eq("user_id", userId).eq("delivery_status", order.delivery_status);
    if (error) { result.errors.push(`클레임 반영 실패(${order.id}): ${error.message}`); return; }
  }
  result.claims.push({
    orderId: order.id, bundleNo: order.bundle_no, recipientName: order.recipient_name, productName: order.product_name,
    from: order.delivery_status, to: locked ? `${order.delivery_status}(클레임 기록만)` : to, claimType, claimStatus, reason,
  });
  await logMarketplaceApi(supabase, {
    user_id: userId, platform, credential_id: credentialId, action: dryRun ? "claim:dry" : "claim", status: "success",
    product_name: order.product_name, target_id: order.marketplace_product_order_no ?? order.marketplace_order_no,
    previous_value: order.delivery_status, new_value: locked ? null : to, error_message: null,
    response_payload: { claimType, claimStatus, reason: reason ?? null },
  });
  if (!locked) order.delivery_status = to;
}

async function syncCoupangClaims(opts: SyncOptions, existing: Existing, days: number, result: SyncResult, dryRun: boolean) {
  const client = opts.coupang!;
  const receipts: Array<CoupangReturnRequest & { _type: "RETURN" | "CANCEL" }> = [];
  // 기간이 길면 쿠팡이 504 를 내므로 하루 단위로 나눠 조회한다
  for (const cancelType of ["RETURN", "CANCEL"] as const) {
    for (let d = days; d >= 0; d--) {
      const dayFrom = new Date(Date.now() - d * 86400000);
      const dayTo = new Date(dayFrom.getTime() + 86400000);
      let nextToken: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await client.listReturnRequests({
          createdAtFrom: `${ymd(dayFrom)}T00:00`,
          createdAtTo: `${ymd(dayTo)}T00:00`,
          cancelType,
          nextToken,
          maxPerPage: 50,
        });
        if (!res.ok || !res.body || typeof res.body === "string") {
          result.errors.push(`쿠팡 클레임 조회 실패(${cancelType} ${ymd(dayFrom)}): ${res.message}`);
          break;
        }
        receipts.push(...(res.body.data ?? []).map((r) => ({ ...r, _type: cancelType })));
        nextToken = res.body.nextToken || undefined;
        await sleep(300);
        if (!nextToken) break;
      }
    }
  }
  const seenReceipt = new Set<number>();
  for (const r of receipts) {
    if (seenReceipt.has(r.receiptId)) continue;
    seenReceipt.add(r.receiptId);
    const orders = existing.byOrderNo.get(String(r.orderId)) ?? [];
    if (orders.length === 0) continue;
    const itemIds = new Set((r.returnItems ?? []).map((i) => String(i.vendorItemId)));
    const targets = orders.filter((o) => !o.marketplace_product_order_no || itemIds.size === 0 || itemIds.has(o.marketplace_product_order_no.split("-")[1] ?? ""));
    const reason = [r.cancelReasonCategory1, r.cancelReasonCategory2, r.cancelReason].filter(Boolean).join(" / ");
    // 판매자가 우리 API/윙으로 처리한 취소는 이미 취소완료 → 구매자 사유만 새로 반영
    let toStatus: string | null = null;
    let claimType = r._type === "CANCEL" ? "CANCEL" : "RETURN";
    if (r.receiptStatus === "RELEASE_STOP_UNCHECKED") { toStatus = "취소요청"; claimType = "CANCEL"; }
    else if (r.receiptStatus === "RETURNS_COMPLETED" && (r._type === "CANCEL" || (r.returnItems ?? []).every((i) => i.releaseStatus === "S"))) { toStatus = "취소완료"; claimType = "CANCEL"; }
    else if (r.receiptStatus === "RETURNS_UNCHECKED" || r.receiptStatus === "VENDOR_WAREHOUSE_CONFIRM" || r.receiptStatus === "REQUEST_COUPANG_CHECK") { toStatus = "반품준비"; claimType = "RETURN"; }
    else if (r.receiptStatus === "RETURNS_COMPLETED") { toStatus = "반품완료"; claimType = "RETURN"; }
    if (!toStatus) continue;
    for (const o of targets) await applyClaim(opts.supabase, opts.userId, opts.credentialId, "coupang", o, toStatus, claimType, r.receiptStatus, reason, result, dryRun, r.receiptId);
  }
  await syncCoupangExchanges(opts, existing, days, result, dryRun);
}

/** 쿠팡 교환요청 — 접수/진행 → 교환준비, 완료 → 교환완료. 최대 7일 조회라 하루 단위로 나눈다 */
async function syncCoupangExchanges(opts: SyncOptions, existing: Existing, days: number, result: SyncResult, dryRun: boolean) {
  const client = opts.coupang!;
  const list: CoupangExchangeRequest[] = [];
  for (let d = days; d >= 0; d--) {
    const dayFrom = new Date(Date.now() - d * 86400000);
    let nextToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await client.listExchangeRequests({ createdAtFrom: `${ymd(dayFrom)}T00:00:00`, createdAtTo: `${ymd(dayFrom)}T23:59:59`, nextToken, maxPerPage: 50 });
      if (!res.ok || !res.body || typeof res.body === "string") { result.errors.push(`쿠팡 교환 조회 실패(${ymd(dayFrom)}): ${res.message}`); break; }
      list.push(...(res.body.data ?? []));
      nextToken = res.body.nextToken || undefined;
      await sleep(300);
      if (!nextToken) break;
    }
  }
  const seen = new Set<number>();
  for (const x of list) {
    if (seen.has(x.exchangeId)) continue;
    seen.add(x.exchangeId);
    const orders = existing.byOrderNo.get(String(x.orderId)) ?? [];
    if (orders.length === 0) continue;
    const itemIds = new Set((x.exchangeItemDtoV1s ?? []).map((i) => String(i.vendorItemId)));
    const targets = orders.filter((o) => !o.marketplace_product_order_no || itemIds.size === 0 || itemIds.has(o.marketplace_product_order_no.split("-")[1] ?? ""));
    const st = String(x.exchangeStatus ?? "").toUpperCase();
    let to: string | null = null;
    if (st === "RECEIPT" || st === "PROGRESS") to = "교환준비";
    else if (st === "SUCCESS") to = "교환완료";
    if (!to) continue; // REJECT/CANCEL 은 발주서 상태 유지
    const reason = [x.reasonCodeText, x.reason].filter(Boolean).join(" / ");
    for (const o of targets) await applyClaim(opts.supabase, opts.userId, opts.credentialId, "coupang", o, to, "EXCHANGE", `${st}${x.receiptStatus ? `/${x.receiptStatus}` : ""}`, reason, result, dryRun, x.exchangeId);
  }
}

async function syncNaverClaims(opts: SyncOptions, existing: Existing, days: number, result: SyncResult, dryRun: boolean) {
  const client = opts.smartstore!;
  const ids = new Set<string>();
  for (const type of ["CLAIM_REQUESTED", "CLAIM_COMPLETED"] as const) {
    try { for (const id of await fetchNaverChangedIds(client, days, type)) ids.add(id); }
    catch (err) { result.errors.push(err instanceof Error ? err.message : String(err)); }
  }
  if (ids.size === 0) return;
  const details = await fetchNaverDetails(client, [...ids]);
  for (const d of details) {
    const o = existing.byProductOrderNo.get(d.productOrder?.productOrderId ?? "");
    if (!o) continue;
    const claim = d.currentClaim ?? {};
    const status = d.productOrder.productOrderStatus;
    const type = (claim.claimType ?? d.productOrder.claimType ?? "").toUpperCase();
    const cs = (claim.claimStatus ?? d.productOrder.claimStatus ?? "").toUpperCase();
    const reason = claim.cancelReason ?? claim.returnReason ?? claim.exchangeReason;
    let toStatus: string | null = null;
    if (status === "CANCELED" || cs === "CANCEL_DONE") toStatus = "취소완료";
    else if (type === "CANCEL" && cs.startsWith("CANCEL_REQUEST")) toStatus = "취소요청";
    else if (type === "RETURN") toStatus = status === "RETURNED" || cs === "RETURN_DONE" ? "반품완료" : "반품준비";
    else if (type === "EXCHANGE") toStatus = status === "EXCHANGED" || cs === "EXCHANGE_DONE" ? "교환완료" : "교환준비";
    else if (type === "ADMIN_CANCEL") toStatus = "취소완료";
    if (!toStatus) continue;
    await applyClaim(opts.supabase, opts.userId, opts.credentialId, "smartstore", o, toStatus, type || "CANCEL", cs || status, reason, result, dryRun, claim.claimId ?? null);
  }
}

// ───────────────────────── 취소요청 승인 ─────────────────────────

export interface ApproveInput {
  supabase: SupabaseClient;
  userId: string;
  credentialId: string | null;
  platform: SyncPlatform;
  orderIds: string[];
  coupang?: CoupangOpenApiClient;
  smartstore?: NaverCommerceApiClient;
  /** 로그 action (기본 approve-cancel) */
  action?: "approve-cancel" | "auto-approve-cancel";
}

export interface ApproveResultRow {
  orderId: string;
  recipientName: string | null;
  productName: string | null;
  status: "success" | "failed" | "dry";
  message: string;
}

/** 구매자 취소요청 승인 — 스토어 approve / 쿠팡 출고중지완료. 성공 시 취소완료. */
export async function approveCancelRequests(input: ApproveInput): Promise<ApproveResultRow[]> {
  const { supabase, userId, platform } = input;
  const dryRun = isDryRun();
  const { data } = await supabase
    .from("orders")
    .select("id,recipient_name,product_name,quantity,delivery_status,marketplace_order_no,marketplace_product_order_no")
    .eq("user_id", userId)
    .in("id", input.orderIds);
  const rows = (data ?? []) as ExistingOrder[];
  const out: ApproveResultRow[] = [];
  for (const o of rows) {
    let ok = false;
    let message = "";
    if (o.delivery_status !== "취소요청") { out.push({ orderId: o.id, recipientName: o.recipient_name, productName: o.product_name, status: "failed", message: `취소요청 상태가 아님 (${o.delivery_status})` }); continue; }
    try {
      if (platform === "smartstore") {
        if (!o.marketplace_product_order_no) throw new Error("상품주문번호 없음");
        const res = await input.smartstore!.approveCancel(o.marketplace_product_order_no);
        ok = res.ok; message = res.dryRun ? "DRY RUN" : res.ok ? "취소 승인 완료" : res.message;
      } else {
        if (!o.marketplace_order_no) throw new Error("마켓 주문번호 없음");
        const receipt = await findCoupangReceipt(input.coupang!, o.marketplace_order_no);
        if (!receipt) throw new Error("출고중지 접수 내역을 찾지 못함");
        if (receipt.receiptStatus === "RETURNS_COMPLETED") { ok = true; message = "이미 처리 완료"; }
        else {
          const res = await input.coupang!.stopShipment(receipt.receiptId, receipt.cancelCountSum || o.quantity);
          ok = res.ok; message = res.dryRun ? "DRY RUN" : res.ok ? "출고중지완료 (취소 승인)" : res.message;
        }
      }
    } catch (err) { ok = false; message = err instanceof Error ? err.message : String(err); }
    const status: ApproveResultRow["status"] = dryRun ? "dry" : ok ? "success" : "failed";
    if (ok && !dryRun) {
      await supabase.from("orders").update({ delivery_status: "취소완료", canceled_at: new Date().toISOString(), claim_status: "APPROVED" }).eq("id", o.id).eq("user_id", userId).eq("delivery_status", "취소요청");
    }
    await logMarketplaceApi(supabase, {
      user_id: userId, platform, credential_id: input.credentialId, action: dryRun ? `${input.action ?? "approve-cancel"}:dry` : (input.action ?? "approve-cancel"), status: ok ? "success" : "failed",
      product_name: o.product_name, target_id: o.marketplace_product_order_no ?? o.marketplace_order_no, previous_value: "취소요청", new_value: ok && !dryRun ? "취소완료" : null, error_message: ok ? null : message,
    });
    out.push({ orderId: o.id, recipientName: o.recipient_name, productName: o.product_name, status, message });
    await sleep(platform === "coupang" ? 400 : 700);
  }
  return out;
}

// ───────────────────────── 취소요청 거절 (발송 강행) ─────────────────────────

/**
 * 구매자 취소요청 거절 — 운송장이 있어야 한다.
 *  스토어: 발송처리(dispatch) 가 곧 거절 / 쿠팡: 출고중지요청 접수건을 "이미출고" 처리(송장 등록)
 *  성공 시 배송완료 + shipped_to_marketplace_at, claim_status REJECTED
 */
export async function rejectCancelRequests(input: ApproveInput): Promise<ApproveResultRow[]> {
  const { supabase, userId, platform } = input;
  const dryRun = isDryRun();
  const { data } = await supabase
    .from("orders")
    .select("id,recipient_name,product_name,quantity,delivery_status,marketplace_order_no,marketplace_product_order_no,courier,tracking_no")
    .eq("user_id", userId)
    .in("id", input.orderIds);
  type Row = ExistingOrder & { courier: string | null; tracking_no: string | null };
  const out: ApproveResultRow[] = [];
  for (const o of (data ?? []) as Row[]) {
    const base = { orderId: o.id, recipientName: o.recipient_name, productName: o.product_name };
    if (o.delivery_status !== "취소요청") { out.push({ ...base, status: "failed", message: `취소요청 상태가 아님 (${o.delivery_status})` }); continue; }
    if (!o.tracking_no?.trim()) { out.push({ ...base, status: "failed", message: "운송장을 먼저 입력하세요 (거절 = 발송처리)" }); continue; }
    const code = getMarketplaceCourierCode(o.courier, platform);
    if (!code) { out.push({ ...base, status: "failed", message: `택배사 코드 없음: ${o.courier ?? "(미입력)"}` }); continue; }
    let ok = false;
    let message = "";
    try {
      if (platform === "smartstore") {
        if (!o.marketplace_product_order_no) throw new Error("상품주문번호 없음");
        const res = await input.smartstore!.dispatchProductOrders([{ productOrderId: o.marketplace_product_order_no, deliveryCompanyCode: code, trackingNumber: o.tracking_no.trim() }]);
        const body = (!res.body || typeof res.body === "string") ? undefined : res.body.data;
        const fail = body?.failProductOrderInfos?.find((f) => f.productOrderId === o.marketplace_product_order_no);
        ok = res.ok && !fail; message = res.dryRun ? "DRY RUN" : ok ? "발송처리 (취소요청 거절)" : fail ? `${fail.code ?? ""} ${fail.message ?? ""}`.trim() : res.message;
        if (res.dryRun) ok = true;
      } else {
        if (!o.marketplace_order_no) throw new Error("마켓 주문번호 없음");
        const receipt = await findCoupangReceipt(input.coupang!, o.marketplace_order_no);
        if (!receipt) throw new Error("출고중지요청 접수 내역을 찾지 못함");
        if (receipt.receiptStatus !== "RELEASE_STOP_UNCHECKED" && receipt.receiptStatus !== "RETURNS_UNCHECKED") throw new Error(`거절할 수 없는 접수 상태: ${receipt.receiptStatus}`);
        const res = await input.coupang!.completeShipment(receipt.receiptId, code, o.tracking_no.trim());
        const rc = (!res.body || typeof res.body === "string") ? undefined : res.body.data?.resultCode;
        ok = res.ok && (rc == null || rc === "SUCCESS"); message = res.dryRun ? "DRY RUN" : ok ? "이미출고 처리 (취소요청 거절)" : ((!res.body || typeof res.body === "string") ? res.message : res.body.data?.resultMessage ?? res.message);
        if (res.dryRun) ok = true;
      }
    } catch (err) { ok = false; message = err instanceof Error ? err.message : String(err); }
    const status: ApproveResultRow["status"] = dryRun ? "dry" : ok ? "success" : "failed";
    if (ok && !dryRun) {
      await supabase.from("orders").update({ delivery_status: "배송완료", claim_status: "REJECTED", shipped_to_marketplace_at: new Date().toISOString(), ship_error: null, marketplace_status: platform === "coupang" ? "DEPARTURE" : "DELIVERING" }).eq("id", o.id).eq("user_id", userId).eq("delivery_status", "취소요청");
    }
    await logMarketplaceApi(supabase, {
      user_id: userId, platform, credential_id: input.credentialId, action: dryRun ? "reject-cancel:dry" : "reject-cancel", status: ok ? "success" : "failed",
      product_name: o.product_name, target_id: o.marketplace_product_order_no ?? o.marketplace_order_no, previous_value: "취소요청", new_value: ok && !dryRun ? "배송완료(거절)" : null, error_message: ok ? null : message,
    });
    out.push({ ...base, status, message });
    await sleep(platform === "coupang" ? 400 : 700);
  }
  return out;
}

// ───────────────────────── 마켓번호 백필 (플토 엑셀로 들어온 옛 행) ─────────────────────────

export interface BackfillResult {
  platform: SyncPlatform;
  remoteCount: number;
  alreadyLinked: number;
  filled: number;
  notFound: number;
  errors: string[];
}

/**
 * 최근 N일 마켓 주문(모든 상태)을 조회해, 마켓번호가 없는 발주서 행에 결제일+수취인+상품명 매칭으로
 * marketplace_order_no / marketplace_product_order_no 를 채운다. 신규 등록·마켓 쓰기 없음.
 * (정산 API·클레임·송장 전송이 마켓번호로 매칭하므로 API 전환 전 주문에 한 번 실행)
 */
export async function backfillMarketplaceNumbers(opts: SyncOptions): Promise<BackfillResult> {
  const { supabase, userId, platform } = opts;
  const days = Math.min(opts.days ?? 35, 90);
  const result: BackfillResult = { platform, remoteCount: 0, alreadyLinked: 0, filled: 0, notFound: 0, errors: [] };
  const existing = await loadExistingOrders(supabase, userId, platform, days);
  let candidates: OrderInsert[] = [];
  if (platform === "coupang") {
    const client = opts.coupang!;
    const to = new Date(Date.now() + 86400000);
    for (let end = to; end.getTime() > to.getTime() - days * 86400000; end = new Date(end.getTime() - 31 * 86400000)) {
      const start = new Date(Math.max(end.getTime() - 30 * 86400000, to.getTime() - days * 86400000));
      for (const status of ["ACCEPT", "INSTRUCT", "DEPARTURE", "DELIVERING", "FINAL_DELIVERY", "NONE_TRACKING"] as const) {
        try {
          const sheets = await client.listAllOrderSheets({ createdAtFrom: ymd(start), createdAtTo: ymd(end), status });
          candidates.push(...sheets.flatMap((sh) => mapCoupangOrderSheet(sh, userId)));
        } catch (err) { result.errors.push(err instanceof Error ? err.message : String(err)); }
        await sleep(300);
      }
    }
  } else {
    const client = opts.smartstore!;
    const details = await searchNaverOrdersByPaidDate(client, days, result.errors);
    candidates = details.map((d) => mapNaverProductOrder(d, userId)).filter((o): o is OrderInsert => !!o);
  }
  result.remoteCount = candidates.length;
  const seen = new Set<string>();
  for (const o of candidates) {
    const pon = o.marketplace_product_order_no ?? "";
    if (!pon || seen.has(pon)) continue;
    seen.add(pon);
    if (existing.byProductOrderNo.has(pon)) { result.alreadyLinked++; continue; }
    const pool = (existing.byFuzzy.get(fuzzyKey(o.order_date, o.recipient_name, o.product_name)) ?? []).filter((r) => !r.marketplace_product_order_no);
    const plto = pool.shift();
    if (!plto) { result.notFound++; continue; }
    const { error } = await supabase
      .from("orders")
      .update({ marketplace_order_no: o.marketplace_order_no, marketplace_product_order_no: pon, marketplace_status: o.marketplace_status, marketplace_synced_at: new Date().toISOString() })
      .eq("id", plto.id)
      .eq("user_id", userId)
      .is("marketplace_product_order_no", null);
    if (error) { result.errors.push(`갱신 실패(${plto.id}): ${error.message}`); continue; }
    plto.marketplace_product_order_no = pon;
    existing.byProductOrderNo.set(pon, plto);
    result.filled++;
  }
  await logMarketplaceApi(supabase, { user_id: userId, platform, credential_id: opts.credentialId, action: "backfill", status: result.errors.length ? "failed" : "success", new_value: `remote=${result.remoteCount} linked=${result.alreadyLinked} filled=${result.filled} notFound=${result.notFound}`, error_message: result.errors[0] ?? null });
  return result;
}

// ───────────────────────── 상품 소싱 정보 보강 ─────────────────────────

/** 엑셀 임포트(excel-import.tsx)와 동일한 상품명 정규화 */
function normalizeProductName(name: string) {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 상품명이 상품 목록과 일치하면 purchase_url(최저가 링크)과 cost(최저가×수량)를 채운다. 기존 값은 보존.
 * 반환: { urlMatched, costMatched }
 */
export async function enrichOrdersWithProducts(
  supabase: SupabaseClient,
  userId: string,
  orders: Array<{ product_name: string | null; quantity: number; purchase_url: string | null; cost: number }>,
) {
  const targets = orders.filter((o) => o.product_name && (!o.purchase_url || !o.cost));
  if (targets.length === 0) return { urlMatched: 0, costMatched: 0 };

  const products: Array<{ product_name: string; purchase_url: string | null; lowest_price: number | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("products")
      .select("product_name, purchase_url, lowest_price")
      .eq("user_id", userId)
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    products.push(...data);
    if (data.length < 1000) break;
  }
  const map = new Map<string, { url: string | null; price: number | null }>();
  for (const p of products) if (p.product_name) map.set(normalizeProductName(p.product_name), { url: p.purchase_url, price: p.lowest_price });

  let urlMatched = 0;
  let costMatched = 0;
  for (const o of targets) {
    const m = map.get(normalizeProductName(o.product_name!));
    if (!m) continue;
    if (!o.purchase_url && m.url) { o.purchase_url = m.url; urlMatched++; }
    if ((!o.cost || o.cost === 0) && m.price && m.price > 0) { o.cost = m.price * (o.quantity || 1); costMatched++; }
  }
  return { urlMatched, costMatched };
}
