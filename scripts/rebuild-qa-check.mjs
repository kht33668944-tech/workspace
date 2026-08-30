// 재정비 상품 등록 전 사전 검수기
// 사용법: node scripts/rebuild-qa-check.mjs
// 조사완료 상품 전체를 검사해 마켓 반려 가능성이 있는 문제를 등록 "전에" 찾아낸다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const { data: products, error } = await sb
  .from("products")
  .select("product_name, item_info, rebuild_status")
  .eq("rebuild_status", "조사완료")
  .order("sort_order");
if (error) { console.error("[qa-check] 조회 실패:", error.message); process.exit(1); }

// 고시 항목은 품목군마다 다르다. 락스에 식품유형을 요구하면 안 된다.
const REQUIRED_BY_KIND = {
  가공식품: ["제품명", "식품유형", "제조원", "포장단위별용량", "원재료명", "품목보고번호", "소비자상담번호"],
  생활화학제품: ["품명및모델명", "제품분류", "제조회사", "인증허가", "사용상주의사항", "소비자상담번호"],
  의약외품: ["품명및모델명", "인증허가", "제조회사", "사용상주의사항", "소비자상담번호"],
  기타재화: ["품명및모델명", "제조회사", "제조국", "소비자상담번호"],
};
/** 품목군이 안 적혀 있으면 식품으로 본다 (식품이 먼저 만들어졌고 대다수다) */
const requiredFor = (info) => REQUIRED_BY_KIND[info.품목군] ?? REQUIRED_BY_KIND.가공식품;
// 바코드는 쿠팡 GTIN용이라 식품에만 해당한다
const needsBarcode = (info) => !info.품목군 || info.품목군 === "가공식품";
const issues = { 필수누락: [], 바코드없음: [], 검수필요: [], 상담번호오류: [] };

for (const p of products) {
  const info = p.item_info || {};
  const missing = requiredFor(info).filter((k) => !info[k]);
  if (missing.length) issues.필수누락.push(`${p.product_name} [${info.품목군 ?? "가공식품"}] → ${missing.join(", ")}`);
  if (needsBarcode(info) && !info.바코드) issues.바코드없음.push(p.product_name);
  const tagged = Object.entries(info).filter(([, v]) => typeof v === "string" && v.includes("검수필요"));
  if (tagged.length) issues.검수필요.push(`${p.product_name} → ${tagged.map(([k]) => k).join(", ")}`);
  if (info.소비자상담번호 !== "010-6564-4459") issues.상담번호오류.push(p.product_name);
}

console.log(`[qa-check] 조사완료 ${products.length}개 검사 결과\n`);
console.log(`■ 필수항목 누락 (등록 반려됨): ${issues.필수누락.length}건`);
issues.필수누락.forEach((x) => console.log("  -", x));
console.log(`■ 바코드 없음 (쿠팡만 반려, 타 마켓은 무관): ${issues.바코드없음.length}건`);
issues.바코드없음.forEach((x) => console.log("  -", x));
console.log(`■ [검수필요] 태그 잔존 (내보내기 시 자동 제거되므로 등록엔 지장 없음, 데이터 보강 대상): ${issues.검수필요.length}건`);
console.log(`■ 소비자상담번호 불일치: ${issues.상담번호오류.length}건`);
issues.상담번호오류.forEach((x) => console.log("  -", x));

const blocking = issues.필수누락.length + issues.상담번호오류.length;
console.log(blocking === 0
  ? "\n✅ 등록을 막는 문제 없음 (바코드 없는 상품만 쿠팡 제외하고 진행)"
  : `\n❌ 등록 전 수정 필요: ${blocking}건`);

// ── 판매중지 상품 오염 검사 (재등록 대상이 아님) ──
const { data: stopped } = await sb
  .from("products")
  .select("product_name")
  .eq("registration_status", "판매중지")
  .not("item_info", "is", null);
if (stopped?.length) {
  console.log(`\n❌ 판매중지 상품에 재정비 데이터가 들어감: ${stopped.length}건 (원복 필요)`);
  stopped.forEach((p) => console.log("  -", p.product_name));
} else {
  console.log("\n✅ 판매중지 상품 오염 없음");
}
