// 상품명 일괄 교정
// 사용법:
//   node scripts/fix-product-names.mjs           → 미리보기(전/후 목록만, DB 변경 없음)
//   node scripts/fix-product-names.mjs --apply   → 실제 적용 (적용 전 자동 백업)
//
// 주의: products(user_id, product_name)에 유니크 인덱스가 있으므로
//       교정 결과가 기존 상품명과 겹치면 적용하지 않고 "충돌"로 보고한다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import XLSX from "xlsx-js-style";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");

// ── 개별 지정 교정 (오타·잘림 등 규칙으로 못 잡는 것) ──
const MANUAL = [
  ["레쓰비 그란데 헤이즐럿 500ML 48개", "레쓰비 그란데 헤이즐넛 500ml 48개", "오타: 헤이즐럿→헤이즐넛"],
  ["파워에이드 마운틴블라 15L 12페트", "파워에이드 마운틴블라스트 1.5L 12페트", "잘림: 마운틴블라→마운틴블라스트, 15L→1.5L"],
  ["코카콜라 제로제로 350m 24개", "코카콜라 제로제로 350ml 24개", "단위 오타: 350m→350ml"],
  ["샘표 양조간장 1.7L 1개 + 500ml 1개", "샘표 양조간장 1.7L 1개 500ml 1개", "특수문자 + 제거"],
  ["샘표 양조간장 1.7L 2개 + 500ml 2개", "샘표 양조간장 1.7L 2개 500ml 2개", "특수문자 + 제거"],
  ["홍초 석류 1.5L + 복분자 1.5L", "홍초 석류 1.5L 복분자 1.5L", "특수문자 + 제거"],
  ["드림카카오 82% 86g 6개", "드림카카오 82퍼센트 86g 6개", "특수문자 % → 퍼센트"],
  ["칸타타콘트라베이스 콜드브루 블랙커피 500ml 24개", "칸타타 콘트라베이스 콜드브루 블랙커피 500ml 24개", "띄어쓰기"],
  ["칸타타콘트라베이스 디카페인 블랙커피 500ml 24개", "칸타타 콘트라베이스 디카페인 블랙커피 500ml 24개", "띄어쓰기"],
  ["옛날 구수한끓여먹는누룽지 국산 3KG", "옛날 구수한 끓여먹는 누룽지 국산 3kg", "띄어쓰기 + 단위"],
  ["홈스타 맥스 싱크대배수관클리너 230ml 3개", "홈스타 맥스 싱크대 배수관 클리너 230ml 3개", "띄어쓰기"],
  ["순창 차돌저당된장찌개양념 450g 3개", "순창 차돌 저당 된장찌개양념 450g 3개", "띄어쓰기"],
];
const MANUAL_MAP = new Map(MANUAL.map(([from, to, why]) => [from, { to, why }]));

// ── 규칙 교정 ──
function fixByRules(name) {
  const reasons = [];
  let n = name;

  // 1) 소수점 자리 공백: "1 5L" → "1.5L"
  const before1 = n;
  n = n.replace(/(?<![\d.])(\d)\s+(\d)\s*(L|ml|mL|ML|kg|KG|Kg|g|G)(?![a-zA-Z])/g, "$1.$2$3");
  if (n !== before1) reasons.push("소수점 자리 공백 → 소수점");

  // 2) 소수점 유실: 두 자리 숫자 + L (10~99L는 음료·생활용품 기준 비현실적) → 1.5L 형태
  const before2 = n;
  n = n.replace(/(?<![\d.])(\d)(\d)\s*L(?![a-zA-Z])/g, (m, a, b) => `${a}.${b}L`);
  if (n !== before2) reasons.push("소수점 유실 복원 (예: 15L→1.5L)");

  // 3) 단위 표기 통일
  const before3 = n;
  n = n.replace(/(\d)\s*(ML|Ml|mL)(?![a-zA-Z])/g, "$1ml")
       .replace(/(\d)\s*(KG|Kg)(?![a-zA-Z])/g, "$1kg")
       .replace(/(\d)\s*G(?![a-zA-Z가-힣])/g, "$1g");
  if (n !== before3) reasons.push("단위 표기 통일 (ML→ml, KG→kg, G→g)");

  // 4) 공백 정리
  const before4 = n;
  n = n.replace(/\s+/g, " ").trim();
  if (n !== before4) reasons.push("연속·앞뒤 공백 정리");

  return { fixed: n, reasons };
}

// ── 대상 조회 ──
let all = [], from = 0;
while (true) {
  const { data, error } = await sb
    .from("products")
    .select("id, product_name, registration_status, rebuild_status, sort_order")
    .order("sort_order")
    .range(from, from + 499);
  if (error) { console.error(error.message); process.exit(1); }
  all.push(...data);
  if (data.length < 500) break;
  from += 500;
}
const existing = new Set(all.map((p) => p.product_name));

const plan = [];
for (const p of all) {
  if (p.registration_status === "판매중지") continue; // 판매중지는 건드리지 않음
  const manual = MANUAL_MAP.get(p.product_name);
  let fixed, reasons;
  if (manual) {
    fixed = manual.to;
    reasons = [manual.why];
    // 수동 교정 결과에도 규칙 교정을 한 번 더 적용 (단위 등)
    const r = fixByRules(fixed);
    fixed = r.fixed;
    reasons.push(...r.reasons);
  } else {
    const r = fixByRules(p.product_name);
    fixed = r.fixed;
    reasons = r.reasons;
  }
  if (fixed === p.product_name) continue;

  // 유니크 충돌 검사 (다른 상품이 이미 그 이름을 쓰고 있는지)
  const collides = existing.has(fixed) && fixed !== p.product_name;
  plan.push({ id: p.id, 전: p.product_name, 후: fixed, 사유: reasons.join(", "), 충돌: collides, 조사완료: p.rebuild_status === "조사완료", 순서: p.sort_order });
}

const ok = plan.filter((x) => !x.충돌);
const conflict = plan.filter((x) => x.충돌);

console.log(`[fix] 교정 대상 ${plan.length}건 (적용 가능 ${ok.length} / 이름충돌 ${conflict.length})\n`);
console.log("── 전 → 후 ──");
ok.forEach((x, i) => console.log(`${String(i + 1).padStart(3)}. ${x.전}\n     → ${x.후}\n     (${x.사유})`));
if (conflict.length) {
  console.log("\n── ⚠ 이름 충돌로 건너뜀 (이미 같은 이름의 다른 상품이 있음 = 중복 상품 의심) ──");
  conflict.forEach((x) => console.log(`  ${x.전}\n     → ${x.후} (이미 존재)`));
}

// 엑셀 저장
fs.mkdirSync("backups", { recursive: true });
const ws = XLSX.utils.json_to_sheet(plan.map(({ 전, 후, 사유, 충돌, 조사완료, 순서 }) => ({ "수정 전": 전, "수정 후": 후, 사유, "이름충돌(건너뜀)": 충돌 ? "O" : "", "상세페이지 재생성 필요": 조사완료 ? "O" : "", 순서 })));
ws["!cols"] = [{ wch: 45 }, { wch: 45 }, { wch: 40 }, { wch: 16 }, { wch: 18 }, { wch: 8 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "상품명 교정");
XLSX.writeFile(wb, "backups/상품명_교정내역.xlsx");
console.log("\n엑셀 저장: backups/상품명_교정내역.xlsx");

if (!APPLY) { console.log("\n※ 미리보기 모드. 실제 적용하려면 --apply 를 붙이세요."); process.exit(0); }

// ── 적용 ──
fs.writeFileSync("backups/product_names_before_fix_20260822.json", JSON.stringify(plan.map((x) => ({ id: x.id, 전: x.전, 후: x.후 })), null, 1));
console.log("백업 저장: backups/product_names_before_fix_20260822.json");

let done = 0, fail = 0;
for (const x of ok) {
  const { error } = await sb.from("products").update({ product_name: x.후 }).eq("id", x.id);
  if (error) { console.log("실패:", x.전, error.message); fail++; }
  else done++;
}
console.log(`[fix] 적용 ${done}건 / 실패 ${fail}건 / 충돌 건너뜀 ${conflict.length}건`);
const needRegen = ok.filter((x) => x.조사완료).length;
if (needRegen) console.log(`※ 조사완료 상품 ${needRegen}건의 이름이 바뀌었으므로 상세페이지 재생성 필요`);
