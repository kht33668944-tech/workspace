// 발주 후 무인 자동구매 스테이지 — 주문수집 크론(marketplace-order-sync.mts) 직후 실행.
// 흐름: 설정 확인 → 대상 조회(구매대기) → 원가갱신(scrape-prices API) → 품절/적자 스킵
//       → 기본 구매계정 배정 → 자동구매 API 호출 → 실행 기록 + 디스코드 보고
// 안전장치:
// - app_settings.auto_purchase.enabled 가 꺼져 있으면 아무것도 하지 않는다 (기본 꺼짐)
// - 품절·적자(원가×수량>정산예정)·정산예정 없음·타플랫폼·상품 미매칭은 건드리지 않고 스킵
// - 실결제 한도는 auto-purchase 서버가 정산예정÷수량으로 이중 검사한다
// - dryRun 이면 DB 쓰기·구매 호출 없이 "구매 예정/스킵 목록"만 보고한다

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppSetting, type AutoPurchaseSetting } from "@/lib/app-settings";
import { startSyncRun, finishSyncRun } from "@/lib/marketplace/sync-run";
import { notifyAutomationResult } from "@/lib/discord-notifier";
import { buildPurchaseNotification, type PurchaseNotifyItem } from "@/lib/purchase-notification";
import type { PurchaseOrderInfo, PurchasedUnit } from "@/lib/scrapers/types";
import { parsePurchaseOrders } from "@/lib/purchase-orders";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

// ── 원가갱신 매칭 규칙 (app/workspace/orders/page.tsx 수동 흐름과 동일) ──
const PURCHASE_SOURCES = [
  { label: "지마켓", platform: "gmarket", patterns: ["gmarket.co.kr"] },
] as const;

function normalizeNameForMatch(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function detectPlatform(url: string | null | undefined): (typeof PURCHASE_SOURCES)[number] | null {
  const raw = url?.trim().toLowerCase();
  if (!raw) return null;
  return PURCHASE_SOURCES.find((s) => s.patterns.some((p) => raw.includes(p))) ?? null;
}

interface OrderRow {
  id: string;
  marketplace: string | null;
  product_name: string | null;
  purchase_url: string | null;
  purchase_id: string | null;
  purchase_order_no: string | null;
  tracking_no: string | null;
  purchased_at: string | null;
  delivery_status: string;
  quantity: number | null;
  settlement: number | null;
  cost: number | null;
  memo: string | null;
  purchase_source: string | null;
  recipient_name: string | null;
  postal_code: string | null;
  address: string | null;
  address_detail: string | null;
  recipient_phone: string | null;
  delivery_memo: string | null;
  purchase_orders?: unknown;
}

interface ProductRow {
  id: string;
  product_name: string | null;
  purchase_url: string | null;
  lowest_price: number | null;
}

interface ScrapeProgressEvent {
  type: "progress";
  id: string;
  price: number;
  bot_blocked?: boolean;
  fail_reason?: string | null;
}

export interface AutoPurchaseStageResult {
  ran: boolean;               // 설정 꺼짐/대상 없음이면 false
  dryRun: boolean;
  total: number;              // 구매대기 후보 전체
  purchased: number;
  purchaseFailed: number;
  /** 건별 결과 (디스코드 건별 보고용) — 수동 모달과 같은 포맷 */
  purchasedItems: PurchaseNotifyItem[];
  failedItems: PurchaseNotifyItem[];
  wouldPurchase: string[];    // dryRun 시 구매 예정 목록 (상품명)
  skipped: {
    platform: number;         // 지마켓 외 링크
    noProduct: number;        // 상품소싱 미매칭 (원가 갱신 불가)
    soldOut: number;
    deficit: number;          // 원가×수량 > 정산예정
    noSettlement: number;     // 정산예정금액 없음
    priceFailed: number;      // 최저가 수집 실패 (재시도 후에도)
  };
  errors: string[];
}

const EMPTY_RESULT: AutoPurchaseStageResult = {
  ran: false, dryRun: false, total: 0, purchased: 0, purchaseFailed: 0, purchasedItems: [], failedItems: [], wouldPurchase: [],
  skipped: { platform: 0, noProduct: 0, soldOut: 0, deficit: 0, noSettlement: 0, priceFailed: 0 },
  errors: [],
};

/** SSE 응답을 읽어 data: 이벤트를 순서대로 파싱 */
async function readSseEvents(res: Response, onEvent: (e: Record<string, unknown>) => void): Promise<void> {
  if (!res.body) throw new Error("SSE 응답에 body 없음");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try { onEvent(JSON.parse(line.slice(6))); } catch { /* 부분 청크는 무시 */ }
      }
    }
  }
}

/** 원가갱신: scrape-prices API 호출 → productId별 결과. 봇차단/실패는 재시도 */
async function refreshPrices(
  baseUrl: string,
  token: string,
  productIds: string[],
  log: (msg: string) => void,
): Promise<Map<string, { status: "priced" | "sold_out" | "failed"; price: number }>> {
  const results = new Map<string, { status: "priced" | "sold_out" | "failed"; price: number }>();
  let pending = [...productIds];
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length > 0; attempt++) {
    if (attempt > 1) {
      log(`가격 수집 재시도 ${pending.length}개 (${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    const retry: string[] = [];
    const res = await fetch(`${baseUrl}/api/products/scrape-prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ productIds: pending, notify: false }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`원가갱신 API 실패 (HTTP ${res.status}${err.error ? `: ${err.error}` : ""})`);
    }
    await readSseEvents(res, (e) => {
      if (e.type !== "progress") return;
      const ev = e as unknown as ScrapeProgressEvent;
      if (ev.price > 0) results.set(ev.id, { status: "priced", price: ev.price });
      else if (ev.fail_reason === "sold_out") results.set(ev.id, { status: "sold_out", price: 0 });
      else retry.push(ev.id); // 봇차단·수집 실패 → 재시도
    });
    pending = retry;
  }
  for (const id of pending) results.set(id, { status: "failed", price: 0 });
  return results;
}

export interface AutoPurchaseStageOpts {
  supabase: AnySupabase;      // service role
  userId: string;
  baseUrl: string;            // AUTO_BASE_URL (Next 서버)
  token: string;              // 사용자 JWT (매직링크 발급)
  paymentPin: string | null;  // env GMARKET_PAYMENT_PIN
  dryRun: boolean;
  trigger: "scheduler" | "manual";
  /** 주면 이 주문들만 대상 (선택 구매·테스트). 없으면 전체 구매대기 (크론) */
  orderIds?: string[];
  log?: (msg: string) => void;
}

export async function runAutoPurchaseStage(opts: AutoPurchaseStageOpts): Promise<AutoPurchaseStageResult> {
  const log = opts.log ?? ((m: string) => console.log(`[auto-purchase-stage] ${m}`));
  const result: AutoPurchaseStageResult = structuredClone(EMPTY_RESULT);
  result.dryRun = opts.dryRun;

  // 1. 설정 확인 — 꺼져 있으면 조용히 종료 (기록도 안 남긴다: 꺼진 동안 타임라인 노이즈 방지)
  const setting = await getAppSetting<AutoPurchaseSetting>(opts.supabase, opts.userId, "auto_purchase");
  if (!setting?.enabled) { log("auto_purchase 설정 꺼짐 — 스킵"); return result; }
  const gmarketAccount = setting.accounts?.gmarket?.trim();
  if (!gmarketAccount) { log("지마켓 기본 구매계정 미설정 — 스킵"); return result; }

  // 2. 대상 조회 (자동구매 모달의 purchasableOrders 필터와 동일)
  let orderQuery = opts.supabase
    .from("orders")
    .select("id, marketplace, product_name, purchase_url, purchase_id, purchase_order_no, tracking_no, purchased_at, delivery_status, quantity, settlement, cost, memo, purchase_source, recipient_name, postal_code, address, address_detail, recipient_phone, delivery_memo, purchase_orders")
    .eq("user_id", opts.userId)
    .eq("delivery_status", "구매대기")
    .not("purchase_url", "is", null)
    .neq("purchase_url", "");
  if (opts.orderIds && opts.orderIds.length > 0) orderQuery = orderQuery.in("id", opts.orderIds);
  const { data: orderRows, error: orderErr } = await orderQuery;
  if (orderErr) throw new Error(`구매대기 주문 조회 실패: ${orderErr.message}`);

  let candidates = ((orderRows ?? []) as OrderRow[]).filter(
    (o) => (!o.purchase_order_no || o.purchase_order_no.trim() === "") && !o.tracking_no && !o.purchased_at && parsePurchaseOrders(o.purchase_orders).length === 0,
  );

  // 중복구매 방지 — 구매로그에 성공 기록이 이미 있는 주문은 제외 (use-orders 의 purchase_duplicate_level 판정과 동일 근거)
  if (candidates.length > 0) {
    const { data: dupLogs } = await opts.supabase
      .from("purchase_logs")
      .select("order_id")
      .eq("user_id", opts.userId)
      .in("order_id", candidates.map((o) => o.id))
      .eq("status", "success")
      .not("purchase_order_no", "is", null)
      .neq("purchase_order_no", "");
    const dupIds = new Set((dupLogs ?? []).map((r) => r.order_id as string));
    if (dupIds.size > 0) {
      candidates = candidates.filter((o) => !dupIds.has(o.id));
      result.errors.push(`중복구매 의심 ${dupIds.size}건 제외 (구매로그 성공 기록 존재 — 발주서에서 확인 필요)`);
    }
  }
  result.total = candidates.length;
  if (candidates.length === 0) { log("구매대기 대상 없음"); return result; }
  result.ran = true;

  // 3. 플랫폼 필터 (현재 지마켓만 지원)
  const gmarketOrders: OrderRow[] = [];
  for (const o of candidates) {
    if (detectPlatform(o.purchase_url)?.platform === "gmarket") gmarketOrders.push(o);
    else result.skipped.platform++;
  }
  log(`구매대기 ${candidates.length}건 중 지마켓 ${gmarketOrders.length}건 (타플랫폼 ${result.skipped.platform}건 스킵)`);

  const runId = await startSyncRun(opts.supabase, { userId: opts.userId, platform: "gmarket", kind: "auto-purchase", trigger: opts.trigger, dryRun: opts.dryRun });
  try {
    // 4. 상품소싱 매칭 (상품명 정규화 — 수동 원가갱신과 동일 규칙)
    //    products 가 1000개를 넘을 수 있어 페이지네이션으로 전부 가져온다 (supabase 기본 1000 제한)
    const productRows: ProductRow[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error: productErr } = await opts.supabase
        .from("products")
        .select("id, product_name, purchase_url, lowest_price")
        .eq("user_id", opts.userId)
        .gt("purchase_url", "")
        .neq("registration_status", "판매종료")
        .range(from, from + PAGE - 1);
      if (productErr) throw new Error(`상품소싱 조회 실패: ${productErr.message}`);
      if (!data || data.length === 0) break;
      productRows.push(...(data as ProductRow[]));
      if (data.length < PAGE) break;
    }

    const productMap = new Map<string, ProductRow>();
    for (const p of productRows) {
      if (!p.product_name) continue;
      const key = normalizeNameForMatch(p.product_name);
      const prev = productMap.get(key);
      if (!prev || (detectPlatform(prev.purchase_url) === null && detectPlatform(p.purchase_url) !== null)) productMap.set(key, p);
    }

    const groups = new Map<string, { product: ProductRow; orders: OrderRow[] }>();
    for (const o of gmarketOrders) {
      const product = o.product_name ? productMap.get(normalizeNameForMatch(o.product_name)) : undefined;
      if (!product || detectPlatform(product.purchase_url)?.platform !== "gmarket") { result.skipped.noProduct++; continue; }
      const g = groups.get(product.id) ?? { product, orders: [] };
      g.orders.push(o);
      groups.set(product.id, g);
    }
    if (groups.size === 0) {
      log(`상품 매칭 0건 (미매칭 ${result.skipped.noProduct}건) — 구매 없음`);
      await finishSyncRun(opts.supabase, runId, { status: "success", remote_count: candidates.length, confirmed: 0, detail: stageDetail(result) });
      await notifyStage(result, opts.trigger);
      return result;
    }

    // 5. 원가갱신 (products.lowest_price 는 4시간 주기 가격 자동화가 관리 — 여기서는 주문 판정만)
    log(`원가갱신: 주문 ${gmarketOrders.length - result.skipped.noProduct}건 → 상품 ${groups.size}개`);
    const prices = await refreshPrices(opts.baseUrl, opts.token, [...groups.keys()], log);

    // 6. 주문별 판정 + DB 반영 (수동 원가갱신 적용과 동일 의미: cost=단가×수량, 품절=발송불가)
    const toPurchase: OrderRow[] = [];
    for (const [productId, group] of groups) {
      const priceResult = prices.get(productId);
      for (const order of group.orders) {
        const qty = order.quantity || 1;
        const settlement = Number(order.settlement) || 0;
        if (!priceResult || priceResult.status === "failed") { result.skipped.priceFailed++; continue; }
        if (priceResult.status === "sold_out") {
          result.skipped.soldOut++;
          if (!opts.dryRun) {
            const patch: Record<string, unknown> = { cost: 0, delivery_status: "발송불가" };
            if (!order.memo) patch.memo = "품절 자동감지 (원가갱신)";
            const { error } = await opts.supabase.from("orders").update(patch).eq("id", order.id).eq("user_id", opts.userId).eq("delivery_status", "구매대기");
            if (error) result.errors.push(`품절 반영 실패(${order.id}): ${error.message}`);
          }
          continue;
        }
        const nextCost = priceResult.price * qty;
        if (!opts.dryRun) {
          // 원가가 이전과 같아도 구매처(purchase_source)는 세팅해야 한다 (수동 원가갱신과 동일)
          const patch: Record<string, unknown> = {};
          if (order.cost !== nextCost) patch.cost = nextCost;
          if (!order.purchase_source?.trim() && settlement - nextCost > 0) patch.purchase_source = "지마켓";
          if (Object.keys(patch).length > 0) {
            const { error } = await opts.supabase.from("orders").update(patch).eq("id", order.id).eq("user_id", opts.userId);
            if (error) { result.errors.push(`원가/구매처 반영 실패(${order.id}): ${error.message}`); continue; }
          }
        }
        if (settlement <= 0) { result.skipped.noSettlement++; continue; }
        if (nextCost > settlement) { result.skipped.deficit++; continue; }
        toPurchase.push({ ...order, cost: nextCost });
      }
    }
    log(`판정 완료: 구매 ${toPurchase.length} / 품절 ${result.skipped.soldOut} / 적자 ${result.skipped.deficit} / 정산없음 ${result.skipped.noSettlement} / 수집실패 ${result.skipped.priceFailed}`);

    if (toPurchase.length === 0) {
      await finishSyncRun(opts.supabase, runId, { status: result.errors.length > 0 ? "partial" : "success", remote_count: candidates.length, confirmed: 0, detail: stageDetail(result) });
      await notifyStage(result, opts.trigger);
      return result;
    }

    if (opts.dryRun) {
      result.wouldPurchase = toPurchase.map((o) => `${o.product_name ?? "?"} ×${o.quantity || 1} (원가 ${o.cost}원 / 정산 ${o.settlement}원)`);
      log(`[DRY] 구매 예정 ${toPurchase.length}건:\n  ${result.wouldPurchase.join("\n  ")}`);
      await finishSyncRun(opts.supabase, runId, { status: "success", remote_count: candidates.length, confirmed: 0, detail: stageDetail(result) });
      return result;
    }

    // 7. 계정 매칭 + purchase_id 배정
    if (!opts.paymentPin || opts.paymentPin.length !== 6) throw new Error("GMARKET_PAYMENT_PIN(6자리)이 .env.local 에 없습니다");
    const { data: cred, error: credErr } = await opts.supabase
      .from("purchase_credentials")
      .select("id, login_id")
      .eq("user_id", opts.userId)
      .eq("platform", "gmarket")
      .eq("login_id", gmarketAccount)
      .maybeSingle();
    if (credErr || !cred) throw new Error(`구매계정(${gmarketAccount})이 계정 관리에 없습니다${credErr ? `: ${credErr.message}` : ""}`);

    for (const o of toPurchase) {
      if (o.purchase_id?.trim() === gmarketAccount) continue;
      const { error } = await opts.supabase.from("orders").update({ purchase_id: gmarketAccount }).eq("id", o.id).eq("user_id", opts.userId);
      if (error) result.errors.push(`구매아이디 배정 실패(${o.id}): ${error.message}`);
    }

    // 8. 자동구매 호출 — 10건씩 청크 (route maxDuration 300s 대비)
    const CHUNK = 10;
    for (let i = 0; i < toPurchase.length; i += CHUNK) {
      const chunk = toPurchase.slice(i, i + CHUNK);
      const purchaseOrders: PurchaseOrderInfo[] = chunk.map((o) => ({
        orderId: o.id,
        productUrl: o.purchase_url!,
        recipientName: o.recipient_name || "",
        postalCode: o.postal_code || "",
        address: o.address || "",
        addressDetail: o.address_detail || "",
        recipientPhone: o.recipient_phone || "",
        deliveryMemo: o.delivery_memo || "",
        quantity: o.quantity || 1,
        productName: o.product_name || "",
        // maxPaymentPerUnit 은 보내지 않는다 — 서버가 정산예정÷수량으로 계산·주입 (allowedDeficit 0)
      }));
      log(`자동구매 호출 ${i + 1}~${i + chunk.length}/${toPurchase.length}건`);
      const res = await fetch(`${opts.baseUrl}/api/orders/auto-purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ credentialId: cred.id, paymentPin: opts.paymentPin, notify: false, allowedDeficit: 0, orders: purchaseOrders }),
      });
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        const reason = `자동구매 API 실패 (HTTP ${res.status}${err.error ? `: ${err.error}` : ""})`;
        result.purchaseFailed += chunk.length;
        for (const o of chunk) result.failedItems.push(toNotifyItem(o, { orderId: o.id, reason }));
        result.errors.push(reason);
        continue;
      }
      const chunkById = new Map(chunk.map((o) => [o.id, o]));
      const seen = new Set<string>();
      const stream = { error: null as string | null };
      await readSseEvents(res, (e) => {
        if (e.type === "done" || e.type === "cancelled") {
          const success = (e.success as PurchaseOutcome[] | undefined) ?? [];
          const failed = (e.failed as PurchaseOutcome[] | undefined) ?? [];
          for (const s of success) {
            const o = chunkById.get(s.orderId);
            if (!o || seen.has(s.orderId)) continue;
            seen.add(s.orderId);
            result.purchased++;
            result.purchasedItems.push(toNotifyItem(o, s));
          }
          for (const f of failed) {
            const o = chunkById.get(f.orderId);
            if (!o || seen.has(f.orderId)) continue;
            seen.add(f.orderId);
            result.purchaseFailed++;
            result.failedItems.push(toNotifyItem(o, f));
          }
        } else if (e.type === "error") {
          stream.error = `자동구매 오류: ${String(e.message)}`;
          result.errors.push(stream.error);
        }
      });
      // done 이벤트 없이 끝난 주문(서버 오류·연결 끊김)도 사유와 함께 실패로 남긴다
      for (const o of chunk) {
        if (seen.has(o.id)) continue;
        result.purchaseFailed++;
        result.failedItems.push(toNotifyItem(o, { orderId: o.id, reason: stream.error ?? "결과 미수신 (서버 응답 없음)" }));
      }
    }
    log(`자동구매 완료: 성공 ${result.purchased} / 실패 ${result.purchaseFailed}`);

    const status = result.purchaseFailed > 0 || result.errors.length > 0 ? (result.purchased > 0 ? "partial" : "failed") : "success";
    await finishSyncRun(opts.supabase, runId, { status, remote_count: candidates.length, confirmed: result.purchased, detail: stageDetail(result) });
    await notifyStage(result, opts.trigger);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(msg);
    await finishSyncRun(opts.supabase, runId, { status: "failed", error: msg, detail: stageDetail(result) });
    await notifyStage(result, opts.trigger);
    throw e;
  }
}

/** 자동구매 API done 이벤트의 success/failed 항목 */
interface PurchaseOutcome {
  orderId: string;
  purchaseOrderNo?: string;
  cost?: number;
  paymentMethod?: string;
  units?: PurchasedUnit[];
  reason?: string;
}

function toNotifyItem(o: OrderRow, outcome: PurchaseOutcome): PurchaseNotifyItem {
  return {
    marketplace: o.marketplace,
    recipientName: o.recipient_name,
    productName: o.product_name,
    quantity: o.quantity ?? 1,
    settlement: o.settlement,
    cost: outcome.cost,
    paymentMethod: outcome.paymentMethod,
    units: outcome.units,
    purchaseOrderNo: outcome.purchaseOrderNo,
    reason: outcome.reason,
  };
}

function stageDetail(r: AutoPurchaseStageResult): Record<string, unknown> {
  return {
    total: r.total, purchased: r.purchased, purchaseFailed: r.purchaseFailed, skipped: r.skipped, errors: r.errors.slice(0, 20), wouldPurchase: r.wouldPurchase.slice(0, 50),
    purchasedItems: r.purchasedItems.slice(0, 50), failedItems: r.failedItems.slice(0, 50),
  };
}

async function notifyStage(r: AutoPurchaseStageResult, trigger: "scheduler" | "manual"): Promise<void> {
  // 아무 일도 없었던 시간대(대상 0)는 디스코드를 조용히 둔다
  if (r.total === 0 && r.errors.length === 0) return;
  const skippedTotal = Object.values(r.skipped).reduce((a, b) => a + b, 0);
  if (r.purchased === 0 && r.purchaseFailed === 0 && skippedTotal === 0 && r.errors.length === 0) return;
  // 건별 실패 사유는 failedItems 에 이미 있으므로 errors 에서 중복 제거 — 건별로 못 묶는 오류만 남긴다
  await notifyAutomationResult(buildPurchaseNotification({
    trigger,
    dryRun: r.dryRun,
    success: r.purchasedItems,
    failed: r.failedItems,
    skipped: [
      { label: "품절", count: r.skipped.soldOut },
      { label: "적자", count: r.skipped.deficit },
      { label: "정산없음", count: r.skipped.noSettlement },
      { label: "타플랫폼", count: r.skipped.platform },
      { label: "상품 미매칭", count: r.skipped.noProduct },
      { label: "가격수집 실패", count: r.skipped.priceFailed },
    ],
    errors: r.errors,
  }));
}
