// 식약처 후보 판별 결과를 products.item_info에 적용 (배치 1: 음료 30개)
// Claude가 후보를 판별해 확정한 매핑(PICKS)을 기반으로 저장한다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const KEY = get("MFDS_API_KEY");
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const SELLER_PHONE = "010-6564-4459";

// 상품명 패턴 → 식약처 확정 제품 (Claude 판별 결과)
// mfds: C002 제품명 정확 일치값(복수 허용), bssh: 허용 업소 필터(부분 일치)
const PICKS = [
  { match: /^펩시콜라 제로슈거 라임향/, mfds: ["펩시제로슈거라임향"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /^펩시 제로 슈거 라임향 제로 카페인/, mfds: ["펩시제로슈거라임향제로카페인"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /칠성사이다 제로/, mfds: ["칠성사이다제로"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /칠성사이다/, mfds: ["칠성사이다"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /오랑지나/, mfds: ["오랑지나"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /밀키스 제로/, mfds: ["밀키스제로"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /밀키스/, mfds: ["밀키스"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /솔의눈/, mfds: ["솔의눈"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /레쓰비 마일드/, mfds: ["레쓰비마일드커피"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /레쓰비 그란데 헤이즐넛/, mfds: ["레쓰비그란데헤이즐넛"], bssh: ["롯데칠성음료", "삼양패키징", "동원시스템즈"], 판매원: "롯데칠성음료(주)" },
  { match: /레쓰비 그란데 라떼/, mfds: ["레쓰비그란데라떼"], bssh: ["롯데칠성음료", "동원시스템즈"], 판매원: "롯데칠성음료(주)" },
  { match: /레쓰비 모카라떼/, mfds: ["레쓰비모카라떼"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /립톤 제로 아이스티 복숭아/, mfds: ["립톤제로복숭아 아이스티", "립톤제로복숭아아이스티"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /핫식스 제로/, mfds: ["핫식스제로"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /핫식스 더킹 포스/, mfds: ["핫식스더킹포스"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /핫식스/, mfds: ["핫식스"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /게토레이 레몬/, mfds: ["게토레이레몬향"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /오트몬드 오리지널/, mfds: ["오트몬드"], bssh: ["자연과사람들", "연세유업"], 판매원: "롯데칠성음료(주)" },
  { match: /잔치집 식혜/, mfds: ["잔치집식혜"], bssh: ["네이처셀"], 판매원: "롯데칠성음료(주)" },
];

// 상담번호 (판매원 브랜드별 참고용)
const BRAND_PHONE = { "롯데칠성음료(주)": "080-730-1472 (롯데칠성 음료 소비자상담실)" };

function extractPackaging(name) {
  const vol = name.match(/\d+(\.\d+)?\s*(ml|mL|L|l)/);
  const cnt = name.match(/(\d+)\s*(개|팩|캔|병|입)/);
  if (vol && cnt) return `${vol[0].replace(/\s/g, "")} x ${cnt[1]}${cnt[2]}`;
  return null;
}

async function searchExact(mfdsNames, bsshFilters) {
  const rows = [];
  for (const nm of mfdsNames) {
    const r = await fetch(`http://openapi.foodsafetykorea.go.kr/api/${KEY}/C002/json/1/50/PRDLST_NM=${encodeURIComponent(nm)}`);
    const j = JSON.parse(await r.text());
    for (const x of j.C002?.row || []) {
      if (!mfdsNames.includes(x.PRDLST_NM)) continue; // 정확 일치만
      if (!bsshFilters.some((b) => (x.BSSH_NM || "").includes(b))) continue;
      rows.push(x);
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  return rows;
}

const { data: products, error } = await sb
  .from("products")
  .select("id, product_name")
  .eq("rebuild_status", "대기")
  .eq("category", "가공식품")
  .neq("registration_status", "판매중지") // 판매중지 상품은 재등록 대상 아님
  .order("sort_order", { ascending: true })
  .limit(30);
if (error) { console.error("[mfds-apply] 조회 실패:", error.message); process.exit(1); }

const cache = new Map(); // 같은 제품군은 API 재조회 생략
let ok = 0, skip = 0;
for (const p of products) {
  const pick = PICKS.find((x) => x.match.test(p.product_name));
  if (!pick) { console.log("보류(매핑없음):", p.product_name); skip++; continue; }

  const cacheKey = pick.mfds.join("|");
  let rows = cache.get(cacheKey);
  if (!rows) { rows = await searchExact(pick.mfds, pick.bssh); cache.set(cacheKey, rows); }
  if (!rows.length) { console.log("보류(식약처 0건):", p.product_name); skip++; continue; }

  const 보고번호목록 = rows.map((x) => `${x.PRDLST_REPORT_NO}(${x.BSSH_NM})`);
  const 원재료 = rows.map((x) => x.RAWMTRL_NM || "").sort((a, b) => b.length - a.length)[0];
  const 업소들 = [...new Set(rows.map((x) => x.BSSH_NM))];
  const info = {
    품목군: "가공식품",
    제품명: rows[0].PRDLST_NM,
    식품유형: rows[0].PRDLST_DCNM,
    제조원: 업소들.join(", ") + " (소재지는 제품 라벨 표기 참조 [검수필요-주소보강])",
    소비기한: "제품 별도 표시일까지",
    판매원: pick.판매원,
    포장단위별용량: extractPackaging(p.product_name) || "[검수필요]",
    원재료명: 원재료,
    품목보고번호: 보고번호목록.join(", "),
    유전자변형식품: "해당없음",
    소비자안전주의사항: "직사광선을 피해 서늘한 곳에 보관, 개봉 후 빨리 섭취",
    수입여부: "국내산",
    소비자상담번호: SELLER_PHONE,
    제조사상담번호_참고용: BRAND_PHONE[pick.판매원] || null,
    출처: "식약처 식품안전나라 품목제조보고(C002), 2026-08-22 조회",
  };
  const { error: ue } = await sb.from("products").update({ item_info: info, rebuild_status: "조사완료" }).eq("id", p.id);
  if (ue) { console.log("저장실패:", p.product_name, ue.message); skip++; }
  else { console.log("완료:", p.product_name, "→", rows[0].PRDLST_NM, `(보고번호 ${rows.length}건)`); ok++; }
}
console.log(`[mfds-apply] 완료 ${ok}건 / 보류 ${skip}건`);
