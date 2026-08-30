// 상품명 전수 이상 검사
// 사용법: node scripts/audit-product-names.mjs
// 판매중지 제외 전체 상품명을 훑어 의심 패턴을 분류해 출력하고 엑셀로 저장한다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import XLSX from "xlsx-js-style";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

let all = [], from = 0;
while (true) {
  const { data, error } = await sb
    .from("products")
    .select("id, product_name, category, registration_status, sort_order")
    .neq("registration_status", "판매중지")
    .order("sort_order")
    .range(from, from + 499);
  if (error) { console.error(error.message); process.exit(1); }
  all.push(...data);
  if (data.length < 500) break;
  from += 500;
}

const issues = [];
const add = (p, type, detail, suggest) => issues.push({ 유형: type, 상품명: p.product_name, 문제: detail, 추정수정: suggest || "", id: p.id, 순서: p.sort_order });

for (const p of all) {
  const n = p.product_name;

  // 1) 소수점 유실 의심: 두 자리 이상 숫자 + L (음료/식용유는 보통 0.3~2L, 대용량도 20L 미만)
  //    예) 15L → 1.5L, 18L → 1.8L
  const bigL = n.match(/(?<![\d.])(\d{2,})\s*L(?![a-zA-Z])/);
  if (bigL) {
    const v = Number(bigL[1]);
    if (v >= 10 && v <= 99) {
      const guess = `${String(v)[0]}.${String(v).slice(1)}L`;
      add(p, "소수점 유실 의심", `"${bigL[0]}" → 실제로는 ${guess}?`, n.replace(bigL[0], guess));
    }
  }

  // 2) 소수점 자리에 공백: "1 5L" → "1.5L"
  const spaceDecimal = n.match(/(?<![\d.])(\d)\s+(\d)\s*(L|ml|kg|g)(?![a-zA-Z])/i);
  if (spaceDecimal) {
    add(p, "소수점 자리 공백", `"${spaceDecimal[0]}" → "${spaceDecimal[1]}.${spaceDecimal[2]}${spaceDecimal[3]}"?`,
      n.replace(spaceDecimal[0], `${spaceDecimal[1]}.${spaceDecimal[2]}${spaceDecimal[3]}`));
  }

  // 3) 단위 대소문자 불일치 (ML, Ml, KG 등)
  const badUnit = n.match(/\d+\s*(ML|Ml|mL|KG|Kg|G(?![a-zA-Z]))/);
  if (badUnit) {
    const fixed = badUnit[0].replace(/ML|Ml|mL/, "ml").replace(/KG|Kg/, "kg").replace(/G$/, "g");
    add(p, "단위 표기 불일치", `"${badUnit[0]}" → "${fixed}"`, n.replace(badUnit[0], fixed));
  }

  // 4) 공백 문제: 연속 공백 / 앞뒤 공백
  if (/\s{2,}/.test(n) || n !== n.trim()) {
    add(p, "공백 이상", "연속 공백 또는 앞뒤 공백", n.replace(/\s+/g, " ").trim());
  }

  // 5) 수량 단위 누락 의심: 끝이 숫자로만 끝남 (예: "... 210g 24" )
  if (/\s\d+$/.test(n) && !/(개|팩|캔|병|입|봉|매|포|박스|세트|묶음|스틱|정|환|구|장|펫|페트|캡슐|g|kg|ml|L)$/i.test(n)) {
    add(p, "수량 단위 누락 의심", "상품명이 숫자로 끝남", "");
  }

  // 6) 특수문자 (CLAUDE.md 규칙: 한글/영문/숫자/공백만 허용)
  const special = n.match(/[^가-힣a-zA-Z0-9\s.]/g);
  if (special) {
    add(p, "특수문자 포함", `${[...new Set(special)].join(" ")} 포함`, n.replace(/[^가-힣a-zA-Z0-9\s.]/g, "").replace(/\s+/g, " ").trim());
  }

  // 7) 붙어쓴 브랜드+제품 의심 (한글 8자 이상 연속, 공백 없음)
  const longToken = n.split(/\s+/).find((t) => /^[가-힣]{9,}$/.test(t));
  if (longToken) add(p, "띄어쓰기 누락 의심", `"${longToken}" (한글 ${longToken.length}자 연속)`, "");

  // 8) 용량 자체가 없음
  if (!/\d+\s*(ml|mL|ML|L|g|kg|Kg|KG)/i.test(n)) {
    add(p, "용량 표기 없음", "용량(ml/L/g/kg)이 상품명에 없음", "");
  }

  // 9) 숫자+단위 사이 이상 (예: "15 L", "210 g") — 참고용
  if (/\d\s+(ml|L|g|kg)(?![a-zA-Z])/i.test(n) && !spaceDecimal) {
    add(p, "숫자-단위 사이 공백", "숫자와 단위 사이 공백", n.replace(/(\d)\s+(ml|L|g|kg)(?![a-zA-Z])/gi, "$1$2"));
  }
}

// 유형별 집계
const byType = {};
issues.forEach((i) => { (byType[i.유형] = byType[i.유형] || []).push(i); });

console.log(`[audit] 검사 대상 ${all.length}개 (판매중지 제외)`);
console.log(`[audit] 의심 건수 ${issues.length}건 / 유형 ${Object.keys(byType).length}종\n`);

const ORDER = ["소수점 유실 의심", "소수점 자리 공백", "특수문자 포함", "공백 이상", "단위 표기 불일치", "숫자-단위 사이 공백", "띄어쓰기 누락 의심", "수량 단위 누락 의심", "용량 표기 없음"];
for (const type of ORDER) {
  const list = byType[type];
  if (!list?.length) continue;
  console.log(`■ ${type} — ${list.length}건`);
  list.slice(0, 40).forEach((i) => console.log(`   ${i.상품명}\n      → ${i.문제}${i.추정수정 ? `\n      → 제안: ${i.추정수정}` : ""}`));
  if (list.length > 40) console.log(`   ... 외 ${list.length - 40}건 (엑셀 참조)`);
  console.log("");
}

// 엑셀 저장
fs.mkdirSync("backups", { recursive: true });
const ws = XLSX.utils.json_to_sheet(issues.map(({ 유형, 상품명, 문제, 추정수정, 순서 }) => ({ 유형, 상품명, 문제, "추정 수정안": 추정수정, "확정 상품명(직접입력)": "", 순서 })));
ws["!cols"] = [{ wch: 20 }, { wch: 45 }, { wch: 40 }, { wch: 45 }, { wch: 45 }, { wch: 8 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "상품명 이상");
XLSX.writeFile(wb, "backups/상품명_이상목록.xlsx");
console.log("엑셀 저장: backups/상품명_이상목록.xlsx");
