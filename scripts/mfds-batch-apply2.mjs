// 배치 2 적용: Claude 판별 결과(PICKS/SKIPS)를 products.item_info에 저장
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const KEY = get("MFDS_API_KEY");
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const SELLER_PHONE = "010-6564-4459";

const PICKS = [
  { match: /트레비 라임/, mfds: ["라임트레비", "라임 트레비"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /트레비 레몬/, mfds: ["레몬트레비", "트레비레몬"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /트레비 플레인/, mfds: ["트레비플레인", "트레비 플레인"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /환타 오렌지/, mfds: ["환타 오렌지", "환타오렌지향"], bssh: ["코카콜라음료", "해태에이치티비", "오케이에프"], 판매원: "코카-콜라음료(주)" },
  { match: /코카콜라 제로제로/, mfds: ["코카 • 콜라 제로제로", "코카-콜라 제로제로", "코카·콜라 제로제로"], bssh: ["코카콜라음료"], 판매원: "코카-콜라음료(주)" },
  { match: /코카콜라 제로/, mfds: ["코카콜라 제로", "코카-콜라 제로"], bssh: ["코카콜라음료"], 판매원: "코카-콜라음료(주)" },
  { match: /농심 신라면/, mfds: ["신라면"], bssh: ["농심"], 판매원: "(주)농심" },
  { match: /콘트라베이스 저칼로리라떼/, mfds: ["콘트라베이스저칼로리라떼"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /디카페인 블랙커피/, mfds: ["콘트라베이스디카페인블랙"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /콜드브루 블랙커피/, mfds: ["콘트라베이스블랙"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /햇반 윤기가득쌀밥|햇반 백미 작은공기/, mfds: ["햇반 윤기가득쌀밥"], bssh: ["씨제이제일제당"], 판매원: "씨제이제일제당(주)" },
  { match: /오뚜기밥 백미/, mfds: ["오뚜기밥"], bssh: ["오뚜기"], 판매원: "(주)오뚜기" },
  { match: /불닭볶음면/, mfds: ["불닭볶음면"], bssh: ["삼양식품"], 판매원: "삼양식품(주)" },
  { match: /올리브 짜파게티/, mfds: ["올리브짜파게티"], bssh: ["농심"], 판매원: "(주)농심" },
  { match: /삼양라면/, mfds: ["삼양라면"], bssh: ["삼양식품"], 판매원: "삼양식품(주)" },
  { match: /안성탕면/, mfds: ["안성탕면"], bssh: ["농심"], 판매원: "(주)농심" },
  { match: /짜파게티 범벅/, mfds: ["짜파게티범벅"], bssh: ["농심"], 판매원: "(주)농심" },
];

const SKIPS = [
  { match: /헤드앤숄더|존슨즈베이비|리스테린/, 사유: "비식품(생활용품 카테고리 오분류) — 식품 필수정보 대상 아님, 별도 처리" },
  { match: /닥터페퍼/, 사유: "수입식품 — 국내 품목제조보고 없음 [검수필요-수입식품 정보 개별조사]" },
  { match: /솥반/, 사유: "식약처 검색 미매칭 [검수필요-개별조사]" },
];

const BRAND_PHONE = { "롯데칠성음료(주)": "080-730-1472 (롯데칠성 음료 소비자상담실)" };

function extractPackaging(name) {
  const vol = name.match(/\d+(\.\d+)?\s*(ml|mL|L|l|g|kg)/);
  const cnt = name.match(/(\d+)\s*(개|팩|캔|병|입)/);
  if (vol && cnt) return `${vol[0].replace(/\s/g, "")} x ${cnt[1]}${cnt[2]}`;
  return vol ? vol[0].replace(/\s/g, "") : null;
}

async function searchExact(mfdsNames, bsshFilters, retry = 0) {
  const rows = [];
  for (const nm of mfdsNames) {
    const r = await fetch(`http://openapi.foodsafetykorea.go.kr/api/${KEY}/C002/json/1/50/PRDLST_NM=${encodeURIComponent(nm)}`);
    const j = JSON.parse(await r.text());
    if (j.C002?.RESULT?.CODE === "INFO-500" && retry < 5) {
      await new Promise((res) => setTimeout(res, 1500 * (retry + 1)));
      return searchExact(mfdsNames, bsshFilters, retry + 1);
    }
    for (const x of j.C002?.row || []) {
      if (!mfdsNames.includes(x.PRDLST_NM)) continue;
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
  .is("item_info", null)
  .order("sort_order", { ascending: true })
  .limit(30);
if (error) { console.error("[apply2] 조회 실패:", error.message); process.exit(1); }

const cache = new Map();
let ok = 0, skip = 0;
for (const p of products) {
  const skipRule = SKIPS.find((x) => x.match.test(p.product_name));
  if (skipRule) {
    await sb.from("products").update({ item_info: { 스킵사유: skipRule.사유 } }).eq("id", p.id);
    console.log("스킵:", p.product_name, "→", skipRule.사유.slice(0, 30));
    skip++;
    continue;
  }
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
console.log(`[apply2] 완료 ${ok}건 / 스킵·보류 ${skip}건`);
