// 고시 값의 자잘한 흠을 정리한다.
//   node scripts/clean-item-info.mjs --apply
//
// ① 제품명 특수문자 제거 (쿠팡 "모델명을 정확하게 입력해주세요" 반려 요인)
//    "코카·콜라 제로" → "코카 콜라 제로"
//    "업소용 펩시콜라 라임 제로슈거 355ml＊24캔 /롯데칠성" → 용량·판매처 꼬리표까지 정리
// ② 비어 있는 필수항목을 "제품 포장 표기 참조"로 채움
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");
const REF = "제품 포장 표기 참조";

const REQ = {
  가공식품: ["제품명", "식품유형", "제조원", "소비기한", "포장단위별용량", "원재료명", "품목보고번호", "소비자상담번호"],
  생활화학제품: ["품명및모델명", "제품분류", "제조회사", "인증허가", "사용상주의사항", "소비자상담번호"],
  의약외품: ["품명및모델명", "인증허가", "제조회사", "사용상주의사항", "소비자상담번호"],
  기타재화: ["품명및모델명", "제조회사", "제조국", "소비자상담번호"],
};

/** 제품명 정리 — 한글·영문·숫자·공백만 남긴다 */
function cleanName(v) {
  return String(v ?? "")
    .replace(/\s*\/\s*[가-힣A-Za-z0-9]+\s*$/, " ")              // 끝에 붙은 "/롯데칠성" 같은 꼬리표
    .replace(/[［\[（(【]/g, " ").replace(/[］\]）)】]/g, " ")     // 괄호류
    .replace(/[^가-힣a-zA-Z0-9\s%.]/g, " ")                      // 나머지 특수문자 (%와 소수점은 뜻이 있어 남긴다)
    .replace(/\s{2,}/g, " ").trim();
}

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products").select("id, product_name, item_info")
    .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
console.log(`[clean] 조사완료 ${all.length}개`);

let fixedName = 0, fixedReq = 0;
for (const p of all) {
  const info = { ...(p.item_info ?? {}) };
  let changed = false;

  for (const k of ["제품명", "품명및모델명"]) {
    if (!info[k]) continue;
    const c = cleanName(info[k]);
    if (c && c !== info[k]) {
      if (fixedName < 8) console.log(`  이름  ${info[k]}\n    →   ${c}`);
      info[k] = c; changed = true; fixedName++;
    }
  }
  for (const k of REQ[info.품목군 ?? "가공식품"] ?? []) {
    if (!String(info[k] ?? "").trim()) { info[k] = REF; changed = true; fixedReq++; }
  }
  if (changed && APPLY) await sb.from("products").update({ item_info: info }).eq("id", p.id);
}
console.log(`\n[clean] 이름 정리 ${fixedName} / 빈 항목 채움 ${fixedReq}`);
console.log(APPLY ? "적용 완료 — 상세페이지 재생성 필요" : "(미리보기 — 적용하려면 --apply)");
