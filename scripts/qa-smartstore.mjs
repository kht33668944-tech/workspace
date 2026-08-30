// 스마트스토어 업로드 엑셀 점검.
//
//   node scripts/qa-smartstore.mjs [파일패턴]
//
// ESM과 달리 여기서만 보는 것:
//   · 단위가격 표시(2026-04 가격표시제) — 표시 여부가 Y면 딸린 칸이 전부 차 있어야 한다
//   · 고시 Y/N 칸 — "해당없음"을 넣으면 반려된다
//   · 카테고리코드가 스마트스토어에 실제로 있는 코드인지
import { serviceClient, fetchAll, isValidGtin13, readSheetsIn, printGrouped } from "./_lib.mjs";

const sb = serviceClient();

const FORBIDDEN = [...new Set(
  (await fetchAll(sb, "forbidden_words", "word")).map((r) => String(r.word).trim()).filter(Boolean),
)];

// 실제로 등록 가능한 카테고리 코드 (상위/유사 코드로 보내면 반려된다)
const catCodes = new Set(
  (await fetchAll(sb, "smartstore_category_codes", "category_code", null, 1000))
    .map((r) => String(r.category_code).trim()),
);
if (!catCodes.size) { console.error("[QA] 카테고리코드가 0개다 — 검사가 무의미하므로 중단한다"); process.exit(1); }

const { files, rows } = readSheetsIn(process.argv[2] ?? "스마트스토어_260824");
console.log(`파일 ${files.length}개 / ${rows.length}행 / 카테고리코드 ${catCodes.size}개 조회\n`);

const problems = [];
const warn = [];
const add = (list, tag, r, detail) => list.push(`${tag} | ${r["온라인 상품명"]} | ${detail}`);

const SHOP = "스마트스토어=redgoom";
const TEMPLATE = "2200901";
// 분류코드별 고시 항목 수와 Y/N만 받는 칸 번호
const NOTICE_LEN = { 21: 11, 18: 11, 17: 11, 20: 11, 22: 11, 35: 5 };
const YN_SLOTS = { 21: [8, 10] };   // 8=유전자변형식품, 10=수입신고 필함 문구
const NOTICE_KEYS = Array.from({ length: 24 }, (_, i) => `상품정보제공고시${i + 1}`);
const UNIT_PRICE_KEYS = ["구성 방식", "팩 수량", "팩당 수량", "팩당 수량 단위", "개당 용량"];
const RE_SPECIAL = /[^가-힣a-zA-Z0-9\s]/;
const RE_SPECIAL_ALL = /[^가-힣a-zA-Z0-9\s]/g;
const RE_DECIMAL_DOT = /(?<=\d)\.(?=\d)/g;
const RE_EXTERNAL_IMG = /<img[^>]+src=["']https?:\/\/(?!.*supabase)/;

const seenCode = new Set();
for (const r of rows) {
  const nm = String(r["온라인 상품명"] ?? "").trim();
  const code = String(r["판매자관리코드"] ?? "").trim();

  if (!nm) add(problems, "상품명 없음", r, "");
  if (nm.length > 100) add(warn, "상품명 100자 초과", r, `${nm.length}자`);
  // 소수점(1.5L)은 정상이다. 그 밖의 기호만 본다.
  const badCh = nm.replace(RE_DECIMAL_DOT, "").match(RE_SPECIAL_ALL);
  if (badCh) add(warn, "상품명 특수문자", r, badCh.join(""));

  if (!code) add(problems, "판매자관리코드 없음", r, "");
  else if (seenCode.has(code)) add(problems, "판매자관리코드 중복", r, code);
  else seenCode.add(code);

  if (String(r["쇼핑몰(계정)"] ?? "").trim() !== SHOP) add(problems, "쇼핑몰 값 이상", r, String(r["쇼핑몰(계정)"]));
  if (String(r["템플릿코드"]).trim() !== TEMPLATE) add(problems, "템플릿코드 불일치", r, String(r["템플릿코드"]));

  if (!(Number(r["판매가"]) > 0)) add(problems, "판매가 이상", r, String(r["판매가"]));
  if (!(Number(r["판매수량"]) > 0)) add(problems, "판매수량 이상", r, String(r["판매수량"]));

  const cat = String(r["카테고리코드"] ?? "").trim();
  if (!cat) add(problems, "카테고리 없음", r, "");
  else if (!catCodes.has(cat)) add(problems, "미등록 카테고리코드", r, cat);

  if (!String(r["기본이미지"]).trim()) add(problems, "썸네일 없음", r, "");

  const html = String(r["상세설명"] ?? "");
  if (!html.trim()) add(problems, "상세설명 없음", r, "");
  if (html.length > 32000) add(problems, "상세설명 길이 초과", r, `${html.length}자 (엑셀 셀 한계 32767)`);
  if (RE_EXTERNAL_IMG.test(html)) add(problems, "외부 이미지", r, "");

  const cls = String(r["상품분류코드"] ?? "").trim();
  const len = NOTICE_LEN[cls];
  if (!len) add(problems, "상품분류코드 이상", r, cls);
  // 고시 칸도 상세페이지에 그대로 노출되므로 금칙어 검사에 함께 넣는다
  const noticeText = NOTICE_KEYS.map((k) => String(r[k] ?? "")).join(" ");
  const hitWords = FORBIDDEN.filter((w) => nm.includes(w) || html.includes(w) || noticeText.includes(w));
  if (hitWords.length) add(problems, "금칙어", r, hitWords.join(","));

  // 고시: 정해진 개수만큼 값이 있어야 한다
  for (let i = 1; len && i <= len; i++) {
    if (!String(r[`상품정보제공고시${i}`] ?? "").trim()) { add(problems, `고시${i} 비어있음`, r, `분류 ${cls}`); break; }
  }
  for (const s of YN_SLOTS[cls] ?? []) {
    const v = String(r[`상품정보제공고시${s}`] ?? "").trim();
    if (v !== "Y" && v !== "N") add(problems, `고시${s} Y/N 아님`, r, v);
  }

  // 단위가격 표시 (2026-04 가격표시제)
  const unitY = String(r["단위 가격 표시 여부"] ?? "").trim().toUpperCase();
  if (unitY && unitY !== "Y" && unitY !== "N") add(problems, "단위가격 표시여부 이상", r, unitY);
  // 표시 용량은 1~999만 받는다. 표시 여부가 N이어도 값이 있으면 검사하므로 0을 넣으면 반려된다.
  const shown = String(r["표시 용량"] ?? "").trim();
  if (shown && !(/^\d+$/.test(shown) && Number(shown) >= 1 && Number(shown) <= 999))
    add(problems, "표시 용량 범위 밖", r, `${shown} (1~999만 가능)`);
  if (unitY === "N" && (shown || String(r["표시 단위"] ?? "").trim() || String(r["개당 용량"] ?? "").trim()))
    add(warn, "표시 안 하는데 값이 있음", r, `표시용량=${shown}`);
  if (unitY === "Y") {
    const miss = UNIT_PRICE_KEYS.filter((k) => !String(r[k] ?? "").trim());
    if (miss.length) add(problems, "단위가격 항목 누락", r, miss.join(","));
    const 방식 = String(r["구성 방식"] ?? "").trim();
    if (방식 && !["팩", "낱개"].includes(방식)) add(problems, "구성 방식 이상", r, 방식);
    for (const k of ["팩 수량", "팩당 수량"]) {
      const v = String(r[k] ?? "").trim();
      if (v && !/^\d+$/.test(v)) add(problems, `${k} 숫자 아님`, r, v);
    }
  }

  const bar = String(r["옵션바코드"] ?? "").trim();
  if (bar && !isValidGtin13(bar)) add(problems, "바코드 형식", r, bar);
  const std = String(r["표준상품코드"] ?? "").trim();
  if (std && !/^KAN=\d{13}$/.test(std)) add(problems, "표준상품코드 형식", r, std);

  if (RE_SPECIAL.test(String(r["모델명"] ?? ""))) add(problems, "모델명 특수문자", r, String(r["모델명"]));
  if (!String(r["브랜드"]).trim()) add(warn, "브랜드 없음", r, "");
  if (!String(r["원산지"]).trim()) add(problems, "원산지 없음", r, "");
}

printGrouped("■ 등록을 막는 문제", problems, "없음 ✅");
console.log("");
printGrouped("■ 확인해 볼 것 (반려는 아닐 수 있음)", warn, "없음", 5);
