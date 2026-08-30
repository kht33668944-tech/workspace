// 배치 3 적용 (40개): Claude 판별 결과를 products.item_info에 저장
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const KEY = get("MFDS_API_KEY");
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const SELLER_PHONE = "010-6564-4459";

const PICKS = [
  { match: /신라면 큰사발/, mfds: ["신라면큰사발"], bssh: ["농심"], 판매원: "(주)농심" },
  { match: /신라면컵/, mfds: ["신라면컵"], bssh: ["농심"], 판매원: "(주)농심" },
  { match: /짜파게티 범벅/, mfds: ["짜파게티범벅"], bssh: ["농심"], 판매원: "(주)농심" },
  { match: /틈새라면 빨계떡/, mfds: ["팔도 틈새라면 빨계떡"], bssh: ["팔도", "한국야쿠르트"], 판매원: "(주)팔도" },
  { match: /팔도 도시락 오리지날/, mfds: ["팔도도시락"], bssh: ["팔도", "한국야쿠르트"], 판매원: "(주)팔도" },
  { match: /팔도 김치도시락/, mfds: ["팔도김치도시락"], bssh: ["팔도", "한국야쿠르트"], 판매원: "(주)팔도" },
  { match: /육개장 사발면/, mfds: ["육개장사발면"], bssh: ["농심"], 판매원: "(주)농심" },
  { match: /까르보 불닭볶음면/, mfds: ["까르보불닭볶음면"], bssh: ["삼양식품"], 판매원: "삼양식품(주)" },
  { match: /아몬드 브리즈 언스위트/, mfds: ["아몬드브리즈 언스위트"], bssh: ["매일유업"], 판매원: "매일유업(주)" },
  { match: /오랑지나/, mfds: ["오랑지나"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /포카리스웨트/, mfds: ["포카리스웨트"], bssh: ["동아오츠카"], 판매원: "동아오츠카(주)" },
  { match: /조지아 오리지널/, mfds: ["조지아 오리지널"], bssh: ["코카콜라음료", "자연과사람들", "삼양패키징", "오케이에프", "동원시스템즈"], 판매원: "코카-콜라음료(주)" },
  { match: /코카콜라 (300ml|490ml)/, mfds: ["코카콜라"], bssh: ["코카콜라음료"], 판매원: "코카-콜라음료(주)" },
  { match: /펩시콜라 제로 라임향/, mfds: ["펩시제로슈거라임향"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /나랑드사이다 제로/, mfds: ["나랑드사이다 제로"], bssh: ["동아오츠카", "동아에코팩", "튤립인터내셔널", "건강한사람들", "대경사과"], 판매원: "동아오츠카(주)" },
  { match: /나랑드사이다.*파인애플/, mfds: ["나랑드사이다 파인애플"], bssh: ["동아오츠카", "동아에코팩", "튤립인터내셔널", "건강한사람들", "대경사과"], 판매원: "동아오츠카(주)" },
  { match: /나랑드사이다.*그린애플/, mfds: ["나랑드사이다 그린애플"], bssh: ["동아오츠카", "동아에코팩", "튤립인터내셔널", "건강한사람들", "대경사과"], 판매원: "동아오츠카(주)" },
  { match: /오로나민씨/, mfds: ["오로나민C"], bssh: ["동아오츠카"], 판매원: "동아오츠카(주)" },
  { match: /매일두유 고단백 검은콩/, mfds: ["매일두유 고단백 검은콩"], bssh: ["매일유업", "자연과사람들"], 판매원: "매일유업(주)" },
  { match: /매일두유 검은콩/, mfds: ["매일두유 검은콩"], bssh: ["매일유업", "자연과사람들"], 판매원: "매일유업(주)" },
  { match: /몬스터 에너지 망고 로코/, mfds: ["몬스터에너지 망고 로코"], bssh: ["해태에이치티비"], 판매원: "코카-콜라음료(주)" },
  { match: /매일야채/, mfds: ["매일야채"], bssh: ["매일유업", "자연과사람들"], 판매원: "매일유업(주)" },
  { match: /레쓰비 모카라떼/, mfds: ["레쓰비모카라떼"], bssh: ["롯데칠성음료"], 판매원: "롯데칠성음료(주)" },
  { match: /아이브루 아메리카노/, mfds: ["아이브루 아메리카노 블랙"], bssh: ["동원시스템즈", "한국맥널티"], 판매원: "동원F&B" },
];

// C002(식품) 대상이 아닌 품목 — 별도 데이터소스 필요
const SKIPS = [
  { match: /서울우유|소화가 ?잘되는|속편한우유|멸균우유/, 사유: "축산물(우유) — 식약처 C002 아닌 축산물품목제조보고(C006) 대상 [검수필요-축산물API]" },
  { match: /삼다수|아이시스|생수/, 사유: "먹는샘물 — 환경부 관할, 식약처 품목제조보고 없음 [검수필요-생수 개별조사]" },
  { match: /몬스터 에너지 그린/, 사유: "식약처 미등록(수입) [검수필요-개별조사]" },
  { match: /웰치스 제로 포도/, 사유: "식약처 미매칭 [검수필요-개별조사]" },
  { match: /오설록 프리미엄 티 컬렉션/, 사유: "세트상품(10종 혼합) — 구성품별 개별 표기 필요 [검수필요-세트상품]" },
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
  .neq("registration_status", "판매중지") // 판매중지 상품은 재등록 대상 아님
  .is("item_info", null)
  .order("sort_order", { ascending: true })
  .limit(40);
if (error) { console.error("[apply3] 조회 실패:", error.message); process.exit(1); }

const cache = new Map();
let ok = 0, skip = 0;
for (const p of products) {
  const skipRule = SKIPS.find((x) => x.match.test(p.product_name));
  if (skipRule) {
    await sb.from("products").update({ item_info: { 스킵사유: skipRule.사유 } }).eq("id", p.id);
    console.log("스킵:", p.product_name, "→", skipRule.사유.slice(0, 35));
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
console.log(`[apply3] 완료 ${ok}건 / 스킵·보류 ${skip}건`);
