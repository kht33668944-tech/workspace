// 전체 상품 고시를 최종 점검한다.
//   node scripts/verify-all.mjs
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const PHONE = "010-6564-4459";

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, product_name, category, registration_status, rebuild_status, item_info, detail_html, detail_image_url, thumbnail_url")
    .range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
const live = all.filter((p) => p.registration_status !== "판매중지");
const stopped = all.filter((p) => p.registration_status === "판매중지");
const done = live.filter((p) => p.rebuild_status === "조사완료");

const REQ = {
  가공식품: ["제품명", "식품유형", "제조원", "소비기한", "포장단위별용량", "원재료명", "품목보고번호", "소비자상담번호"],
  생활화학제품: ["품명및모델명", "제품분류", "제조회사", "인증허가", "사용상주의사항", "소비자상담번호"],
  의약외품: ["품명및모델명", "인증허가", "제조회사", "사용상주의사항", "소비자상담번호"],
  기타재화: ["품명및모델명", "제조회사", "제조국", "소비자상담번호"],
};
const issues = { 필수누락: [], 상담번호: [], 상세없음: [], PNG없음: [], 특수문자: [], 외부이미지: [] };
const 출처별 = new Map();

for (const p of done) {
  const i = p.item_info ?? {};
  const kind = i.품목군 ?? "가공식품";
  (REQ[kind] ?? REQ.가공식품).forEach((k) => { if (!String(i[k] ?? "").trim()) issues.필수누락.push(`${p.product_name} → ${k}`); });
  if (i.소비자상담번호 !== PHONE) issues.상담번호.push(`${p.product_name} → ${i.소비자상담번호 ?? "(없음)"}`);
  if (!p.detail_html) issues.상세없음.push(p.product_name);
  if (!p.detail_image_url) issues.PNG없음.push(p.product_name);
  const nm = i.제품명 ?? i.품명및모델명 ?? "";
  if (/[^가-힣a-zA-Z0-9\s.%()]/.test(nm)) issues.특수문자.push(`${p.product_name} → ${nm}`);
  // 상세페이지에 판매처 이미지가 남아있으면 저작권 문제가 그대로다
  if (p.detail_html && /gmarket|auction|ohou|coupang|11st|s3-ap-northeast-2/.test(p.detail_html)) issues.외부이미지.push(p.product_name);
  const src = /식품안전나라|품목제조보고/.test(i.출처 ?? "") ? "식약처"
    : /초록누리/.test(i.출처 ?? "") ? "초록누리"
    : /의약품통합정보/.test(i.출처 ?? "") ? "의약품안전나라"
    : /제조사 공개/.test(i.출처 ?? "") ? "웹(제조사 공개정보)"
    : /포장 표기/.test(i.출처 ?? "") ? "포장 표기 안내" : "기타";
  출처별.set(src, (출처별.get(src) ?? 0) + 1);
}

console.log(`전체 ${all.length} / 판매중지 제외 ${live.length} / 조사완료 ${done.length} / 미완 ${live.length - done.length}\n`);
console.log("── 자료 출처별 ──");
[...출처별.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));

console.log("\n── 점검 ──");
const show = (label, arr, sample = 5) => {
  console.log(`${arr.length === 0 ? "✅" : "❌"} ${label}: ${arr.length}건`);
  arr.slice(0, sample).forEach((s) => console.log(`     · ${s}`));
};
show("필수항목 누락", issues.필수누락);
show("소비자상담번호 오류", issues.상담번호);
show("상세페이지 없음", issues.상세없음);
show("상세이미지(PNG) 없음", issues.PNG없음);
show("제품명 특수문자", issues.특수문자);
show("판매처 이미지 잔존", issues.외부이미지);
console.log(`${stopped.every((p) => p.rebuild_status !== "조사완료") ? "✅" : "❌"} 판매중지 상품 미오염: 판매중지 ${stopped.length}건 중 조사완료 ${stopped.filter((p) => p.rebuild_status === "조사완료").length}건`);
console.log(`${done.filter((p) => !p.thumbnail_url).length === 0 ? "✅" : "❌"} 썸네일 없음: ${done.filter((p) => !p.thumbnail_url).length}건`);
