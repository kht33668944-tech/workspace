// 오픈마켓 금칙어 목록을 DB(forbidden_words)에 채운다.
//
//   node scripts/forbidden-words-seed.mjs          미리보기
//   node scripts/forbidden-words-seed.mjs --apply  저장
//
// 지마켓·옥션(ESM)은 공식 금칙어 전체 목록을 공개하지 않는다(안내 PDF가 이미지라 추출 불가).
// 그래서 실제 반려 사례 + 각 마켓 판매자 정책에서 공통으로 막는 표현을 모아 둔다.
// 이 목록은 "탐지용"이다 — 걸린다고 무조건 지우는 게 아니라 사람이 보고 판단한다.
// (예: "100% 국산 현미"의 100%는 문제없지만 "100% 치료"는 문제다)
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");

/** 분류별 금칙어. 실제 반려된 것은 ★ 표시 */
export const FORBIDDEN_GROUPS = {
  "질병·효능 표현": [
    "알레르기", "알러지", "아토피", "여드름", "화상", "다이어트",   // ★ 실제 반려 확인
    "치료", "완치", "치유", "특효", "효능", "항암", "항염", "면역력",
    "노화방지", "주름개선", "미백", "발모", "탈모방지", "변비", "숙취해소",
    "부작용없", "의학적", "임상시험",
  ],
  "최상급·절대 표현": [
    "1위", "최고", "최상급", "최저가", "최강", "최다", "넘버원", "No.1",
    "세계최초", "국내최초", "업계최초", "유일무이", "독보적", "완벽",
    "전국유일", "무조건", "절대",
  ],
  "마켓 서비스명·프로모션": [
    "오늘만특가", "올킬", "슈퍼딜", "스마일배송", "로켓배송", "새벽배송",
    "당일배송", "총알배송", "빠른배송", "무료배송", "핫딜", "타임세일",
  ],
  "거래 유도·외부 연결": [
    "카카오톡", "카톡", "직거래", "현금결제", "계좌이체", "네이버페이",
    "쿠팡", "지마켓", "옥션", "11번가", "티몬", "위메프",
  ],
  "기타 과장·오인": [
    "짝퉁", "이미테이션", "정품보장", "특허받은", "인증받은", "1+1",
  ],
};

const WORDS = [...new Set(Object.values(FORBIDDEN_GROUPS).flat())];

if (process.argv[1]?.endsWith("forbidden-words-seed.mjs")) {
  const { data: cur, error } = await sb.from("forbidden_words").select("word, user_id");
  if (error) { console.error("[금칙어] 조회 실패:", error.message); process.exit(1); }
  const users = [...new Set((cur ?? []).map((r) => r.user_id))];
  const have = new Set((cur ?? []).map((r) => String(r.word).trim()));
  const add = WORDS.filter((w) => !have.has(w));

  console.log(`현재 ${have.size}개 → 추가 ${add.length}개 (사용자 ${users.length}명에게 각각)`);
  for (const [g, list] of Object.entries(FORBIDDEN_GROUPS)) {
    const news = list.filter((w) => !have.has(w));
    console.log(`\n[${g}] ${list.length}개 (새로 추가 ${news.length})`);
    console.log("  " + list.join(", "));
  }
  if (!APPLY) { console.log("\n(저장하려면 --apply)"); process.exit(0); }

  const rows = [];
  for (const u of users) for (const w of add) rows.push({ word: w, user_id: u });
  for (let i = 0; i < rows.length; i += 200) {
    const { error: e } = await sb.from("forbidden_words").insert(rows.slice(i, i + 200));
    if (e) console.error(`[금칙어] 저장 실패: ${e.message}`);
  }
  console.log(`\n[금칙어] ${add.length}개 × 사용자 ${users.length}명 = ${rows.length}행 저장`);
}
