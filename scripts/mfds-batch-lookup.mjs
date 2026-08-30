// 식약처 C002(품목제조보고) 배치 조회 도구
// 사용법: node scripts/mfds-batch-lookup.mjs <개수>
// - rebuild_status='대기' && category='가공식품' 상품을 순서대로 N개 가져와
//   상품명에서 검색어 변형을 만들어 C002를 조회하고,
//   후보 목록을 scripts/output/mfds-candidates.json 에 저장한다.
// - 후보 판별(어느 후보가 맞는지)은 Claude가 파일을 읽고 수행한다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const KEY = get("MFDS_API_KEY");
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const LIMIT = Number(process.argv[2] || 30);

// 상품명 → 검색어 변형 생성
// 예: "펩시콜라 제로슈거 라임향 355ml 24개" → ["펩시콜라제로슈거라임향", "제로슈거라임향", "펩시콜라", ...]
function makeVariants(name) {
  // 용량/수량/포장 토큰 제거
  // 주의: \b(단어 경계)는 한글 뒤에서 동작하지 않으므로 (?=\s|$) 사용
  const cleaned = name
    .replace(/\d+(\.\d+)?\s*(ml|mL|ML|l|L|g|kg|Kg|KG)(?=\s|$)/g, " ")
    .replace(/\d+\s*(개|팩|캔|병|입|봉|매|포|박스|세트|묶음|스틱|정|환|구|장)(?=\s|$)/g, " ")
    .replace(/(^|\s)x\s*\d+(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(Boolean);
  const variants = new Set();
  if (tokens.length) {
    variants.add(tokens.join(""));            // 전체 붙임
    variants.add(cleaned);                     // 전체 띄어쓰기 유지
    if (tokens.length > 1) {
      variants.add(tokens.slice(1).join(""));  // 브랜드 제외 붙임
      variants.add(tokens.slice(0, -1).join("")); // 마지막 토큰 제외 붙임
      variants.add(tokens[0] + tokens[1]);     // 앞 2토큰 붙임
    }
    variants.add(tokens[0]);                   // 브랜드/첫 토큰만
  }
  return [...variants].filter((v) => v.length >= 2);
}

async function searchC002(keyword, retry = 0) {
  const url = `http://openapi.foodsafetykorea.go.kr/api/${KEY}/C002/json/1/30/PRDLST_NM=${encodeURIComponent(keyword)}`;
  try {
    const r = await fetch(url);
    const txt = await r.text();
    const j = JSON.parse(txt);
    // 인증키 동시접속 제한(INFO-500) → 대기 후 재시도 (최대 5회)
    if (j.C002?.RESULT?.CODE === "INFO-500" && retry < 5) {
      await new Promise((res) => setTimeout(res, 1500 * (retry + 1)));
      return searchC002(keyword, retry + 1);
    }
    return (j.C002?.row || []).map((x) => ({
      제품명: x.PRDLST_NM,
      업소: x.BSSH_NM,
      유형: x.PRDLST_DCNM,
      보고번호: x.PRDLST_REPORT_NO,
      소비기한: x.POG_DAYCNT || null,
      원재료: x.RAWMTRL_NM,
    }));
  } catch {
    return [];
  }
}

const { data: products, error } = await sb
  .from("products")
  .select("id, product_name, category, sort_order")
  .eq("rebuild_status", "대기")
  .eq("category", "가공식품")
  .neq("registration_status", "판매중지") // 판매중지 상품은 재등록 대상 아님
  .is("item_info", null) // 스킵사유가 표시된 상품(비식품·수입식품 등)은 제외
  .order("sort_order", { ascending: true })
  .limit(LIMIT);
if (error) { console.error("[mfds-batch] 상품 조회 실패:", error.message); process.exit(1); }

console.log(`[mfds-batch] 대상 ${products.length}개 조회 시작`);
const results = [];
for (const p of products) {
  const variants = makeVariants(p.product_name);
  let candidates = [];
  let usedVariant = null;
  for (const v of variants) {
    const rows = await searchC002(v);
    if (rows.length > 0 && rows.length <= 60) {
      candidates = rows;
      usedVariant = v;
      break; // 결과가 있고 과다하지 않은 첫 변형 사용
    }
    await new Promise((r) => setTimeout(r, 500)); // API 부하 방지 (동시접속 1개 제한)
  }
  results.push({ id: p.id, product_name: p.product_name, 검색어: usedVariant, 후보수: candidates.length, 후보: candidates });
  console.log(`- ${p.product_name} → '${usedVariant ?? "매칭실패"}' ${candidates.length}건`);
}

const outDir = path.join("scripts", "output");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "mfds-candidates.json");
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(`[mfds-batch] 저장: ${outFile} (${results.length}개 상품)`);
