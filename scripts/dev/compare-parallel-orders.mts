// 병행 검증: 마켓 API 원본 주문 vs 발주서(orders) 대조
//   npx tsx scripts/dev/compare-parallel-orders.mts [--days 2]
//   - 마켓에는 있는데 발주서에 없는 주문(누락), 발주서에 마켓번호 없는 행(백필 실패),
//     같은 주문이 두 행으로 들어간 중복(플토+API 이중 등록)을 찾는다.
//   수집·퍼지키는 order-sync 의 것을 그대로 재사용한다 — 대조 도구가 조회 범위나
//   정규화 규칙을 따로 구현하면 본체와 어긋나는 순간 오탐을 생산한다.
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { fetchCoupangSheets, searchNaverOrdersByPaidDate, fuzzyKey, isActiveCoupangItem } from "@/lib/marketplace/order-sync";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const days = Number(opt("days", "2"));
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k];
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = env.SYNC_USER_ID;

const MARKETS = ["쿠팡", "스마트스토어"] as const;
type Market = (typeof MARKETS)[number];
interface RemoteItem { key: string; recipient: string; product: string; qty: number; status: string; paidAt: string | null }

const { data: creds } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", userId);
if (!creds?.length) { console.error("API 계정 없음"); process.exit(1); }

// ── 마켓 원본 조회 (마켓 간 병렬 — 서로 다른 서비스라 rate limit 은 독립) ──
const remote: Record<Market, RemoteItem[]> = { 쿠팡: [], 스마트스토어: [] };
const errors: string[] = [];

const coupangTask = (async () => {
  const cc = creds.find((c) => c.platform === "coupang");
  if (!cc) return;
  const client = new CoupangOpenApiClient({ vendorId: cc.account_id, accessKey: decrypt(cc.access_key_encrypted), secretKey: decrypt(cc.secret_key_encrypted) });
  // sync 는 ACCEPT/INSTRUCT 만 수집하지만, 대조는 이미 배송 단계로 넘어간 건도 발주서에 있어야 하므로 전 상태를 본다
  const sheets = await fetchCoupangSheets(client, days, ["ACCEPT", "INSTRUCT", "DEPARTURE", "DELIVERING", "FINAL_DELIVERY"]);
  for (const sheet of sheets) {
    for (const it of sheet.orderItems ?? []) {
      if (!isActiveCoupangItem(it)) continue;
      remote.쿠팡.push({ key: `${sheet.shipmentBoxId}-${it.vendorItemId}`, recipient: sheet.receiver?.name ?? "", product: it.sellerProductName || it.vendorItemName || "", qty: it.shippingCount ?? 0, status: String(sheet.status ?? ""), paidAt: sheet.paidAt ?? sheet.orderedAt ?? null });
    }
  }
})();

const naverTask = (async () => {
  const nc = creds.find((c) => c.platform === "smartstore");
  if (!nc) return;
  const client = new NaverCommerceApiClient({ clientId: decrypt(nc.client_id_encrypted), clientSecret: decrypt(nc.client_secret_encrypted) });
  const details = await searchNaverOrdersByPaidDate(client, days, errors);
  for (const d of details) {
    const po = d.productOrder;
    if (!po || (po.quantity ?? 0) <= 0) continue;
    if (/^CANCEL/.test(po.productOrderStatus ?? "")) continue; // 취소 완료 건 제외
    remote.스마트스토어.push({ key: po.productOrderId, recipient: d.order?.ordererName ?? po.shippingAddress?.name ?? "", product: [po.productName, po.productOption].filter(Boolean).join(" "), qty: po.quantity ?? 0, status: po.productOrderStatus ?? "", paidAt: d.order?.paymentDate ?? null });
  }
})();

// ── 발주서 조회 (order-sync 의 loadExistingOrders 와 같은 days+3 여유) ──
const since = new Date(Date.now() - (days + 3) * 86400000).toISOString();
interface DbRow { id: string; order_date: string | null; marketplace: string; recipient_name: string | null; product_name: string | null; quantity: number; delivery_status: string; source: string | null; marketplace_product_order_no: string | null }
const dbRows: DbRow[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("orders")
    .select("id,order_date,marketplace,recipient_name,product_name,quantity,delivery_status,source,marketplace_product_order_no")
    .eq("user_id", userId).gte("order_date", since).range(from, from + 999);
  if (error) { console.error(`발주서 조회 실패: ${error.message}`); process.exit(1); }
  dbRows.push(...((data ?? []) as DbRow[]));
  if (!data || data.length < 1000) break;
}
await Promise.all([coupangTask, naverTask]);
for (const e of errors) console.error(`  x ${e}`);

// ── 대조 ──
const srcOf = (r: DbRow) => r.source ?? "플토(엑셀)";
for (const market of MARKETS) {
  const rows = dbRows.filter((r) => (r.marketplace ?? "").includes(market));
  // 마켓번호별 그룹 — 존재 확인([누락])과 중복 검출([이중 등록])을 한 인덱스로 처리
  const byNo = new Map<string, DbRow[]>();
  for (const r of rows) {
    const no = r.marketplace_product_order_no;
    if (!no) continue;
    const g = byNo.get(no);
    if (g) g.push(r); else byNo.set(no, [r]);
  }
  const dbFuzzy = new Set(rows.map((r) => fuzzyKey(r.order_date, r.recipient_name, r.product_name)));
  const items = remote[market];
  console.log(`\n═══ ${market} ═══ 마켓 ${items.length}건(취소 제외) vs 발주서 ${rows.length}행`);

  // 1) 마켓에 있는데 발주서에 없는 주문 (마켓번호 → sync 와 동일한 퍼지키 순으로 확인)
  const missing = items.filter((it) => !byNo.has(it.key) && !dbFuzzy.has(fuzzyKey(it.paidAt, it.recipient, it.product)));
  console.log(`  [누락] 마켓엔 있는데 발주서에 없음: ${missing.length}건`);
  for (const m of missing.slice(0, 10)) console.log(`    ✗ ${m.recipient} · ${m.product} x${m.qty} (${m.status}, ${m.paidAt?.slice(0, 16)})`);

  // 2) 발주서에 마켓번호 없는 행 (API가 대조 못하는 행)
  const noNo = rows.filter((r) => !r.marketplace_product_order_no && !["취소완료", "판매종료"].includes(r.delivery_status));
  console.log(`  [마켓번호 없음] ${noNo.length}행 ${noNo.length ? "→ 백필 필요" : ""}`);
  for (const r of noNo.slice(0, 10)) console.log(`    ? ${r.recipient_name} · ${r.product_name} (${r.delivery_status}, source=${srcOf(r)})`);

  // 3) 같은 마켓번호가 두 행 이상 (이중 등록)
  const dup = [...byNo.entries()].filter(([, v]) => v.length > 1);
  console.log(`  [이중 등록] 같은 마켓번호 중복: ${dup.length}건`);
  for (const [k, v] of dup.slice(0, 10)) console.log(`    !! ${k}: ${v.map((r) => `${r.recipient_name}/${r.delivery_status}/source=${srcOf(r)}`).join(" · ")}`);

  // 4) source 별 집계
  const bySrc = new Map<string, number>();
  for (const r of rows) bySrc.set(srcOf(r), (bySrc.get(srcOf(r)) ?? 0) + 1);
  console.log(`  [출처별] ${[...bySrc.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
console.log("\n완료");
process.exit(0);
