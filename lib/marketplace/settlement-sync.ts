// 정산 동기화 — 마켓 실정산액으로 발주서 settlement 갱신
//
//  쿠팡: revenue-history (구매확정/배송완료+7일 기준 매출 인식, 최대 31일 구간) → orderId + vendorItemId 매칭
//        SALE 은 settlementAmount 합산, REFUND 는 차감 → settlement_actual
//  스토어: pay-settle/settle/case (정산 기준일 기준, 일 단위) → productOrderId 매칭, PROD_ORDER 의 settleExpectAmount
//  둘 다 settlement 를 같은 값으로 덮어써 margin(generated) 이 따라가게 한다. settlement_source='api'

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoupangOpenApiClient } from "@/lib/coupang-api";
import type { NaverCommerceApiClient, NaverSettleCase } from "@/lib/naver-commerce-api";
import { logMarketplaceApi, sleep } from "@/lib/marketplace/common";
import { toKstDateKey } from "@/lib/date-utils";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

const MARKET_LABEL: Record<SyncPlatform, string> = { coupang: "쿠팡", smartstore: "스마트스토어" };
const ymd = toKstDateKey; // 정산·매출 조회 날짜는 마켓(KST) 기준

export interface SettlementResult {
  platform: SyncPlatform;
  from: string;
  to: string;
  remoteRows: number;
  matched: number;
  updated: number;
  unchanged: number;
  unmatched: number;
  errors: string[];
  runId: string | null;
  samples: Array<{ recipientName: string | null; productName: string | null; before: number; after: number }>;
}

export interface SettlementOptions {
  supabase: AnySupabase;
  userId: string;
  platform: SyncPlatform;
  credentialId: string | null;
  /** 조회 기간(일). 기본 35 */
  days?: number;
  trigger?: "manual" | "scheduler";
  coupang?: CoupangOpenApiClient;
  smartstore?: NaverCommerceApiClient;
}

interface OrderRow {
  id: string;
  recipient_name: string | null;
  product_name: string | null;
  settlement: number;
  settlement_source: string | null;
  marketplace_order_no: string | null;
  marketplace_product_order_no: string | null;
}

export async function syncSettlements(opts: SettlementOptions): Promise<SettlementResult> {
  const { supabase, userId, platform } = opts;
  const days = Math.min(Math.max(opts.days ?? 35, 1), 120);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const result: SettlementResult = { platform, from: ymd(from), to: ymd(to), remoteRows: 0, matched: 0, updated: 0, unchanged: 0, unmatched: 0, errors: [], runId: null, samples: [] };

  const { data: run } = await supabase
    .from("marketplace_sync_runs")
    .insert({ user_id: userId, platform, kind: "settlement", trigger: opts.trigger ?? "manual", dry_run: false })
    .select("id")
    .single();
  result.runId = (run as { id: string } | null)?.id ?? null;

  try {
    // 발주서: 마켓 번호 있는 행 (최근 days+60일)
    const since = new Date(from.getTime() - 60 * 86400000).toISOString();
    const rows: OrderRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("orders")
        .select("id,recipient_name,product_name,settlement,settlement_source,marketplace_order_no,marketplace_product_order_no")
        .eq("user_id", userId)
        .ilike("marketplace", `%${MARKET_LABEL[platform]}%`)
        .not("marketplace_product_order_no", "is", null)
        .gte("order_date", since)
        .range(off, off + 999);
      if (error) throw new Error(`발주서 조회 실패: ${error.message}`);
      rows.push(...((data ?? []) as OrderRow[]));
      if (!data || data.length < 1000) break;
    }

    // 마켓별 정산액 집계: key → amount
    const amounts = new Map<string, { amount: number; date: string | null }>();
    if (platform === "coupang") await collectCoupang(opts.coupang!, from, to, amounts, result);
    else await collectNaver(opts.smartstore!, from, to, amounts, result);
    result.remoteRows = amounts.size;

    const byKey = new Map<string, OrderRow[]>();
    for (const r of rows) {
      const key = platform === "coupang" ? `${r.marketplace_order_no}|${(r.marketplace_product_order_no ?? "").split("-")[1] ?? ""}` : r.marketplace_product_order_no ?? "";
      byKey.set(key, [...(byKey.get(key) ?? []), r]);
    }
    for (const [key, v] of amounts) {
      const targets = byKey.get(key);
      if (!targets || targets.length === 0) { result.unmatched++; continue; }
      // 같은 키에 발주서가 여러 행이면(쿠팡 동일 옵션 여러 박스) 첫 행에만 반영
      const o = targets[0];
      result.matched++;
      const after = Math.round(v.amount);
      if (o.settlement_source === "api" && Math.round(o.settlement) === after) { result.unchanged++; continue; }
      const { error } = await supabase.from("orders").update({ settlement: after, settlement_actual: after, settlement_source: "api", settlement_confirmed_at: v.date }).eq("id", o.id).eq("user_id", userId);
      if (error) { result.errors.push(`갱신 실패(${o.id}): ${error.message}`); continue; }
      result.updated++;
      if (result.samples.length < 20) result.samples.push({ recipientName: o.recipient_name, productName: o.product_name, before: o.settlement, after });
    }
    await logMarketplaceApi(supabase, {
      user_id: userId, platform, credential_id: opts.credentialId, action: "settlement", status: result.errors.length > 0 ? "failed" : "success",
      new_value: `기간 ${result.from}~${result.to} · 정산행 ${result.remoteRows} · 매칭 ${result.matched} · 갱신 ${result.updated}`, error_message: result.errors[0] ?? null,
    });
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  if (result.runId) {
    await supabase.from("marketplace_sync_runs").update({
      finished_at: new Date().toISOString(),
      status: result.errors.length > 0 ? (result.updated > 0 ? "partial" : "failed") : "success",
      remote_count: result.remoteRows,
      confirmed: result.updated,
      confirm_failed: result.errors.length,
      error: result.errors[0] ?? null,
      detail: { from: result.from, to: result.to, matched: result.matched, unchanged: result.unchanged, unmatched: result.unmatched, samples: result.samples },
    }).eq("id", result.runId);
  }
  return result;
}

async function collectCoupang(client: CoupangOpenApiClient, from: Date, toIn: Date, amounts: Map<string, { amount: number; date: string | null }>, result: SettlementResult) {
  // 쿠팡은 종료일이 어제 이하여야 한다. 31일 단위로 나눠 조회
  const to = new Date(Math.min(toIn.getTime(), Date.now() - 86400000));
  // 쿠팡: "1개월 미만" 만 허용 → 28일 단위
  for (let start = new Date(from); start < to; start = new Date(start.getTime() + 28 * 86400000)) {
    const end = new Date(Math.min(start.getTime() + 27 * 86400000, to.getTime()));
    let token: string | undefined;
    for (let page = 0; page < 400; page++) {
      const res = await client.listRevenueHistory({ recognitionDateFrom: ymd(start), recognitionDateTo: ymd(end), token, maxPerPage: 50 });
      if (!res.ok || !res.body || typeof res.body === "string") { result.errors.push(`쿠팡 매출내역 조회 실패(${ymd(start)}~${ymd(end)}): ${res.message}`); break; }
      const body = res.body;
      for (const order of body.data ?? []) {
        const sign = String(order.saleType).toUpperCase() === "REFUND" ? -1 : 1;
        for (const it of order.items ?? []) {
          const key = `${order.orderId}|${it.vendorItemId}`;
          const cur = amounts.get(key) ?? { amount: 0, date: null };
          cur.amount += sign * Number(it.settlementAmount ?? 0);
          cur.date = order.settlementDate ?? order.recognitionDate ?? cur.date;
          amounts.set(key, cur);
        }
      }
      token = body.nextToken || undefined;
      await sleep(250);
      if (!token) break;
    }
  }
}

async function collectNaver(client: NaverCommerceApiClient, from: Date, to: Date, amounts: Map<string, { amount: number; date: string | null }>, result: SettlementResult) {
  // 정산 기준일 기준 하루씩 (searchDate 단일 일자)
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400000)) {
    for (let page = 1; page < 50; page++) {
      const res = await client.getSettleByCase({ searchDate: ymd(d), periodType: "SETTLE_CASEBYCASE_SETTLE_BASIS_DATE", pageNumber: page, pageSize: 1000 });
      if (!res.ok || !res.body || typeof res.body === "string") { result.errors.push(`스토어 정산 조회 실패(${ymd(d)}): ${res.message}`); break; }
      const els: NaverSettleCase[] = res.body.elements ?? [];
      for (const e of els) {
        if (e.productOrderType !== "PROD_ORDER" || !e.productOrderId) continue;
        const cur = amounts.get(e.productOrderId) ?? { amount: 0, date: null };
        cur.amount += Number(e.settleExpectAmount ?? 0);
        cur.date = e.settleExpectDate ?? e.settleBasisDate ?? cur.date;
        amounts.set(e.productOrderId, cur);
      }
      await sleep(500);
      const pg = res.body.pagination;
      if (!pg || page >= (pg.totalPages ?? 1)) break;
    }
  }
}
