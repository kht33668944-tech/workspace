// 플레이오토 대량등록 엑셀 오프라인 생성기 (Gemini API 호출 없음 = 비용 0)
//
// 사용법:
//   node scripts/build-playauto-excel.mjs coupang
//   node scripts/build-playauto-excel.mjs smartstore
//   node scripts/build-playauto-excel.mjs gmarket_auction
//   node scripts/build-playauto-excel.mjs all
//   node scripts/build-playauto-excel.mjs coupang --retry <작업결과.xlsx>          실패분만
//   node scripts/build-playauto-excel.mjs coupang --retry <작업결과.xlsx> --recat  카테고리 바뀐 성공분만
//
// 대상: rebuild_status='조사완료' && 판매중지 아님
// 저장: 바탕화면/상품등록/
//
// 웹 내보내기와 달리 AI를 쓰지 않고 다음 규칙으로 값을 채운다.
//   · 카테고리코드 : 식약처 식품유형 → 스마트스토어 카테고리 매핑표 (결정적)
//   · 브랜드      : 상품명 첫 단어 (소비자 브랜드 — 제조사를 넣으면 쿠팡 브랜드 정보 수정 대상이 된다)
//   · 제조사      : item_info의 판매원·제조원에서 추출
//   · 쿠팡 옵션    : 카테고리별 필수옵션 규칙 + 상품명 파싱 (캐시 미사용)
//   · 고시 11항목  : item_info (없으면 "상세페이지 참조")
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import os from "os";
import XLSX from "xlsx-js-style";
import { makePicker } from "./category-rules.mjs";
import { makeCoupangOptionLookup, buildOptionFor } from "./coupang-option-map.mjs";
import { loadClaimed } from "./claimed-barcodes.mjs";

const pickCategory = makePicker();
const coupangOpt = makeCoupangOptionLookup();
if (coupangOpt.missing.length) {
  console.error("[쿠팡 옵션] 연결 안 된 카테고리:", coupangOpt.missing.join(" / "));
  process.exit(1);
}

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const TARGET = process.argv[2] || "coupang";
const now0 = new Date();
const dateStr0 = `${String(now0.getFullYear()).slice(2)}${String(now0.getMonth() + 1).padStart(2, "0")}${String(now0.getDate()).padStart(2, "0")}`;
// --retry <플레이오토 작업결과 엑셀>  : 실패한 상품만 원래 판매자관리코드 그대로 재생성
const retryIdx = process.argv.indexOf("--retry");
// --altbarcode : 바코드가 겹치는 묶음수량 변형에 변형 GTIN을 부여해 등록을 시도한다.
//   ⚠️ GTIN-13 마지막 자리는 체크디짓이라 그 자리만 바꾸면 "형식 오류"가 된다.
//      → 상품참조번호(12번째 자리)를 올리고 체크디짓을 다시 계산해 형식만 유효하게 만든다.
//      실제 그 번호를 쓰는 다른 제품이 있을 수 있으므로 소량 테스트 후 판단할 것.
const ALT_BARCODE = process.argv.includes("--altbarcode");
const limitIdx = process.argv.indexOf("--limit");
const ROW_LIMIT = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
// 한 엑셀에 담을 최대 행수 (--chunk 200 처럼 조절, 0이면 나누지 않음)
const chunkIdx = process.argv.indexOf("--chunk");
const CHUNK_SIZE = chunkIdx > 0 ? Number(process.argv[chunkIdx + 1]) : 300;
// --onlyopt : 쿠팡에서 필수옵션을 못 만든 상품은 빼고 내보낸다 (반려 예정분 제외)
const ONLY_WITH_OPTION = process.argv.includes("--onlyopt");

/** GTIN-13 형식이 맞는지 — 13자리 숫자이고 체크디짓이 일치해야 한다 */
function isValidGtin13(b) {
  if (!/^\d{13}$/.test(b)) return false;
  return gtinCheckDigit(b.slice(0, 12)) === b[12];
}
function gtinCheckDigit(first12) {
  const sum = first12.split("").reduce((a, n, i) => a + Number(n) * (i % 2 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}
/** 같은 바코드를 쓰는 n번째 변형에 형식이 유효한 대체 GTIN을 만든다 (n=0이면 원본 그대로) */
function altGtin(barcode, n) {
  if (!barcode || barcode.length !== 13 || n === 0) return barcode;
  // 상품참조번호 끝 세 자리를 올린다. 한 자리만 쓰면 후보가 10개뿐이라 금방 동나 무한 루프에 빠진다.
  const head = barcode.slice(0, 9);
  const tail = (Number(barcode.slice(9, 12)) + n) % 1000;
  const first12 = head + String(tail).padStart(3, "0");
  return first12 + gtinCheckDigit(first12);
}
const RETRY_FILE = retryIdx > 0 ? process.argv[retryIdx + 1] : null;
let RETRY_MAP = null; // 상품명 -> 판매자관리코드
let RETRY_ROWS = null, RETRY_OLDCAT = null, RETRY_LABEL = "재시도", RETRY_BLOCKED = null;
let RETRY_USED_BARCODES = null; // 이미 등록에 성공해 쿠팡이 선점한 GTIN
const CLAIMED = loadClaimed();
const EMITTED_CODES = new Set();  // 재시도에서 같은 판매자관리코드를 두 번 내보내지 않기 위한 목록
const USED = new Set();          // 이번 생성에서 새로 배정한 바코드
const PLATFORMS = TARGET === "all" ? ["coupang", "smartstore", "gmarket_auction"] : [TARGET];

const PLATFORM_CONFIGS = {
  smartstore: { shopAccount: "스마트스토어=redgoom", templateCode: "2200901", headerFooter: "14672", rateKey: "smartstore", label: "스마트스토어", codeKey: "smartstore" },
  coupang: { shopAccount: "쿠팡=redgoom", templateCode: "2201570", headerFooter: "14672", rateKey: "coupang", label: "쿠팡", codeKey: "coupang" },
  gmarket_auction: { shopAccount: "옥션=redgoom00\n지마켓=redgoom00", templateCode: "2201548\n2201554", headerFooter: "14672\n14672", rateKey: "esm_5pct", label: "지마켓옥션", codeKey: "esm" },
};

if (RETRY_FILE) {
  const rwb = XLSX.readFile(RETRY_FILE);
  const rrows = XLSX.utils.sheet_to_json(rwb.Sheets[rwb.SheetNames[0]], { defval: "" });
  RETRY_MAP = new Map();
  // --recat : 등록은 성공했지만 카테고리가 바뀐 상품만 (플레이오토·쇼핑몰에서 삭제 후 재업로드용)
  const RECAT = process.argv.includes("--recat");
  // 결과 파일은 두 가지 형식이 온다.
  //   ① 플레이오토 엑셀업로드 결과 : "결과" + "온라인 상품명" + "카테고리코드" 포함
  //   ② 쇼핑몰 전송 작업결과       : "작업결과" + "판매자관리코드"만 → 직전 생성 엑셀에서 상품명을 찾는다
  const isJobResult = rrows.length > 0 && "작업결과" in rrows[0];
  let srcByCode = null;
  if (isJobResult) {
    const srcFile = path.join(os.homedir(), "Desktop", "상품등록", `플레이오토_${PLATFORM_CONFIGS[PLATFORMS[0]].label}_${dateStr0}.xlsx`);
    if (!fs.existsSync(srcFile)) {
      console.error(`[재시도] 작업결과 형식이라 원본 엑셀이 필요한데 없다: ${srcFile}`);
      process.exit(1);
    }
    const swb = XLSX.readFile(srcFile);
    srcByCode = new Map(XLSX.utils.sheet_to_json(swb.Sheets[swb.SheetNames[0]], { defval: "" })
      .map((r) => [String(r["판매자관리코드"]).trim(), r]));
  }
  const norm = (r) => isJobResult
    ? { ok: String(r["작업결과"]).trim() === "성공",
        name: String(srcByCode.get(String(r["판매자관리코드"]).trim())?.["온라인 상품명"] ?? "").trim(),
        code: String(r["판매자관리코드"]).trim(),
        cat: String(srcByCode.get(String(r["판매자관리코드"]).trim())?.["카테고리코드"] ?? "").trim() }
    : { ok: String(r["결과"]).trim() === "성공",
        name: String(r["온라인 상품명"]).trim(),
        code: String(r["판매자관리코드"]).trim(),
        cat: String(r["카테고리코드"]).trim() };
  const allNorm = rrows.map(norm).filter((r) => r.name);
  // 쿠팡은 GTIN(바코드)이 이미 등록된 상품과 겹치면 반려한다.
  // → 이번에 성공한 행이 선점한 바코드는 재시도해도 소용없으므로 대상에서 뺀다.
  // GTIN 중복 / UID 필수는 데이터를 못 구하면 재업로드해도 같은 사유로 반려된다 → 대상에서 뺀다
  if (!RECAT && isJobResult) {
    const msgByCode = new Map(rrows.map((r) => [String(r["판매자관리코드"]).trim(), String(r["결과메세지"] ?? "")]));
    // 이미 성공한 행이 그 바코드를 선점했으므로, 변형 GTIN은 1번부터 시작해야 한다
    RETRY_USED_BARCODES = new Map();
    allNorm.filter((r) => r.ok).forEach((r) => {
      const b = String(srcByCode.get(r.code)?.["바코드"] ?? "").trim();
      if (b) RETRY_USED_BARCODES.set(b, (RETRY_USED_BARCODES.get(b) ?? 0) + 1);
    });
    RETRY_BLOCKED = allNorm.filter((r) => !r.ok).map((r) => {
      const msg = msgByCode.get(r.code) ?? "";
      const bar = String(srcByCode.get(r.code)?.["바코드"] ?? "").trim();
      if (/GTIN\/MPN이 이미 등록된 상품과 중복/.test(msg)) {
        // 이 GTIN은 쿠팡에 이미 임자가 있다 → 변형 GTIN은 1번부터
        if (bar && !RETRY_USED_BARCODES.has(bar)) RETRY_USED_BARCODES.set(bar, 1);
        return ALT_BARCODE ? null : [r.name, `바코드 ${bar} 중복 (다른 용량과 같은 바코드)`];
      }
      if (/UID 항목 정보가 필수/.test(msg)) return [r.name, "바코드 없음 (쿠팡 UID 의무 브랜드)"];
      return null;
    }).filter(Boolean);
  }
  const blockedNames = new Set((RETRY_BLOCKED || []).map(([n]) => n));
  RETRY_ROWS = allNorm.filter((r) => r.ok === RECAT && !blockedNames.has(r.name));
  RETRY_ROWS.forEach((r) => RETRY_MAP.set(r.name, r.code));
  RETRY_OLDCAT = new Map(RETRY_ROWS.map((r) => [r.name, r.cat]));
  RETRY_LABEL = RECAT ? "카테고리교정" : "재시도";
  console.log(`[${RETRY_LABEL}] 대상 ${RETRY_MAP.size}건 (판매자관리코드 유지)`);
  if (RETRY_BLOCKED?.length) {
    console.log(`[${RETRY_LABEL}] 바코드 문제로 제외 ${RETRY_BLOCKED.length}건 — 재업로드해도 같은 사유로 반려된다`);
    RETRY_BLOCKED.forEach(([n, why]) => console.log(`      - ${n} : ${why}`));
  }
}

// 플레이오토 솔루션 카테고리코드 (이 계정에 실제 등록된 코드만 사용)
// 각 코드가 쿠팡의 어느 카테고리로 매핑되는지 확인 후 필수옵션을 결정한다.
const CAT = {
  콜라: "6373132",        // 탄산/청량음료 > 콜라
  사이다: "6373129",      // 탄산/청량음료 > 사이다
  탄산_과즙: "6373130",   // 탄산/청량음료 > 환타/웰치스/과즙탄산
  탄산수: "6373134",      // 탄산/청량음료 > 탄산수
  에이드: "6373126",      // 탄산/청량음료 > 에이드음료
  음료기타: "6373128",    // 탄산/청량음료 > 음료기타
  아이스티: "6373133",    // 탄산/청량음료 > 아이스티
  스포츠음료: "6373125",  // 탄산/청량음료 > 스포츠이온음료
  에너지음료: "6373127",  // 탄산/청량음료 > 에너지/비타민음료
  식혜: "6372991",        // 전통/건강음료 > 식혜/수정과
  주스: "6373065",        // 주스/과즙음료 > 주스/과즙음료
  두유_매일: "6372796",   // 두유 > 매일/삼육/한미전두유
  두유: "6372795",        // 두유 > 남양/연세/빙그레/기타
  캔커피: "6373110",      // 커피/코코아 > 캔커피/커피음료
  커피믹스: "6373107",    // 커피/코코아 > 일회용/자판기용커피믹스
  녹차티백: "6372754",    // 녹차/차음료/전통차 > 녹차 > 녹차티백
  차음료: "6372760",      // 녹차/차음료/전통차 > 옥수수수염차/헛개차
  즉석밥: "6373072",      // 즉석/카레/덮밥 > 즉석밥/누룽지
  라면: "6372933",        // 식자재 > 면류 > 라면 - 박스
  식초: "6373003",        // 조미료/소스/분말류 > 물엿/식초/액젓 > 식초
};

// 상품명 우선 매핑 (식품유형보다 정확하다 — 위에서부터 먼저 맞는 것 채택)
const NAME_TO_CATEGORY = [
  [/햇반|오뚜기밥|즉석밥|잡곡밥|현미밥|누룽지|큰밥/, CAT.즉석밥],
  [/라면|짜파게티|불닭|안성탕면|사발면|틈새|도시락|육개장|짜짜로니|너구리|왕뚜껑|짬뽕|비빔면|볶음면/, CAT.라면],
  [/식초/, CAT.식초],
  [/커피믹스|모카골드|카누|맥심/, CAT.커피믹스],
  [/레쓰비|칸타타|콘트라베이스|조지아|아이브루|맥스웰|바리스타|콜드브루|아메리카노|캔커피/, CAT.캔커피],
  [/오설록|녹차|티백|우롱/, CAT.녹차티백],
  [/매일두유/, CAT.두유_매일],
  [/두유|아몬드ㅤ?브리즈|아몬드 ?브리즈|베지밀|오트몬드|어메이징오트/, CAT.두유],
  [/포카리|게토레이|파워에이드|토레타|이온음료/, CAT.스포츠음료],
  [/핫식스|몬스터|에너지|박카스|오로나민|비타500/, CAT.에너지음료],
  [/아이스티|립톤/, CAT.아이스티],
  [/식혜|수정과/, CAT.식혜],
  [/트레비|씨그램|탄산수|페리에/, CAT.탄산수],
  [/콜라|펩시/, CAT.콜라],
  [/사이다|스프라이트|킨사이다/, CAT.사이다],
  [/환타|웰치스|오랑지나|써니텐|미린다|welch/i, CAT.탄산_과즙],
  [/에이드|데미소다/, CAT.에이드],
  [/주스|과즙|피크닉|델몬트|썬업|야채|토마토/, CAT.주스],
  [/밀키스|암바사|솔의눈/, CAT.음료기타],
  [/헛개|옥수수수염|보리차|마테/, CAT.차음료],
];

// 식약처 식품유형 → 카테고리 (상품명으로 못 정할 때)
const TYPE_TO_CATEGORY = [
  [/탄산수/, CAT.탄산수],
  [/탄산음료/, CAT.음료기타],
  [/커피|음료베이스/, CAT.캔커피],
  [/가공두유|두유/, CAT.두유],
  [/침출차|고형차/, CAT.녹차티백],
  [/액상차/, CAT.아이스티],
  [/과.?채음료|과.?채주스|과일음료/, CAT.주스],
  [/유탕면|건면|숙면|면류/, CAT.라면],
  [/즉석조리식품|즉석섭취식품/, CAT.즉석밥],
  [/발효식초|식초/, CAT.식초],
  [/혼합음료/, CAT.음료기타],
];
const CATEGORY_FALLBACK = CAT.음료기타;

// 품목고시 코드는 카테고리에 맞춰야 한다.
// 전부 21(가공식품)으로 보냈더니 샴푸가 "화장품/기타재화만 가능"으로 반려됐다.
const SCHEMA = { 가공식품: "21", 화장품: "18", 기타재화: "35" };
/** 배정된 카테고리로 품목고시 코드를 고른다 */
function schemaFor(categoryFull) {
  const c = String(categoryFull ?? "");
  if (/뷰티|샴푸|바디|화장품/.test(c)) return SCHEMA.화장품;
  if (/생활용품|세제\/제지|화장지|물티슈|생리대|패드|구강|기저귀|욕실/.test(c)) return SCHEMA.기타재화;
  return SCHEMA.가공식품;
}
const PLAYAUTO_SCHEMA_CODE = SCHEMA.가공식품;
const SALE_QUANTITY = 2000;

const strip = (v) => String(v ?? "").replace(/\s*\[검수필요[^\]]*\]/g, "").replace(/\(\s*\)/g, "").replace(/\s+\)/g, ")").replace(/\s{2,}/g, " ").trim();

/**
 * 카테고리는 scripts/category-rules.mjs 의 규칙을 쓴다.
 *
 * 예전에는 음료 20종짜리 표뿐이라 샴푸·우유·참치·생리대가 전부 "음료기타"로 떨어졌다.
 * 새 규칙은 계정에 실제 등록된 2,597개 중에서 고르고, 없는 경로면 오류로 멈춘다.
 */
function resolveCategoryCode(itemInfo, productName) {
  const hit = pickCategory(productName);
  if (hit) return hit.code;
  // 규칙에 안 걸리면 식약처 식품유형으로 한 번 더 시도한다
  const type = strip(itemInfo?.식품유형);
  for (const [re, code] of TYPE_TO_CATEGORY) if (re.test(type)) return code;
  return CATEGORY_FALLBACK;
}

/** 상품명에서 수량·용량 파싱 (lib/playauto-coupang-rules.ts와 동일 규칙) */
function parseSpec(productName) {
  const text = productName
    .replace(/(\d)\s*ML\b/g, "$1ml").replace(/(\d)\s*mL\b/g, "$1ml")
    .replace(/(\d)\s*G\b/g, "$1g").replace(/(\d)\s*KG\b/g, "$1kg");
  const counts = [...text.matchAll(/(\d+)\s*(개입|개|봉지|봉|캔|병|팩|입|박스|롤|매|장|포|갑|곽|세트|펫|페트|P|p|피스)/g)];
  const c = counts.at(-1);
  let quantity = c ? Number(c[1]) : 1;
  let unit = c?.[2] ?? "개";
  if (["봉", "캔", "병", "팩", "포", "갑", "곽", "봉지", "입", "펫", "페트"].includes(unit)) unit = "개";
  const units = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|ml|L)\b/g)];
  const u = units.at(-1);
  // 화장지·키친타올은 "30m 30롤 2팩"처럼 길이와 낱개 수가 따로 있다.
  // 쿠팡이 길이·개당 수량을 따로 요구하므로 전부 담아 둔다.
  const len = text.match(/(\d+(?:\.\d+)?)\s*[mM](?![lL가-힣])/);
  return {
    quantity, quantityUnit: unit,
    unitValue: u?.[1] ?? "", unitType: u?.[2] ?? "",
    counts: counts.map((m) => ({ n: Number(m[1]), unit: m[2] })),
    length: len ? `${len[1]}m` : "",
  };
}

/** 쿠팡 필수 구매옵션 — 카테고리별 성공 패턴 (AI 없이 상품명에서 계산) */
// 쿠팡 필수옵션 조합 3종:
//   음료류 → 총 수량 + 개당 용량   ex) [총 수량=개당 용량] 30개=210ml
//   즉석밥 → 총 수량 + 개당 중량
//   라면   → 총 수량 단독
//   소스/식초 → 수량 + 개당 용량
// 커피믹스·녹차티백은 쿠팡이 "최소 중량/개당 수량"을 요구해 자동 산출 불가 → 수동 등록
const VOLUME_CATS = [CAT.콜라, CAT.사이다, CAT.탄산_과즙, CAT.탄산수, CAT.에이드, CAT.음료기타,
  CAT.아이스티, CAT.스포츠음료, CAT.에너지음료, CAT.식혜, CAT.주스, CAT.두유, CAT.두유_매일,
  CAT.캔커피, CAT.차음료];
const QTY_VOLUME_CATS = [CAT.식초];
// 커피믹스·녹차티백: 쿠팡이 "최소 중량 + 개당 수량 + 수량"을 요구한다.
// 개당 중량은 상품명에 없으므로 item_info.개당중량("11.8g")이 있을 때만 산출한다.
const COUNT_WEIGHT_CATS = [CAT.커피믹스, CAT.녹차티백];
// 쿠팡은 카테고리마다 수량 단위 허용값이 다르다.
// 대부분 "30개"를 받지만 아래 카테고리는 "30개입"만 받는다 (2026-08 반려 확인).
const GAEIP_CATS = [CAT.에너지음료, CAT.녹차티백, CAT.커피믹스];

function buildCoupangOption(productName, categoryCode, itemInfo, categoryFull) {
  const s = { ...parseSpec(productName), name: productName };

  // 쿠팡 공식 정의에서 이 카테고리가 요구하는 옵션을 읽어 만든다
  const cat = categoryFull ? coupangOpt.lookup(categoryFull) : null;
  const fromOfficial = cat ? buildOptionFor(cat, s, itemInfo) : null;
  if (fromOfficial) {
    // 일부 카테고리는 수량 단위로 "개" 대신 "개입"만 받는다 (2026-08 반려 확인)
    if (GAEIP_CATS.includes(categoryCode)) {
      // 이 카테고리들은 "수량"과 "개당 수량" 모두 "개입" 단위만 받는다 (2026-08 반려 확인)
      // "총 수량"만 개입을 받는다. "수량"은 개·박스·세트만 받고, "개당 수량"은 이미 개입으로 넣는다.
      const names = fromOfficial.optionName.slice(1, -1).split("=");
      fromOfficial.optionValue = fromOfficial.optionValue.split("=")
        .map((v, i) => (names[i] === "총 수량" ? v.replace(/개$/, "개입") : v))
        .join("=");
    }
    return fromOfficial;
  }
  return { hasOption: false, optionName: "", optionValue: "" };
}

/**
 * 바코드가 없을 때 쓸 대체 식별자(MPN).
 * item_info에 품목보고번호가 여러 개 이어 붙어 있는 경우가 있어 첫 번째 하나만 쓴다.
 *   품목보고번호 = 14자리 숫자, 초록누리 신고번호 = "FB20-13-1714" 꼴
 */
function pickMpn(info) {
  const rep = String(info?.품목보고번호 ?? "").trim();
  const m = rep.match(/\d{14}/);
  if (m) return m[0];
  const dec = String(info?.신고번호 ?? "").trim().match(/[A-Z]{2}\d{2}-\d{2}-\d{3,6}/);
  if (dec) return dec[0];
  return "";
}

/** 모델명은 특수문자가 들어가면 쿠팡이 반려한다 → 한글/영문/숫자/공백만 남긴다 */
function cleanModel(name) {
  return String(name).replace(/[^가-힣a-zA-Z0-9\s]/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** 제조사는 판매원/제조원에서 추출 */
function resolveManufacturer(itemInfo, productName) {
  const seller = strip(itemInfo?.판매원).replace(/\((주|유|사)\)/g, "").replace(/주식회사/g, "").trim();
  if (seller) return seller;
  return productName.split(" ")[0];
}

/**
 * 브랜드는 소비자 브랜드 = 상품명 첫 단어. 제조사(판매원)를 넣으면 안 된다 —
 * 쿠팡이 "코카콜라음료(제조사) ≠ 코카콜라(브랜드)"를 잡아 브랜드 정보 수정 대상(319건, 2026-09-01 일괄 정정)이 됐다.
 */
function resolveBrand(productName) {
  return productName.split(" ")[0];
}

/**
 * 스마트스토어 단위가격에 쓸 "개당 용량"을 구한다.
 * ml·L은 ml로, g·kg은 g으로 맞춘다. 매·롤·P처럼 용량이 아닌 단위는 대상이 아니므로 null.
 * 이름에 없으면 조사해 둔 개당용량·개당중량에서 가져온다.
 */
function unitSize(productName, info) {
  const conv = (n, u) => {
    const v = u === "l" ? n * 1000 : u === "kg" ? n * 1000 : n;
    const unit = u === "ml" || u === "l" ? "ml" : "g";
    return v > 0 ? { value: Math.round(v), unit } : null;
  };
  const RE = /(\d+(?:\.\d+)?)\s*(ml|l|g|kg)(?=\s|$|\d)/i;
  const m = productName.match(RE);
  if (m) return conv(parseFloat(m[1]), m[2].toLowerCase());
  for (const k of ["개당용량", "개당중량"]) {
    const mm = String(info?.[k] ?? "").match(RE);
    if (mm) return conv(parseFloat(mm[1]), mm[2].toLowerCase());
  }
  return null;
}

/**
 * 고시 값은 품목고시 코드에 맞는 항목 순서로 넣어야 한다.
 *   21 가공식품 : 제품명·식품유형·생산자·소비기한·용량·원재료·영양성분·GMO·주의사항·수입여부·상담번호 (11)
 *   18 화장품   : 용량·제품주요사양·사용기한·사용방법·제조업자·제조국·주요성분·기능성·주의사항·품질보증·상담번호 (11)
 *   35 기타재화 : 품명및모델명·법에의한인증·제조국·제조자·상담번호 (5)
 * 전부 식품 서식으로 보냈더니 샴푸가 "가공식품 고시는 쓸 수 없다"로 반려됐다.
 */
function buildNoticeValues(itemInfo, productName, schemaCode) {
  const info = itemInfo && !itemInfo.스킵사유 ? itemInfo : {};
  const REF = "상세페이지 참조";
  const 상담 = strip(info.소비자상담번호) || REF;

  if (schemaCode === SCHEMA.화장품) {
    return [
      strip(info.중량용량) || strip(info.포장단위별용량) || REF,
      strip(info.품명및모델명) || strip(info.제품명) || productName,
      strip(info.사용기한) || "제품 별도 표시일까지",
      strip(info.사용방법) || REF,
      strip(info.제조회사) || strip(info.제조원) || REF,
      strip(info.제조국) || REF,
      strip(info.원료) || strip(info.원재료명) || REF,
      "해당없음",                                   // 기능성 화장품 여부
      strip(info.사용상주의사항) || REF,
      strip(info.품질보증기준) || "관련 법 및 소비자분쟁해결기준에 따름",
      상담,
    ];
  }
  if (schemaCode === SCHEMA.기타재화) {
    return [
      strip(info.품명및모델명) || strip(info.제품명) || productName,
      strip(info.인증허가) || "해당사항 없음",
      strip(info.제조국) || REF,
      strip(info.제조회사) || strip(info.제조원) || REF,
      상담,
    ];
  }
  const 수입 = strip(info.수입여부).startsWith("국내산") || !strip(info.수입여부) ? "N" : "Y";
  return [
    strip(info.제품명) || productName,
    strip(info.식품유형) || REF,
    strip(info.제조원) || REF,
    strip(info.소비기한) || "제품 별도 표시일까지",
    strip(info.포장단위별용량) || REF,
    strip(info.원재료명) || REF,
    strip(info.영양성분) || "제품 라벨 표기 참조",
    "N",                                          // 유전자변형식품 (Y/N만 허용)
    strip(info.소비자안전주의사항) || REF,
    수입,
    상담,
  ];
}

// ── 데이터 로드 ──
// Supabase는 한 번에 최대 1000행만 준다. 상품이 그보다 많으므로 나눠 받는다.
const products = [];
for (let offset = 0; ; offset += 500) {
  const { data, error } = await sb.from("products")
    .select("id, seller_code, product_name, lowest_price, margin_rate, category, thumbnail_url, detail_html, item_info, coupang_options, fixed_price_smartstore, fixed_price_esm, fixed_price_coupang")
    .eq("rebuild_status", "조사완료")
    .neq("registration_status", "판매중지")
    .order("sort_order").range(offset, offset + 499);
  if (error) { console.error("[playauto] 상품 조회 실패:", error.message); process.exit(1); }
  if (!data?.length) break;
  products.push(...data);
  if (data.length < 500) break;
}
const { data: rates } = await sb.from("commission_rates").select("category, platform, total_rate");

const rateMap = {};
rates.forEach((r) => { (rateMap[r.category] = rateMap[r.category] || {})[r.platform] = r.total_rate; });

const now = new Date();
const dateStr = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

// 기존 판매자관리코드와 겹치지 않게 시작 번호 계산
let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products").select("seller_code").not("seller_code", "is", null).range(from, from + 499);
  all.push(...data); if (data.length < 500) break; from += 500;
}
let maxSeq = 0;
let seqCursor = 0; // 플랫폼별로 이어서 증가 (같은 번호를 두 쇼핑몰에 쓰면 플레이오토가 거부)
all.forEach((r) => Object.values(r.seller_code || {}).forEach((c) => {
  if (typeof c === "string" && c.startsWith(dateStr)) {
    const n = parseInt(c.slice(6), 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
}));

seqCursor = maxSeq;

const outDir = path.join(os.homedir(), "Desktop", "상품등록");
fs.mkdirSync(outDir, { recursive: true });

for (const platform of PLATFORMS) {
  const cfg = PLATFORM_CONFIGS[platform];
  const isEsm = platform === "gmarket_auction";
  const rows = [];

  let targets = RETRY_MAP ? products.filter((p) => RETRY_MAP.has(p.product_name.trim())) : products;
  // 카테고리교정 모드에서는 실제로 카테고리가 달라진 상품만 남긴다
  if (RETRY_OLDCAT && process.argv.includes("--recat")) {
    targets = targets.filter((p) => resolveCategoryCode(p.item_info, p.product_name) !== RETRY_OLDCAT.get(p.product_name.trim()));
  }
  const skipped = [];
  const newCodes = [];
  const badBarcodes = [];
  const mpnUsed = [];
  const barcodeSeen = new Map(RETRY_USED_BARCODES ?? []);
  USED.clear();   // 마켓마다 같은 상품엔 같은 바코드가 가도록 초기화

  targets.forEach((p, i) => {
    const info = p.item_info;
    if (!p.thumbnail_url) { skipped.push([p.product_name, "썸네일 없음"]); return; }
    const settlement = p.margin_rate > 0 && p.margin_rate < 100
      ? Math.round(p.lowest_price / (1 - p.margin_rate / 100))
      : p.lowest_price;
    const fixed = platform === "coupang" ? p.fixed_price_coupang
      : platform === "smartstore" ? p.fixed_price_smartstore : p.fixed_price_esm;
    const rate = rateMap[p.category]?.[cfg.rateKey] ?? 0;
    const salePrice = fixed != null ? fixed
      : (rate > 0 && rate < 100 ? Math.ceil(settlement / (1 - rate / 100) / 100) * 100 : p.lowest_price);

    const sellerCode = RETRY_MAP ? RETRY_MAP.get(p.product_name.trim())
      : `${dateStr}${String(++seqCursor).padStart(3, "0")}`;
    // 재시도는 상품명으로 코드를 찾으므로, 이름이 같은 상품이 둘이면 코드가 겹친다.
    // 같은 판매자관리코드를 두 번 올리면 "이미 존재하는 상품"으로 반려되므로 한 번만 넣는다.
    if (RETRY_MAP) {
      if (EMITTED_CODES.has(sellerCode)) return;
      EMITTED_CODES.add(sellerCode);
    }
    newCodes.push([p.id, { ...(p.seller_code ?? {}), [cfg.codeKey]: sellerCode }]);
    const schemaCode = schemaFor(pickCategory(p.product_name)?.full);
    const notice = buildNoticeValues(info, p.product_name, schemaCode);
    let barcode = strip(info?.바코드);
    // 식약처 자료에 8자리·14자리나 체크디짓이 안 맞는 바코드가 섞여 있다.
    // 형식이 틀리면 쿠팡이 "바코드 형식 오류"로 반려하므로 아예 비운다.
    if (barcode && !isValidGtin13(barcode)) {
      badBarcodes.push([p.product_name, barcode]);
      barcode = "";
    }
    if (ALT_BARCODE && barcode) {
      // 같은 바코드를 쓰는 상품이 여럿이면 두 번째부터 변형 GTIN을 준다.
      // 이미 쿠팡에 등록되어 그 번호를 선점한 것도 건너뛴다(아니면 또 중복 반려).
      let n = barcodeSeen.get(barcode) ?? 0;
      let cand = altGtin(barcode, n);
      let tries = 0;
      while ((CLAIMED.has(cand) || USED.has(cand)) && tries < 1000) { n += 1; tries += 1; cand = altGtin(barcode, n); }
      if (tries >= 1000) {
        // 999개 변형이 전부 임자가 있으면 포기한다 (실제로는 일어나지 않는다)
        badBarcodes.push([p.product_name, `${barcode} 변형 후보 소진`]);
        barcode = "";
      } else {
        barcodeSeen.set(barcode, n + 1);
        USED.add(cand);
        barcode = cand;
      }
    }
    // 바코드가 없을 때 쓸 대체 식별자 (제조사가 부여받은 고유 번호)
    const mpn = barcode ? "" : pickMpn(info);
    if (mpn) mpnUsed.push([p.product_name, mpn]);
    const categoryCode = resolveCategoryCode(info, p.product_name);
    // 쿠팡은 필수 구매옵션이 있어야 등록됨 → 상품명에서 계산 (캐시 있으면 우선)
    // 캐시(coupang_options)는 과거 잘못된 카테고리 기준이라 쓰지 않고 항상 새로 계산한다
    const opt = platform === "coupang" ? buildCoupangOption(p.product_name, categoryCode, info, pickCategory(p.product_name)?.full) : null;
    const hasOpt = !!opt?.hasOption;

    const base = {
      판매자관리코드: sellerCode,
      카테고리코드: categoryCode,
      "쇼핑몰(계정)": cfg.shopAccount,
      템플릿코드: cfg.templateCode,
      "온라인 상품명": p.product_name,
      판매수량: SALE_QUANTITY,
      판매가: salePrice,
      공급가: 0, 원가: 0, 시중가: 0,
      옵션조합: hasOpt ? "조합형" : "옵션없음",
      옵션: hasOpt ? `${opt.optionName}\n${opt.optionValue}` : "",
      원산지: "기타=상세페이지참조",
      복수원산지여부: "N",
      과세여부: "과세",
      배송방법: "무료",
      배송비: 0,
      기본이미지: p.thumbnail_url ?? "",
      상세설명: p.detail_html ?? "",
      "머리말/꼬리말 템플릿코드": cfg.headerFooter,
      모델명: cleanModel(strip(info?.제품명) || p.product_name),
      브랜드: resolveBrand(p.product_name),
      제조사: resolveManufacturer(info, p.product_name),
      바코드: barcode,
      옵션바코드: barcode,                                  // 쿠팡 GTIN은 이 칸으로 전송됨
      표준상품코드: barcode ? `KAN=${barcode}` : "",
      // 쿠팡은 유명 브랜드에 UID(GTIN 또는 MPN)를 요구한다.
      // 바코드가 없으면 제조사가 부여받은 품목보고번호·신고번호를 모델번호(MPN)로 보낸다.
      // 쿠팡 GTIN이 "옵션바코드"로 가듯, MPN은 "옵션 모델번호"로 간다.
      모델번호: mpn,
      "옵션 모델번호": mpn,
      상품분류코드: schemaCode,
    };

    // 스마트스토어 단위가격 (2026-04 가격표시제)
    // 표시 용량은 1~999만 받는다. 예전에 표시 여부 N이면 0을 넣었는데
    // 플레이오토가 N이어도 값을 검사해서 124건이 반려됐다 → 안 쓰면 빈칸으로 둔다.
    if (platform === "smartstore") {
      const unit = unitSize(p.product_name, info);
      const cntM = p.product_name.match(/(\d+)\s*(개|팩|캔|병|입)(?=\s|$)/);
      const cnt = cntM ? parseInt(cntM[1], 10) : 1;
      Object.assign(base, {
        "단위 가격 표시 여부": unit ? "Y" : "N",
        "표시 용량": unit ? 100 : "",
        "표시 단위": unit ? unit.unit : "",
        "구성 방식": cnt > 1 ? "팩" : "낱개",
        "팩 수량": 1,
        "팩당 수량": cnt,
        "팩당 수량 단위": "개",
        "개당 용량": unit ? unit.value : "",
      });
    }

    notice.forEach((v, n) => { base[`상품정보제공고시${n + 1}`] = v; });

    if (isEsm) {
      rows.push({ ...base, "쇼핑몰(계정)": "옥션=redgoom00", 템플릿코드: "2201548", "머리말/꼬리말 템플릿코드": "14672" });
      rows.push({ ...base, "쇼핑몰(계정)": "지마켓=redgoom00", 템플릿코드: "2201554", "머리말/꼬리말 템플릿코드": "14672" });
    } else {
      rows.push(base);
    }
  });

  // 발급한 판매자관리코드를 DB에 남긴다 (다음 실행 때 번호 충돌 방지 + 쇼핑몰 상품 추적)
  if (!RETRY_MAP) {
    for (const [id, code] of newCodes) {
      const { error } = await sb.from("products").update({ seller_code: code }).eq("id", id);
      if (error) console.warn(`[코드저장] 실패 ${id}: ${error.message}`);
    }
    console.log(`  · 판매자관리코드 ${newCodes.length}건 DB 저장`);
  }

  let out = Number.isFinite(ROW_LIMIT) ? rows.slice(0, ROW_LIMIT) : rows;
  if (ONLY_WITH_OPTION && platform === "coupang") {
    const before = out.length;
    out = out.filter((r) => String(r["옵션"] ?? "").trim());
    console.log(`  · 옵션 없는 ${before - out.length}건 제외 (쿠팡 반려 예정분)`);
  }

  // 한 파일에 너무 많이 담으면 플레이오토 업로드가 버거우므로 나눠 저장한다.
  // --chunk 0 을 주면 나누지 않는다.
  const chunk = CHUNK_SIZE > 0 ? CHUNK_SIZE : out.length || 1;
  const parts = Math.ceil(out.length / chunk) || 1;
  for (let i = 0; i < parts; i++) {
    const slice = out.slice(i * chunk, (i + 1) * chunk);
    if (!slice.length) continue;
    const ws = XLSX.utils.json_to_sheet(slice);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "상품등록");
    const suffix = parts > 1 ? `_${i + 1}of${parts}` : "";
    const file = path.join(outDir, `플레이오토_${cfg.label}_${dateStr}${RETRY_MAP ? "_" + RETRY_LABEL : ""}${suffix}.xlsx`);
    XLSX.writeFile(wb, file);
    console.log(`생성: ${file}  (${slice.length}행)`);
  }
  const noOpt = out.filter((r) => r.옵션조합 === "옵션없음").map((r) => r["온라인 상품명"]);
  if (platform === "coupang" && noOpt.length) console.log(`  · 옵션 미산출 ${noOpt.length}건 (쿠팡 수동 등록 필요): ${noOpt.join(", ")}`);
  if (mpnUsed.length) console.log(`  · 바코드 대신 MPN(품목보고번호) 사용 ${mpnUsed.length}건`);
  if (badBarcodes.length) {
    console.log(`  · 바코드 형식 오류로 비움 ${badBarcodes.length}건: ${badBarcodes.slice(0, 5).map(([n, b]) => `${n}(${b})`).join(", ")}`);
  }
  if (skipped.length) {
    console.log(`  · 제외 ${skipped.length}건`);
    skipped.forEach(([n, why]) => console.log(`      - ${n} (${why})`));
  }
  if (!RETRY_MAP) {
    console.log(`  · 판매자관리코드 마지막 번호: ${dateStr}${String(seqCursor).padStart(3, "0")}`);
  }
}

console.log("※ Gemini API 호출 없음 (비용 0원)");
