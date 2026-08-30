// 병행 검증: 마켓 API 원본 주문 vs 발주서(orders) 대조
//   npx tsx scripts/dev/compare-parallel-orders.mts [--days 2]
//   - 마켓에는 있는데 발주서에 없는 주문(누락), 발주서에 마켓번호 없는 행(백필 실패),
//     같은 주문이 두 행으로 들어간 중복(플토+API 이중 등록)을 찾는다.
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient, type CoupangOrderStatus } from "@/lib/coupang-api";
import { NaverCommerceApiClient, toKstIso, type NaverProductOrderDetail } from "@/lib/naver-commerce-api";
import { sleep } from "@/lib/marketplace/common";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const days = Number(opt("days", "2"));
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k];
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = env.SYNC_USER_ID;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dateKeyKst = (iso: string | null) => iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10) : "";
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toLowerCase();

interface RemoteItem { key: string; orderNo: string; recipient: string; product: string; qty: number; status: string; paidAt: string | null }

const { data: creds } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", userId);
if (!creds?.length) { console.error("API 계정 없음"); process.exit(1); }

// ── 마켓 원본 조회 ──
const remote: Record<string, RemoteItem[]> = { 쿠팡: [], 스마트스토어: [] };

const cc = creds.find((c) => c.platform === "coupang");
if (cc) {
  const client = new CoupangOpenApiClient({ vendorId: cc.account_id, accessKey: decrypt(cc.access_key_encrypted), secretKey: decrypt(cc.secret_key_encrypted) });
  const from = ymd(new Date(Date.now() - days * 86400000)), to = ymd(new Date());
  for (const status of ["ACCEPT", "INSTRUCT", "DEPARTURE", "DELIVERING", "FINAL_DELIVERY"] as CoupangOrderStatus[]) {
    const sheets = await client.listAllOrderSheets({ createdAtFrom: from, createdAtTo: to, status });
    for (const sheet of sheets) {
      for (const it of sheet.orderItems ?? []) {
        const qty = it.shippingCount ?? 0;
        if (qty <= 0 || it.canceled || (it.cancelCount ?? 0) >= qty) continue;
        remote.쿠팡.push({ key: `${sheet.shipmentBoxId}-${it.vendorItemId}`, orderNo: String(sheet.orderId), recipient: sheet.receiver?.name ?? "", product: it.sellerProductName || it.vendorItemName || "", qty, status, paidAt: sheet.paidAt ?? sheet.orderedAt ?? null });
      }
    }
    await sleep(300);
  }
}

const nc = creds.find((c) => c.platform === "smartstore");
if (nc) {
  const client = new NaverCommerceApiClient({ clientId: decrypt(nc.client_id_encrypted), clientSecret: decrypt(nc.client_secret_encrypted) });
  const details: NaverProductOrderDetail[] = [];
  const now = Date.now();
  for (let d = days - 1; d >= 0; d--) {
    const from = new Date(now - (d + 1) * 86400000), to = new Date(now - d * 86400000 - 1000);
    for (let page = 1; page < 30; page++) {
      const res = await client.searchProductOrders({ from: toKstIso(from), to: toKstIso(to), page, pageSize: 300 });
      if (!res.ok || !res.body || typeof res.body === "string") { console.error(`[스토어] 조회 실패(${ymd(from)}): ${res.message}`); break; }
      const data = res.body.data;
      const list = Array.isArray(data) ? data : (data?.contents ?? []).map((c) => c.content).filter((c) => !!c?.productOrder);
      details.push(...list);
      const totalPages = Array.isArray(data) ? 1 : (data?.pagination?.totalPages ?? 1);
      await sleep(600);
      if (page >= totalPages || list.length === 0) break;
    }
  }
  for (const d of details) {
    const po = d.productOrder;
    if (!po || (po.quantity ?? 0) <= 0) continue;
    if (/^CANCEL/.test(po.productOrderStatus ?? "")) continue; // 취소 완료 건 제외
    remote.스마트스토어.push({ key: po.productOrderId, orderNo: d.order?.orderId ?? "", recipient: d.order?.ordererName ?? po.shippingAddress?.name ?? "", product: [po.productName, po.productOption].filter(Boolean).join(" "), qty: po.quantity ?? 0, status: po.productOrderStatus ?? "", paidAt: d.order?.paymentDate ?? null });
  }
}

// ── 발주서 조회 ──
// 쿠팡 날짜 필터는 KST 일 단위, DB order_date는 UTC라 경계가 어긋난다 → 하루 여유를 더 둔다
const since = new Date(Date.now() - (days + 2) * 86400000).toISOString();
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

// ── 대조 ──
for (const market of ["쿠팡", "스마트스토어"] as const) {
  const rows = dbRows.filter((r) => (r.marketplace ?? "").includes(market));
  const byNo = new Map(rows.filter((r) => r.marketplace_product_order_no).map((r) => [r.marketplace_product_order_no!, r]));
  const items = remote[market];
  console.log(`\n═══ ${market} ═══ 마켓 ${items.length}건(취소 제외) vs 발주서 ${rows.length}행`);

  // 1) 마켓에 있는데 발주서에 없는 주문
  const missing = items.filter((it) => {
    if (byNo.has(it.key)) return false;
    const fk = `${dateKeyKst(it.paidAt)}|${norm(it.recipient)}|${norm(it.product)}`;
    return !rows.some((r) => `${dateKeyKst(r.order_date)}|${norm(r.recipient_name)}|${norm(r.product_name)}` === fk);
  });
  console.log(`  [누락] 마켓엔 있는데 발주서에 없음: ${missing.length}건`);
  for (const m of missing.slice(0, 10)) console.log(`    ✗ ${m.recipient} · ${m.product} x${m.qty} (${m.status}, ${m.paidAt?.slice(0, 16)})`);

  // 2) 발주서에 마켓번호 없는 행 (API가 대조 못하는 행)
  const noNo = rows.filter((r) => !r.marketplace_product_order_no && !["취소완료", "판매종료"].includes(r.delivery_status));
  console.log(`  [마켓번호 없음] ${noNo.length}행 ${noNo.length ? "→ 백필 필요" : ""}`);
  for (const r of noNo.slice(0, 10)) console.log(`    ? ${r.recipient_name} · ${r.product_name} (${r.delivery_status}, source=${r.source ?? "플토"})`);

  // 3) 같은 마켓번호가 두 행 이상 (이중 등록)
  const cnt = new Map<string, DbRow[]>();
  for (const r of rows) if (r.marketplace_product_order_no) cnt.set(r.marketplace_product_order_no, [...(cnt.get(r.marketplace_product_order_no) ?? []), r]);
  const dup = [...cnt.entries()].filter(([, v]) => v.length > 1);
  console.log(`  [이중 등록] 같은 마켓번호 중복: ${dup.length}건`);
  for (const [k, v] of dup.slice(0, 10)) console.log(`    !! ${k}: ${v.map((r) => `${r.recipient_name}/${r.delivery_status}/source=${r.source ?? "플토"}`).join(" · ")}`);

  // 4) source 별 집계
  const bySrc = new Map<string, number>();
  for (const r of rows) bySrc.set(r.source ?? "플토(엑셀)", (bySrc.get(r.source ?? "플토(엑셀)") ?? 0) + 1);
  console.log(`  [출처별] ${[...bySrc.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
console.log("\n완료");
process.exit(0);
