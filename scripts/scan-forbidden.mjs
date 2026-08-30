// 상세설명·상품명에 금칙어가 들어 있는지 본다.
//
//   node scripts/scan-forbidden.mjs
//
// 지마켓·옥션은 상세설명에 금칙어가 있으면 등록을 막는다 ("금칙어 알레르기은(는) 사용할 수 없습니다").
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const { data: fw, error } = await sb.from("forbidden_words").select("word");
if (error) { console.error("[금칙어] 조회 실패:", error.message); process.exit(1); }
const words = [...new Set((fw ?? []).map((r) => String(r.word).trim()).filter(Boolean))];
console.log(`금칙어 ${words.length}개: ${words.join(", ")}\n`);

const products = [];
for (let off = 0; ; off += 500) {
  const { data, error: e } = await sb.from("products").select("id, product_name, detail_html, item_info")
    .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지").order("sort_order").range(off, off + 499);
  if (e) { console.error("[금칙어] 상품 조회 실패:", e.message); process.exit(1); }
  if (!data?.length) break; products.push(...data); if (data.length < 500) break;
}

const hitByWord = new Map();
const hitProducts = new Set();
for (const p of products) {
  const html = String(p.detail_html ?? "");
  const info = JSON.stringify(p.item_info ?? {});
  for (const w of words) {
    const where = [];
    if (p.product_name.includes(w)) where.push("상품명");
    if (html.includes(w)) where.push("상세설명");
    if (info.includes(w)) where.push("고시");
    if (!where.length) continue;
    if (!hitByWord.has(w)) hitByWord.set(w, []);
    hitByWord.get(w).push(`${p.product_name} (${where.join("+")})`);
    hitProducts.add(p.product_name);
  }
}
console.log(`상품 ${products.length}개 중 금칙어 포함 ${hitProducts.size}개\n`);
for (const [w, list] of [...hitByWord].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`[${list.length}] ${w}`);
  list.slice(0, 3).forEach((x) => console.log(`   · ${x}`));
}
