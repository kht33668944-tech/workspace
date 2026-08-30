// 웹에서 직접 확인한 "개당 용량/중량"을 상품에 적는다.
//
//   node scripts/apply-unit-size.mjs --apply
//
// 자동 수집(find-unit-size.mjs)이 오리온 촉촉한 초코칩을 60g으로 잘못 읽어서
// (240g÷12개 = 20g이 맞다) 확인된 값은 여기에 적어 덮어쓴다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");

/** 상품명 → [개당용량, 개당중량, 근거] — 전부 검색으로 확인한 값 */
const VERIFIED = [
  ["오리온 촉촉한 초코칩 48개", "", "20g", "12개입 240g → 낱개 20g (다나와·오리온몰)"],
  ["오리온 촉촉한 초코칩 16개입 5개", "", "20g", "12개입 240g → 낱개 20g"],
  ["오예스 40개", "", "30g", "오예스 낱개 30g (나무위키·제품표기)"],
  ["오뚜기 맛있는 밥 30개", "", "210g", "오뚜기밥 표시기준량 210g"],
  ["오뚜기 맛있는 밥 12개", "", "210g", "오뚜기밥 표시기준량 210g"],
  ["홈런볼 소금우유 16개", "", "41g", "해태 홈런볼 소금우유 41g (컬리 164g 4번들)"],
  ["담터 아이스티 복숭아 160티", "", "14g", "담터 아이스티 복숭아 14g 스틱 (11번가)"],
  ["팔도 왕뚜껑 국물라볶이 9개", "", "130g", "팔도 왕뚜껑 국물라볶이 130g (다나와·컬리)"],
  ["스키피땅콩버터 3개", "", "32g", "스키피 땅콩버터 미니팩 32g (컬리)"],
  ["농심 카프리썬 제로 오렌지 20개", "200ml", "", "카프리썬 파우치 200ml"],
  ["칸타타 콘트라베이스 콜드브루 400펫 20펫", "400ml", "", "칸타타 콘트라베이스 콜드브루 400ml (칠성몰·컬리)"],
  ["오설록 프리미엄 티 컬렉션 4개 10종 1세트", "", "2g", "프리미엄 티 컬렉션 10종 40입, 티백 2g x 4입 (오설록 공식)"],
  ["안올릴에정", "", "200g", "자사 고시 포장단위 200g x 2개"],
];

let fixed = 0;
for (const [name, vol, wt, why] of VERIFIED) {
  const { data } = await sb.from("products").select("id, item_info").eq("product_name", name).limit(1);
  const p = data?.[0];
  if (!p) { console.log(`  ✗ ${name} — 상품 없음`); continue; }
  const info = { ...(p.item_info ?? {}) };
  const before = info.개당용량 || info.개당중량 || "(없음)";
  if (vol) info.개당용량 = vol;
  if (wt) info.개당중량 = wt;
  info.용량출처 = why;
  console.log(`  ${before === (vol || wt) ? "=" : "✓"} ${name}\n        ${before} → ${vol || wt}   ${why}`);
  if (APPLY) await sb.from("products").update({ item_info: info }).eq("id", p.id);
  fixed++;
}
console.log(`\n${APPLY ? "적용" : "미리보기"} ${fixed}건`);
