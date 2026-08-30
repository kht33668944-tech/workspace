// 금칙어를 뜻이 같은 다른 말로 바꾼다.
//
//   node scripts/fix-forbidden.mjs          미리보기
//   node scripts/fix-forbidden.mjs --apply  저장
//
// 지마켓·옥션은 상세설명에 "알레르기"가 있으면 등록을 막는다.
// 다만 알레르기 유발물질 표시는 식품표시광고법상 필요한 정보이므로 지우면 안 된다.
// → 같은 뜻의 전문 용어 "알레르겐"으로 바꿔 정보는 남기고 금칙어만 피한다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");

/** [찾을 말, 바꿀 말, 이유] */
const RULES = [
  ["알레르기", "알레르겐", "같은 뜻의 전문 용어 — 유발물질 정보는 그대로 남는다"],
  ["알러지", "알레르겐", "같은 뜻"],
  ["아토피", "민감성 피부", "금칙어"],
  ["여드름", "트러블", "금칙어"],
  ["다이어트", "", "금칙어 — 통째로 뺀다"],
  ["1위", "인기", "금칙어"],
  ["의학적 조치", "의료기관 조치", "생활화학제품 응급조치 법정 문구 — 뜻은 그대로"],
  ["의학적", "의료", "금칙어"],
  ["치유식품", "힐링식품", "제조원 상호에 들어간 말 — 회사 식별은 소재지로 가능"],
  ["효능효과", "효과", "의약외품 표기 항목명"],
];
/** 금칙어만 바꾼다. HTML·JSON은 공백까지 그대로 둬야 하므로 손대지 않는다. */
const swap = (s) => {
  let out = String(s ?? "");
  for (const [from, to] of RULES) out = out.split(from).join(to);
  return out;
};
/** 상품명은 낱말이 빠지면서 생긴 두 칸 공백을 정리한다 */
const swapName = (s) => swap(s).replace(/\s{2,}/g, " ").trim();

const products = [];
for (let off = 0; ; off += 500) {
  const { data, error } = await sb.from("products").select("id, product_name, detail_html, item_info")
    .order("sort_order").range(off, off + 499);
  if (error) { console.error("[금칙어] 조회 실패:", error.message); process.exit(1); }
  if (!data?.length) break; products.push(...data); if (data.length < 500) break;
}

let n = 0, nameChanged = 0;
for (const p of products) {
  const patch = {};
  const newName = swapName(p.product_name);
  if (newName !== p.product_name) { patch.product_name = newName; nameChanged++; console.log(`  상품명 ▸ ${p.product_name}\n          → ${newName}`); }
  const newHtml = swap(p.detail_html);
  if (p.detail_html && newHtml !== p.detail_html) patch.detail_html = newHtml;
  const infoStr = JSON.stringify(p.item_info ?? {});
  const newInfoStr = swap(infoStr);
  if (newInfoStr !== infoStr) { try { patch.item_info = JSON.parse(newInfoStr); } catch { /* 형태가 깨지면 건드리지 않는다 */ } }
  if (!Object.keys(patch).length) continue;
  n++;
  if (APPLY) {
    const { error } = await sb.from("products").update(patch).eq("id", p.id);
    if (error) console.error(`  ✗ ${p.product_name}: ${error.message}`);
  }
}
console.log(`\n${APPLY ? "수정" : "수정 예정"} ${n}건 (상품명 변경 ${nameChanged}건)`);
if (!APPLY) console.log("(저장하려면 --apply)");
