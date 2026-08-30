// 배치 4 적용 (30개)
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const KEY = get("MFDS_API_KEY");
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const SELLER_PHONE = "010-6564-4459";

const PICKS = [
  { match: /팔도 도시락 오리지날/, mfds: ["팔도 도시락"], bssh: ["팔도"], 판매원: "(주)팔도" },
  { match: /신라면 큰사발/, mfds: ["신라면큰사발면"], bssh: ["농심"], 판매원: "(주)농심" },
  { match: /매일야채 고농축 토마토/, mfds: ["매일야채 고농축 토마토의 힘"], bssh: ["매일유업"], 판매원: "매일유업(주)" },
  { match: /아이브루 아메리카노/, mfds: ["아이브루 아메리카노 블랙"], bssh: ["동원시스템즈"], 판매원: "한국맥널티(주)" },
  { match: /코카콜라 제로/, mfds: ["코카콜라 제로"], bssh: ["코카콜라음료"], 판매원: "코카-콜라음료(주)" },
  { match: /^코카콜라 1/, mfds: ["코카콜라"], bssh: ["코카콜라음료"], 판매원: "코카-콜라음료(주)" },
  { match: /파워에이드 마운틴블라스트/, mfds: ["파워에이드 마운틴 블라스트"], bssh: ["코카콜라음료", "오케이에프", "해태에이치티비", "동원시스템즈", "삼양패키징", "자연과사람들"], 판매원: "코카-콜라음료(주)" },
  { match: /토레타/, mfds: ["토레타!"], bssh: ["코카콜라음료", "한국음료", "오케이에프", "삼양패키징", "자연과사람들", "동원시스템즈"], 판매원: "코카-콜라음료(주)" },
  { match: /잔치집 식혜/, mfds: ["잔치집식혜"], bssh: ["네이처셀"], 판매원: "롯데칠성음료(주)" },
  { match: /오설록 제주 순수녹차/, mfds: ["오설록 제주순수녹차"], bssh: ["오설록농장"], 판매원: "(주)오설록농장" },
  { match: /조지아 블랙/, mfds: ["조지아 블랙"], bssh: ["해태에이치티비", "삼양패키징"], 판매원: "코카-콜라음료(주)" },
  { match: /조지아 라떼/, mfds: ["조지아 라떼"], bssh: ["해태에이치티비"], 판매원: "코카-콜라음료(주)" },
  { match: /칠성사이다에코/, mfds: ["칠성사이다"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /포카리스웨트/, mfds: ["포카리스웨트"], bssh: ["동아오츠카"], 판매원: "동아오츠카(주)" },
  { match: /아몬드브리즈 초콜릿/, mfds: ["아몬드브리즈 초콜릿"], bssh: ["매일유업"], 판매원: "매일유업(주)" },
  { match: /피크닉 사과/, mfds: ["피크닉 사과"], bssh: ["매일유업"], 판매원: "매일유업(주)" },
  { match: /맥심 모카골드 마일드/, mfds: ["맥심모카골드마일드커피믹스"], bssh: ["동서식품"], 판매원: "동서식품(주)" },
  { match: /비락식혜 제로/, mfds: ["비락식혜 제로"], bssh: ["팔도"], 판매원: "(주)팔도" },
  { match: /콘트라베이스 콜드브루 스위트블랙|콘트라베이스.*스위트블랙/, mfds: ["콘트라베이스스위트블랙"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
];

const SKIPS = [
  { match: /상하목장|파스퇴르|서울우유|속편한우유|멸균우유|바나나는 원래 맛있다/, 사유: "축산물(우유·가공유) — 축산물품목제조보고(C006) 대상 [검수필요-축산물API]" },
  { match: /나랑드사이다 제로 15/, 사유: "플레인 제로 제품 식약처 미매칭(맛별만 등록) [검수필요-개별조사]" },
  { match: /오설록 베스트 티 3종/, 사유: "세트상품(3종 혼합) — 구성품별 개별 표기 필요 [검수필요-세트상품]" },
];

const BRAND_PHONE = { "롯데칠성음료(주)": "080-730-1472 (롯데칠성 음료 소비자상담실)" };

function extractPackaging(name) {
  const vol = name.match(/\d+(\.\d+)?\s*(ml|mL|ML|L|l|g|kg)/i);
  const cnt = name.match(/(\d+)\s*(개|팩|캔|병|입|펫|페트)/);
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
  .neq("registration_status", "판매중지")
  .is("item_info", null)
  .order("sort_order", { ascending: true })
  .limit(30);
if (error) { console.error("[apply4] 조회 실패:", error.message); process.exit(1); }

const cache = new Map();
let ok = 0, skip = 0;
for (const p of products) {
  const skipRule = SKIPS.find((x) => x.match.test(p.product_name));
  if (skipRule) {
    await sb.from("products").update({ item_info: { 스킵사유: skipRule.사유 } }).eq("id", p.id);
    console.log("스킵:", p.product_name);
    skip++;
    continue;
  }
  const pick = PICKS.find((x) => x.match.test(p.product_name));
  if (!pick) { console.log("보류(매핑없음):", p.product_name); skip++; continue; }

  const cacheKey = pick.mfds.join("|");
  let rows = cache.get(cacheKey);
  if (!rows) { rows = await searchExact(pick.mfds, pick.bssh); cache.set(cacheKey, rows); }
  if (!rows.length) { console.log("보류(식약처 0건):", p.product_name); skip++; continue; }

  const info = {
    품목군: "가공식품",
    제품명: rows[0].PRDLST_NM,
    식품유형: rows[0].PRDLST_DCNM,
    제조원: [...new Set(rows.map((x) => x.BSSH_NM))].join(", ") + " (소재지는 제품 라벨 표기 참조 [검수필요-주소보강])",
    소비기한: "제품 별도 표시일까지",
    판매원: pick.판매원,
    포장단위별용량: extractPackaging(p.product_name) || "[검수필요]",
    원재료명: rows.map((x) => x.RAWMTRL_NM || "").sort((a, b) => b.length - a.length)[0],
    품목보고번호: rows.map((x) => `${x.PRDLST_REPORT_NO}(${x.BSSH_NM})`).join(", "),
    유전자변형식품: "해당없음",
    소비자안전주의사항: "직사광선을 피해 서늘한 곳에 보관, 개봉 후 빨리 섭취",
    수입여부: "국내산",
    소비자상담번호: SELLER_PHONE,
    제조사상담번호_참고용: BRAND_PHONE[pick.판매원] || null,
    출처: "식약처 식품안전나라 품목제조보고(C002), 2026-08-22 조회",
  };
  const { error: ue } = await sb.from("products").update({ item_info: info, rebuild_status: "조사완료" }).eq("id", p.id);
  if (ue) { console.log("저장실패:", p.product_name, ue.message); skip++; }
  else { console.log("완료:", p.product_name, "→", rows[0].PRDLST_NM); ok++; }
}
console.log(`[apply4] 완료 ${ok}건 / 스킵·보류 ${skip}건`);
