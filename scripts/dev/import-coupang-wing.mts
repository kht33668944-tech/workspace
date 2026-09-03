// 쿠팡 윙 DeliveryList 엑셀을 발주서(orders)에 직접 임포트 (API 장애 임시)
//   npx tsx scripts/dev/import-coupang-wing.mts <파일경로> [--go]
//   --go 없으면 드라이런 (파싱·중복 결과만 출력)
import fs from "fs";
import XLSX from "xlsx-js-style";
import { createClient } from "@supabase/supabase-js";
import { parseSheetOrdersFromWorksheet } from "@/lib/excel-parser";

const argv = process.argv.slice(2);
const filePath = argv.find((a) => !a.startsWith("--"));
const GO = argv.includes("--go");
if (!filePath) { console.error("사용법: npx tsx scripts/dev/import-coupang-wing.mts <파일> [--go]"); process.exit(1); }

const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = env.SYNC_USER_ID;

const wb = XLSX.readFile(filePath);
const sheet = wb.Sheets[wb.SheetNames[0]];
const orders = await parseSheetOrdersFromWorksheet(sheet as never);
console.log(`파싱: ${orders.length}건`);

// 기존 주문과 중복 체크 (마켓 상품주문번호 = 묶음배송번호-옵션ID 기준)
const { data: existing } = await sb.from("orders")
  .select("marketplace_product_order_no")
  .eq("user_id", userId).eq("marketplace", "쿠팡")
  .gte("order_date", "2026-08-25");
const existingKeys = new Set((existing ?? []).map((o) => o.marketplace_product_order_no).filter(Boolean));
const fresh = orders.filter((o) => o.marketplace_product_order_no && !existingKeys.has(o.marketplace_product_order_no));
const dup = orders.length - fresh.length;

// 상품소싱 매칭: 원가(최저가×수량)·구매URL 채우기 (UI 업로드와 동일 동작)
const { data: prods } = await sb.from("products").select("product_name,purchase_url,lowest_price").eq("user_id", userId).limit(5000);
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const pmap = new Map((prods ?? []).filter((p) => p.product_name).map((p) => [norm(p.product_name), p]));
let costFilled = 0, urlFilled = 0;
for (const o of fresh) {
  const m = o.product_name ? pmap.get(norm(o.product_name)) : undefined;
  if (!m) continue;
  if ((!o.cost || o.cost === 0) && m.lowest_price && m.lowest_price > 0) { o.cost = m.lowest_price * (o.quantity || 1); costFilled++; }
  if (!o.purchase_url && m.purchase_url) { o.purchase_url = m.purchase_url; urlFilled++; }
}

console.log(`신규 ${fresh.length}건 · 중복 제외 ${dup}건 · 원가 매칭 ${costFilled}건 · URL 매칭 ${urlFilled}건`);
for (const o of fresh) {
  console.log(`- ${o.recipient_name} | ${o.product_name} x${o.quantity} | 매출 ${o.revenue} 정산 ${o.settlement} 원가 ${o.cost} | 출고기한 ${o.ship_by_date ?? "-"} | ${o.marketplace_product_order_no}`);
}

if (!GO) { console.log("[드라이런] --go 로 실제 등록"); process.exit(0); }
if (fresh.length === 0) { console.log("등록할 신규 주문 없음"); process.exit(0); }

const rows = fresh.map((o) => ({ ...o, user_id: userId, source: "excel" }));
const { data, error } = await sb.from("orders").insert(rows).select("id");
if (error) { console.error("등록 실패:", error.message); process.exit(1); }
console.log(`등록 완료: ${data?.length ?? 0}건`);
