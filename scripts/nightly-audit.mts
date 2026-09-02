// 야간 총점검 — 매일 23:00 발주서·상품·가격·자동화 상태를 점검해 디스코드(총점검-자동화)로 보고
//
//   npx tsx scripts/nightly-audit.mts [--dry]
//
// - 12개 점검 항목 + 오늘 장부(매출·카드사별 카드값·마진) + 이번달 누적 + 현황 스냅샷
// - --dry 면 디스코드 전송 없이 콘솔 출력만
// - 마켓 API 는 6번(수집 누락 검증)만 읽기 호출, 나머지는 DB 조회
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { backfillMarketplaceNumbers, type SyncPlatform } from "@/lib/marketplace/order-sync";
import { computeCoupangTargetPrice, computeSmartstoreTargetPrice } from "@/lib/marketplace-api-helpers";
import { buildRateMap } from "@/lib/product-calculations";
import { toKstDateKey } from "@/lib/date-utils";
import type { CommissionRate, Product } from "@/types/database";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");

const envText = fs.readFileSync(".env.local", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k];

const logDir = path.resolve("logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "nightly-audit.log");
const log = (msg: string) => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); fs.appendFileSync(logFile, line + "\n"); };
const STATE_FILE = path.join(logDir, "nightly-audit-state.json");

const userId = env.SYNC_USER_ID;
if (!userId) { log("SYNC_USER_ID 없음"); process.exit(1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const todayKey = toKstDateKey();
const monthKey = todayKey.slice(0, 7);
const monthStartUtc = new Date(`${monthKey}-01T00:00:00+09:00`).toISOString();
const tomorrowKey = toKstDateKey(Date.now() + 86400000);
const sinceUtc = new Date(Math.min(new Date(monthStartUtc).getTime(), Date.now() - 35 * 86400000)).toISOString();

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

interface OrderRow {
  id: string; order_date: string | null; delivery_status: string; revenue: number | null; margin: number | null;
  recipient_name: string | null; product_name: string | null; quantity: number | null;
  purchase_source: string | null; purchase_order_no: string | null; purchased_at: string | null;
  tracking_no: string | null; ship_by_date: string | null; canceled_at: string | null; returned_at: string | null;
  updated_at: string | null; purchase_return_requested_at: string | null;
}

async function main() {
  log(`=== 야간 총점검 시작 (${todayKey}) ===`);

  // ── 데이터 로드 ──
  const orders = await pageAll<OrderRow>((from, to) => sb.from("orders")
    .select("id,order_date,delivery_status,revenue,margin,recipient_name,product_name,quantity,purchase_source,purchase_order_no,purchased_at,tracking_no,ship_by_date,canceled_at,returned_at,updated_at,purchase_return_requested_at")
    .eq("user_id", userId).gte("order_date", sinceUtc).order("id").range(from, to));
  const purchases = await pageAll<{ order_id: string | null; purchase_order_no: string | null; cost: number | null; payment_method: string | null; created_at: string }>(
    (from, to) => sb.from("purchase_logs").select("order_id,purchase_order_no,cost,payment_method,created_at")
      .eq("user_id", userId).eq("status", "success").gte("created_at", monthStartUtc).order("id").range(from, to));
  const products = await pageAll<Product>((from, to) => sb.from("products").select("*").eq("user_id", userId).order("id").range(from, to));
  const { data: ratesData } = await sb.from("commission_rates").select("*").eq("user_id", userId);
  const rateMap = buildRateMap((ratesData ?? []) as CommissionRate[]);
  const productMap = new Map(products.map((p) => [p.id, p]));
  type Inv = { product_id: string | null; sale_price: number | null };
  const cpInv = await pageAll<Inv>((from, to) => sb.from("coupang_price_inventory").select("product_id,sale_price")
    .eq("user_id", userId).eq("sale_status", "판매중").order("id").range(from, to));
  const ssInv = await pageAll<Inv>((from, to) => sb.from("smartstore_price_inventory").select("product_id,sale_price")
    .eq("user_id", userId).eq("product_status", "SALE").order("id").range(from, to));

  // ── 오늘 장부 / 이번달 누적 ──
  const kstOf = (iso: string | null) => (iso ? toKstDateKey(new Date(iso).getTime()) : "");
  const isCancelled = (o: OrderRow) => ["취소완료", "반품완료"].includes(o.delivery_status);
  const todayOrders = orders.filter((o) => kstOf(o.order_date) === todayKey && !isCancelled(o));
  const monthOrders = orders.filter((o) => kstOf(o.order_date) >= `${monthKey}-01` && !isCancelled(o));
  const sum = (rows: OrderRow[], f: (o: OrderRow) => number | null) => rows.reduce((a, o) => a + (f(o) ?? 0), 0);
  const todayRevenue = sum(todayOrders, (o) => o.revenue);
  const todayMargin = sum(todayOrders, (o) => o.margin);
  const monthRevenue = sum(monthOrders, (o) => o.revenue);
  const monthMargin = sum(monthOrders, (o) => o.margin);
  const todayCancelled = orders.filter((o) => isCancelled(o) && (kstOf(o.canceled_at) === todayKey || kstOf(o.returned_at) === todayKey));
  const todayCancelledRevenue = sum(todayCancelled, (o) => o.revenue);
  const todayPurchases = purchases.filter((p) => kstOf(p.created_at) === todayKey);
  const cardTotals = new Map<string, { amount: number; count: number }>();
  for (const p of todayPurchases) {
    const key = p.payment_method?.trim() || "기타";
    const cur = cardTotals.get(key) ?? { amount: 0, count: 0 };
    cur.amount += p.cost ?? 0; cur.count += 1;
    cardTotals.set(key, cur);
  }
  const todayPurchaseTotal = [...cardTotals.values()].reduce((a, c) => a + c.amount, 0);
  const pct = (m: number, r: number) => (r > 0 ? ` (마진율 ${((m / r) * 100).toFixed(1)}%)` : "");

  // ── 현황 스냅샷 ──
  const countBy = (s: string[]) => orders.filter((o) => s.includes(o.delivery_status)).length;
  const csStatuses = ["취소요청", "반품준비", "반품접수", "교환준비"];
  const { count: unansweredInquiries } = await sb.from("marketplace_inquiries")
    .select("id", { count: "exact", head: true }).eq("user_id", userId).neq("status", "answered");

  // ── 점검 항목 ──
  type Check = { label: string; items: string[]; severe?: boolean };
  const checks: Check[] = [];
  const push = (label: string, items: string[], severe = false) => checks.push({ label, items, severe });
  const detail = (items: string[], cap = 3) => items.slice(0, cap).map((s) => `　· ${s}`).concat(items.length > cap ? [`　· 외 ${items.length - cap}건`] : []);
  const numericNo = (no: string | null) => !!no && /^\d+$/.test(no.trim());

  // 1. 중복구매 의심 — 한 발주 행에 성공 구매가 수량보다 많음 (최근 3일)
  {
    const cut = Date.now() - 3 * 86400000;
    const byOrder = new Map<string, Set<string>>();
    for (const p of purchases) {
      if (!p.order_id || !p.purchase_order_no || new Date(p.created_at).getTime() < cut) continue;
      (byOrder.get(p.order_id) ?? byOrder.set(p.order_id, new Set()).get(p.order_id)!).add(p.purchase_order_no);
    }
    const items: string[] = [];
    for (const [orderId, nos] of byOrder) {
      const o = orders.find((x) => x.id === orderId);
      if (o && nos.size > Math.max(o.quantity ?? 1, 1)) items.push(`${o.recipient_name} · ${o.product_name} (구매 ${nos.size}건 > 수량 ${o.quantity})`);
    }
    push("중복구매 의심(최근 3일)", items, true);
  }

  // 2. 취소·반품됐는데 구매처 반품신청이 없는 건 (최근 3일 취소분)
  {
    const cut = Date.now() - 3 * 86400000;
    const items = orders
      .filter((o) => isCancelled(o) && o.purchased_at && !o.purchase_return_requested_at
        && (o.canceled_at || o.returned_at) && new Date(o.canceled_at ?? o.returned_at!).getTime() >= cut)
      .map((o) => `${o.recipient_name} · ${o.product_name}`);
    push("취소·반품인데 구매 반품신청 안 된 건", items, true);
  }

  // 3. 역마진 판매중 — 마켓 판매가의 정산액이 원가보다 낮음
  {
    const items: string[] = [];
    const scan = (rows: Inv[], platform: "coupang" | "smartstore", label: string) => {
      for (const r of rows) {
        const p = r.product_id ? productMap.get(r.product_id) : undefined;
        if (!p || !r.sale_price || p.lowest_price <= 0) continue;
        const rate = rateMap[p.category]?.[platform] ?? 0;
        if (rate <= 0 || rate >= 100) continue;
        const settle = r.sale_price * (1 - rate / 100);
        if (settle < p.lowest_price) items.push(`[${label}] ${p.product_name} (정산 ${won(settle)} < 원가 ${won(p.lowest_price)})`);
      }
    };
    scan(cpInv, "coupang", "쿠팡");
    scan(ssInv, "smartstore", "스토어");
    push("역마진 판매중", items, true);
  }

  // 4. 원가 이상치 — 판매종료 아닌데 원가 0 이하
  push("원가 이상치(0원 이하)",
    products.filter((p) => p.registration_status !== "판매종료" && p.lowest_price <= 0).map((p) => p.product_name), true);

  // 5. 미구매 + 발송기한 임박
  push("미구매 + 발송기한 임박(≤내일)",
    orders.filter((o) => o.delivery_status === "구매대기" && o.ship_by_date && o.ship_by_date <= tomorrowKey)
      .map((o) => `${o.recipient_name} · ${o.product_name} (기한 ${o.ship_by_date})`), true);

  // 6. 마켓 주문 수집 누락 — 마켓 API 재조회 대조 (링크 백필 겸용)
  {
    const items: string[] = [];
    const { data: creds } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", userId).in("platform", ["coupang", "smartstore"]);
    for (const platform of ["coupang", "smartstore"] as SyncPlatform[]) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) continue;
      try {
        const clients = platform === "coupang"
          ? { coupang: new CoupangOpenApiClient({ vendorId: cred.account_id, accessKey: decrypt(cred.access_key_encrypted), secretKey: decrypt(cred.secret_key_encrypted) }) }
          : { smartstore: new NaverCommerceApiClient({ clientId: decrypt(cred.client_id_encrypted), clientSecret: decrypt(cred.client_secret_encrypted) }) };
        const r = await backfillMarketplaceNumbers({ supabase: sb, userId, platform, credentialId: cred.id, days: 3, ...clients });
        if (r.notFound > 0) items.push(`${platform === "coupang" ? "쿠팡" : "스토어"} ${r.notFound}건 (마켓엔 있는데 발주서에 없음)`);
        if (r.errors.length > 0) items.push(`${platform} 대조 오류: ${r.errors[0]}`);
      } catch (e) { items.push(`${platform} 대조 실패: ${e instanceof Error ? e.message : String(e)}`); }
    }
    push("마켓 주문 수집 누락(최근 3일 대조)", items, true);
  }

  // 7. 운송장 48시간+ 미수집
  {
    const cut = Date.now() - 48 * 3600000;
    const excluded = ["취소완료", "발송불가", "반품준비", "반품접수", "반품완료", "교환준비", "교환완료", "취소요청"];
    push("운송장 48시간+ 미수집",
      orders.filter((o) => o.purchased_at && new Date(o.purchased_at).getTime() < cut && !o.tracking_no
        && !excluded.includes(o.delivery_status) && numericNo(o.purchase_order_no))
        .map((o) => `${o.recipient_name} · ${o.product_name} (구매 ${kstOf(o.purchased_at)})`));
  }

  // 8. 클레임 24시간+ 방치
  {
    const cut = Date.now() - 24 * 3600000;
    push("클레임 24시간+ 방치",
      orders.filter((o) => csStatuses.includes(o.delivery_status) && o.updated_at && new Date(o.updated_at).getTime() < cut)
        .map((o) => `${o.recipient_name} · ${o.product_name} (${o.delivery_status})`));
  }

  // 9. 구매처·주문번호 오타
  {
    const known = new Set(["지마켓", "옥션", "오늘의집", "11번가", "롯데온", "SSG", "ssg", "GSSHOP", "신세계쇼핑", "네이버쇼핑", "네이버", "쿠팡"]);
    const items = orders
      .filter((o) => (o.purchase_source && !known.has(o.purchase_source))
        || (o.purchase_order_no && o.purchase_order_no !== "직접결제" && !numericNo(o.purchase_order_no)))
      .map((o) => `${o.recipient_name} · ${o.product_name} (구매처 "${o.purchase_source}" / 번호 "${o.purchase_order_no}")`);
    push("구매처·주문번호 오타", items);
  }

  // 10. 가격 검산 잔여 — 기준가≠마켓가 (검산이 4시간마다 돌아도 안 풀린 건)
  {
    const items: string[] = [];
    const scan = (rows: Inv[], compute: (p: Product) => number | null, label: string) => {
      const ids = new Set<string>();
      for (const r of rows) {
        const p = r.product_id ? productMap.get(r.product_id) : undefined;
        if (!p || p.registration_status === "판매종료" || ids.has(p.id)) continue;
        const target = compute(p);
        if (target != null && target > 0 && r.sale_price !== target) { ids.add(p.id); items.push(`[${label}] ${p.product_name} (기준 ${won(target)} ≠ 마켓 ${won(r.sale_price ?? 0)})`); }
      }
    };
    scan(cpInv, (p) => computeCoupangTargetPrice(p, rateMap), "쿠팡");
    scan(ssInv, (p) => computeSmartstoreTargetPrice(p, rateMap), "스토어");
    push("가격 검산 잔여(기준가≠마켓가)", items);
  }

  // 11. 마켓 상태 이상 변화 — 스토어 미승인·판매금지 증감
  {
    const { count: unadmission } = await sb.from("smartstore_price_inventory").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("product_status", "UNADMISSION");
    const { count: prohibition } = await sb.from("smartstore_price_inventory").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("product_status", "PROHIBITION");
    let prev: { unadmission?: number; prohibition?: number } = {};
    try { prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* 첫 실행 */ }
    const items: string[] = [];
    if ((unadmission ?? 0) !== (prev.unadmission ?? unadmission ?? 0)) items.push(`스토어 미승인 ${prev.unadmission}→${unadmission}건`);
    if ((prohibition ?? 0) !== (prev.prohibition ?? prohibition ?? 0)) items.push(`스토어 판매금지 ${prev.prohibition}→${prohibition}건`);
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ unadmission, prohibition }), "utf8"); } catch { /* 무시 */ }
    push(`마켓 상태 변화(미승인 ${unadmission} · 금지 ${prohibition})`, items);
  }

  // 12. 크론 실행 확인 — 오늘 자동화가 제대로 돌았는지
  let cronLine = "";
  {
    const todayStartUtc = new Date(`${todayKey}T00:00:00+09:00`).toISOString();
    const { data: runs } = await sb.from("marketplace_sync_runs").select("kind,status").eq("user_id", userId).gte("started_at", todayStartUtc).limit(2000);
    const byKind = new Map<string, { total: number; failed: number }>();
    for (const r of (runs ?? []) as Array<{ kind: string | null; status: string | null }>) {
      const k = r.kind ?? "?";
      const cur = byKind.get(k) ?? { total: 0, failed: 0 };
      cur.total += 1; if (r.status === "failed") cur.failed += 1;
      byKind.set(k, cur);
    }
    const cnt = (k: string) => byKind.get(k)?.total ?? 0;
    const failedTotal = [...byKind.values()].reduce((a, c) => a + c.failed, 0);
    cronLine = `주문수집 ${cnt("orders")}회 · 운송장 ${cnt("shipping") + cnt("tracking")}회 · 가격 ${cnt("price")}회${failedTotal ? ` · 실패 ${failedTotal}회` : ""}`;
    const items: string[] = [];
    // 기대 횟수는 오늘 경과 시간에 비례 (23시 정규 실행이면 주문수집 ~23회·가격 ~6회, 수동 조기 실행 시 오탐 방지)
    const hoursElapsed = (Date.now() - new Date(`${todayKey}T00:00:00+09:00`).getTime()) / 3600000;
    const expectedOrders = Math.max(Math.floor(hoursElapsed) - 2, 0);
    const expectedPrice = Math.max(Math.floor((hoursElapsed - 0.25) / 4), 0);
    if (cnt("orders") < expectedOrders) items.push(`주문수집 ${cnt("orders")}회 (기대 ${expectedOrders}회+)`);
    if (cnt("price") < expectedPrice) items.push(`가격갱신 ${cnt("price")}회 (기대 ${expectedPrice}회+)`);
    if (failedTotal > 0) items.push(`실패 ${failedTotal}회 — 자동화 페이지 타임라인 확인`);
    push("크론 실행 확인", items);
  }

  // ── 보고 조립 ──
  const problems = checks.filter((c) => c.items.length > 0);
  const severeCount = problems.filter((c) => c.severe).length;
  const [, mm, dd] = todayKey.split("-");
  const lines: string[] = [];
  lines.push(`**야간 총점검 보고 — ${Number(mm)}월 ${Number(dd)}일**`);
  lines.push("");
  lines.push(problems.length === 0
    ? `${checks.length}개 항목 점검 결과: **모두 이상 없음**`
    : `${checks.length}개 항목 중 **${problems.length}개 주의**${severeCount ? ` (돈 위험 ${severeCount}개)` : ""}`);
  lines.push("");
  lines.push("**[ 오늘 장부 ]**");
  lines.push(`매출: ${won(todayRevenue)} (주문 ${todayOrders.length}건)`);
  lines.push(`구매(카드값): 총 ${won(todayPurchaseTotal)}`);
  for (const [method, v] of [...cardTotals.entries()].sort((a, b) => b[1].amount - a[1].amount)) lines.push(`　· ${method} ${won(v.amount)} (${v.count}건)`);
  lines.push(`예상 마진: ${won(todayMargin)}${pct(todayMargin, todayRevenue)}`);
  lines.push(todayCancelled.length > 0 ? `취소·반품 차감: -${won(todayCancelledRevenue)} (${todayCancelled.length}건)` : "취소·반품 차감: 없음");
  lines.push("");
  lines.push("**[ 이번달 누적 ]**");
  lines.push(`매출: ${won(monthRevenue)} (주문 ${monthOrders.length}건) · 마진: ${won(monthMargin)}${pct(monthMargin, monthRevenue)}`);
  lines.push("");
  lines.push("**[ 현재 현황 ]**");
  lines.push(`배송준비 ${countBy(["배송준비"])} · 구매대기 ${countBy(["구매대기"])} · 발송불가 ${countBy(["발송불가"])} · CS진행중 ${countBy(csStatuses)} · 문의 미답변 ${unansweredInquiries ?? 0}`);
  lines.push("");
  const sections: Array<[string, number, number]> = [["[ 돈 위험 ]", 0, 5], ["[ 발주서 ]", 5, 9], ["[ 상품·시스템 ]", 9, 12]];
  let no = 0;
  for (const [title, from, to] of sections) {
    lines.push(`**${title}**`);
    for (const c of checks.slice(from, to)) {
      no += 1;
      if (c.label.startsWith("크론 실행 확인")) lines.push(`${no}. ${c.label} — ${c.items.length === 0 ? `정상 (${cronLine})` : `**주의**`}`);
      else lines.push(`${no}. ${c.label} — ${c.items.length === 0 ? "없음" : `**${c.items.length}건**`}`);
      if (c.items.length > 0) lines.push(...detail(c.items));
    }
    lines.push("");
  }
  const report = lines.join("\n").trimEnd();
  log(`점검 완료: 주의 ${problems.length}개 / ${checks.length}개`);

  // ── 전송 (2000자 제한 — 섹션 단위 분할) ──
  if (DRY) { console.log("\n" + report); return; }
  const url = env.DISCORD_WEBHOOK_AUDIT || env.DISCORD_WEBHOOK_URL;
  if (!url) { log("DISCORD_WEBHOOK_AUDIT 없음 — 전송 생략"); console.log("\n" + report); return; }
  const chunks: string[] = [];
  let buf = "";
  for (const line of report.split("\n")) {
    if (buf.length + line.length + 1 > 1900) { chunks.push(buf); buf = ""; }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) chunks.push(buf);
  for (const chunk of chunks) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: chunk }) });
    if (!res.ok) log(`디스코드 전송 실패 (${res.status})`);
    await new Promise((r) => setTimeout(r, 400));
  }
  log("디스코드 전송 완료");
}

main().catch((e) => { log(`치명적 오류: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
