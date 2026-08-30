// 초록누리(환경부 화학제품안전포털)에서 생활화학제품 고시정보를 긁어온다.
//
//   node scripts/ecolife-scrape.mjs --dry        매칭 결과만 출력
//   node scripts/ecolife-scrape.mjs              실제 저장 + 상세페이지 + PNG
//   node scripts/ecolife-scrape.mjs --max 20
//
// 대상: rebuild_status='대기' && category in (생활용품, 욕실/세탁, 물티슈) && 판매중지 아님
//
// 초록누리는 오픈API 신청이 번거로워 내부 JSON 엔드포인트를 그대로 쓴다.
//   목록  POST /ecolife/chemiProd/safeDclrProd/listJson   (pSearchType=PRDCT_NM, pSearchWord)
//   상세  POST /ecolife/chemiProd/safeDclrProd/detail     (DCLR_MST_ID, UNQ_NO)
// 세션 쿠키만 있으면 되고 로그인·인증키가 필요 없다.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DRY = process.argv.includes("--dry");
const MAX = arg("--max", Infinity);
const SELLER_PHONE = "010-6564-4459";
const TODAY = new Date().toISOString().slice(0, 10);

const BASE = "https://ecolife.mcee.go.kr";
const LIST_PAGE = `${BASE}/ecolife/chemiProd/safeDclrProd?pMENU_NO=596`;
let COOKIE = "";

async function openSession() {
  const r = await fetch(LIST_PAGE, { headers: { "User-Agent": "Mozilla/5.0" } });
  COOKIE = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  await r.text();
}

const HEADERS = () => ({
  "User-Agent": "Mozilla/5.0",
  "Content-Type": "application/x-www-form-urlencoded",
  Cookie: COOKIE,
  Referer: LIST_PAGE,
});

async function searchProducts(word, retry = 0) {
  try {
    const body = new URLSearchParams({
      pSearchType: "PRDCT_NM", pSearchWord: word, page: "1", pOrderby: "REG_DT", pSelectedLi: "",
    });
    const r = await fetch(`${BASE}/ecolife/chemiProd/safeDclrProd/listJson`, {
      method: "POST", headers: { ...HEADERS(), "X-Requested-With": "XMLHttpRequest" }, body,
    });
    const j = JSON.parse(await r.text());
    return j.list ?? [];
  } catch (e) {
    if (retry < 3) { await new Promise((s) => setTimeout(s, 1500 * (retry + 1))); await openSession(); return searchProducts(word, retry + 1); }
    return [];
  }
}

/** 상세 HTML을 "라벨 → 값" 사전으로 바꾼다 */
async function fetchDetail(id, unq, retry = 0) {
  try {
    const body = new URLSearchParams({
      DCLR_MST_ID: id, UNQ_NO: unq || "1", page: "1", pOrderby: "REG_DT",
      pSelectedLi: "", pSearchType: "PRDCT_NM", pSearchWord: "",
    });
    const r = await fetch(`${BASE}/ecolife/chemiProd/safeDclrProd/detail`, { method: "POST", headers: HEADERS(), body });
    const html = await r.text();
    if (html.length < 5000) throw new Error("상세 응답이 비정상");

    const parts = html
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .split("\n").map((s) => s.trim()).filter(Boolean);

    // 라벨 다음에 나오는 값들을 다음 라벨 전까지 모은다
    const LABELS = ["신고번호", "구분(제조/수입)", "업체", "제품명", "분류", "품목.용도", "제품제형",
      "유통기한", "중량·용량·매수·크기", "표준사용량", "제조국명, 제조회사", "사용방법",
      "사용상 주의사항", "응급처치", "액성", "어린이보호포장 대상"];
    const isLabel = (s) => LABELS.includes(s) || /^수입자,\s*주소, 연락처$/.test(s);
    const out = {};
    for (let i = 0; i < parts.length; i++) {
      const key = isLabel(parts[i]) ? (parts[i].startsWith("수입자") ? "수입자" : parts[i]) : null;
      if (!key || out[key]) continue;
      const vals = [];
      for (let j = i + 1; j < parts.length && !isLabel(parts[j]); j++) {
        if (/^(제품정보|물질정보|변경이력정보|목록|콘텐츠 만족도)/.test(parts[j])) break;
        vals.push(parts[j]);
        if (vals.length > 20) break;
      }
      out[key] = vals.join(" ");
    }
    return out;
  } catch (e) {
    if (retry < 3) { await new Promise((s) => setTimeout(s, 1500 * (retry + 1))); await openSession(); return fetchDetail(id, unq, retry + 1); }
    return null;
  }
}

// ── 이름 매칭 ────────────────────────────────────────
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
function coreName(name) {
  return name
    .replace(/\d+(\.\d+)?\s*(ml|mL|ML|l|L|g|kg|매|롤|P|p)(?=\s|$)/g, " ")
    .replace(/\d+\s*(개|팩|캔|병|입|봉|포|박스|세트|묶음)(?=\s|$)/g, " ")
    .replace(/\s+/g, " ").trim();
}
function bigrams(s) { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; }
function dice(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let c = 0; for (const g of A) if (B.has(g)) c++;
  return (2 * c) / (A.size + B.size);
}
// 포장·판촉 표현일 뿐 제품을 가르지 않는 말
const NOISE_WORDS = ["겸용", "용기", "말통", "본품", "증정", "기획", "행사", "묶음", "세트"];
// 초록누리 제품명에는 흔히 빠지는 총칭 (상품명에만 붙는 말)
const GENERIC_WORDS = ["액체세제", "세탁세제", "섬유유연제", "주방세제", "세제", "탈취제", "표백제",
  "캡슐세제", "일반", "드럼", "리필", "대용량", "고농축", "초고농축"];
// "액체세탁세제"처럼 총칭이 한 덩어리로 붙은 경우를 위해 조각 단위로도 지운다
const GENERIC_PARTS = ["액체", "가루", "분말", "세탁", "세제", "섬유유연제", "유연제", "주방",
  "탈취제", "표백제", "캡슐", "일반", "드럼", "겸용", "리필", "용기", "대용량", "고농축", "초고농축"];
/**
 * 상품명으로 짐작되는 초록누리 품목. 못 짐작하면 null(= 품목 검사 안 함).
 *
 * 신고번호 가운데 자리가 품목 코드다(-05- 섬유유연제, -12- 방향제, -13- 탈취제…).
 * 이름만 보고 고르면 "피죤 옐로미모사 섬유유연제"에 방향제 신고번호가 붙는다.
 */
function expectedItem(name) {
  if (/섬유유연제|유연제|드라이시트|건조기시트/.test(name)) return ["섬유유연제"];
  if (/세탁세제|액체세제|가루세제|캡슐세제|세탁|액체비트|찌든때/.test(name)) return ["세탁세제", "표백제"];
  if (/탈취|냄새제거|방향제|디퓨저/.test(name)) return ["탈취제", "방향제"];
  if (/표백|과탄산|유한젠/.test(name)) return ["표백제", "세탁세제"];
  if (/락스|곰팡이|세정|클리너|변기|배수관|살균|욕실|물때/.test(name)) return ["세정제", "살균제", "표백제", "제거제"];
  if (/습기제거|제습/.test(name)) return ["습기제거제"];
  return null;
}

// 제형 — 이게 다르면 아예 다른 제품이라 총칭처럼 지워선 안 된다
const FORM_WORDS = ["캡슐", "시트", "분말", "가루", "스프레이", "티슈", "고체"];
/** 총칭 조각을 걷어낸 알맹이 단어. 통째로 총칭이면 빈 문자열(= 판단에서 제외) */
function stripGeneric(token) {
  let t = token;
  for (const g of GENERIC_PARTS) t = t.split(g).join("");
  return t;
}

/**
 * 상품명이 후보 제품명과 얼마나 맞는지 0~1.
 *
 * 초록누리는 브랜드가 다른데 뒷말만 같은 제품이 수두룩하다
 * ("피죤 핑크로즈" ↔ "차칸 섬유유연제 핑크로즈", "샤프란 소프트코튼" ↔ "아이린 소프트코튼").
 * 그래서 상품명의 모든 단어가 후보 안에 있어야만 점수를 준다.
 */
function score(core, candidate) {
  const b = norm(candidate);
  const raw = core.split(/\s+/).map(norm).filter((t) => t.length >= 2 && !NOISE_WORDS.includes(t));
  if (!raw.length) return 0;
  // 브랜드(첫 단어)는 반드시 맞아야 한다 — 이게 없으면 피죤이 차칸으로 붙는다
  if (!b.includes(raw[0])) return 0;
  // 제형이 다르면 다른 제품이다 (액체세제 ↔ 캡슐세제, 스프레이 ↔ 폼스프레이).
  // 총칭 제거 과정에서 이 구분이 지워지므로 원문끼리 따로 대조한다.
  const a = norm(core);
  for (const f of FORM_WORDS) if (a.includes(f) !== b.includes(f)) return 0;
  // 총칭(섬유유연제 등)은 초록누리 이름에 없는 경우가 많아 필수에서 뺀다
  const must = raw.slice(1).filter((t) => !GENERIC_WORDS.includes(t)).map(stripGeneric)
    .filter((t) => t.length >= 2 && !GENERIC_WORDS.includes(t));
  // 나머지 단어는 전부가 아니라 "얼마나 겹치는가"로 본다.
  // 상품명에는 초록누리 등록명에 없는 수식어가 늘 붙기 때문에
  // (예: "다우니 섬유유연제 퍼퓸 블랙 미스티크 향" ↔ 등록명 "다우니 퍼퓸 블랙미스티크")
  // 전부 일치를 요구하면 대형 브랜드가 통째로 떨어져 나간다.
  // 브랜드 외에 구별할 단어가 하나도 없으면("피죤 섬유유연제 2500ml") 특정할 방법이 없다.
  // 이때 점수를 주면 형제 제품 중 아무거나 찍게 되므로 아예 후보로 삼지 않는다.
  if (!must.length) return 0;
  const cover = must.filter((t) => b.includes(t)).length / must.length;
  // 한 단어라도 빠지면 다른 제품일 가능성이 크다
  // ("락스와세제 폼스프레이" ↔ "락스와 세제 스프레이"는 서로 다른 품목).
  if (cover < 0.8) return 0;
  return 0.6 * cover + 0.4 * dice(norm(core.replace(/\s+/g, "")), b);
}

/**
 * 후보 이름에만 있고 상품명에는 없는 단어 수.
 *
 * "비트 딥클린파워 드럼용"에 대해
 *   "비트 딥클린 파워(POWER)(드럼용)"      → 0 (군더더기 없음)
 *   "비트 딥클린파워(Power)플러스(겸용)"   → 1 ('플러스')
 * 둘 다 점수는 비슷하지만 앞엣것이 맞다. 군더더기가 가장 적은 쪽을 고른다.
 */
function extraTokens(core, candidate) {
  const mine = norm(core);
  return String(candidate).split(/[\s()[\]/·,]+/).map(norm).map(stripGeneric)
    .filter((t) => t.length >= 2 && !/^[a-z]+$/.test(t))
    .filter((t) => !mine.includes(t)).length;
}

/** 제조사 카탈로그 캐시 — 있으면 검색 대신 이걸 통째로 대조한다 */
const CATALOG = (() => {
  const f = "scripts/output/ecolife-catalog.json";
  if (!fs.existsSync(f)) return [];
  try {
    return Object.values(JSON.parse(fs.readFileSync(f, "utf8"))).flat()
      .map((r) => ({ PRDCT_NM: r.nm, ITEM_NM: r.item, CONM_NM: r.co, APRV_NO: r.aprv, DCLR_MST_ID: r.id, UNQ_NO: r.unq, FMTN_NM: r.fmtn }));
  } catch { return []; }
})();
/** 검색어 변형 — 초록누리는 제품명이 짧아 뒤쪽 수식어를 떼며 시도한다 */
function makeQueries(name) {
  const t = coreName(name).split(/\s+/).filter(Boolean);
  const q = new Set();
  for (let end = t.length; end >= 1; end--) q.add(t.slice(0, end).join(" "));
  if (t.length > 1) q.add(t.slice(1).join(" "));
  return [...q].filter((x) => x.length >= 2).slice(0, 6);
}

// ── 상세페이지 HTML (다른 스크립트와 동일한 표) ────────
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const stripInternalTags = (v) => String(v).replace(/\s*\[검수필요[^\]]*\]/g, "").replace(/\s{2,}/g, " ").trim();
const DISPLAY_FIELDS = [
  ["품명및모델명", "품명 및 모델명"], ["제품분류", "제품 분류"], ["용도", "용도"], ["제형", "제형"],
  ["중량용량", "중량·용량"], ["제조국", "제조국"], ["제조회사", "제조회사"], ["수입자", "수입자"],
  ["인증허가", "법에 의한 인증·허가 등"], ["표준사용량", "표준 사용량"], ["사용방법", "사용방법"],
  ["사용상주의사항", "사용상 주의사항"], ["응급처치", "응급처치"], ["유통기한", "유통기한"],
  ["품질보증기준", "품질보증기준"], ["소비자상담번호", "소비자상담 관련 전화번호"],
];
function buildDetailHtml(productName, thumbnailUrl, info) {
  if (!info || info.스킵사유) return null;
  const rows = DISPLAY_FIELDS.map(([k, label]) => {
    const v = stripInternalTags(info[k] ?? "");
    if (!v) return null;
    return `<tr>
      <td style="padding:10px 16px;background:#f8f8f8;font-weight:bold;border:1px solid #e0e0e0;width:160px;vertical-align:top;white-space:nowrap;word-break:keep-all;">${escapeHtml(label)}</td>
      <td style="padding:10px 16px;border:1px solid #e0e0e0;vertical-align:top;line-height:1.8;">${escapeHtml(v)}</td>
    </tr>`;
  }).filter(Boolean);
  if (!rows.length) return null;
  const safeName = escapeHtml(productName);
  const thumbHtml = thumbnailUrl
    ? `<div style="text-align:center;padding:20px 0;">
    <img src="${escapeHtml(thumbnailUrl)}" alt="${safeName}" style="max-width:800px;width:100%;height:auto;display:block;margin:0 auto;">
  </div>` : "";
  return `<div style="max-width:1000px;margin:0 auto;font-family:'맑은 고딕',sans-serif;font-size:14px;color:#333;background:#fff;">
  <div style="background:#222;color:#fff;padding:16px 20px;text-align:center;">
    <h2 style="margin:0;font-size:18px;font-weight:bold;">${safeName}</h2>
  </div>
  ${thumbHtml}
  <div style="padding:20px;">
    <h3 style="font-size:15px;border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:0;">상품정보제공고시</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${rows.join("\n")}
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#777;line-height:1.7;">
      · 위 정보는 환경부 화학제품안전포털(초록누리) 안전확인대상 생활화학제품 신고자료를 기준으로 작성되었습니다.<br>
      · 제조사 사정에 따라 성분·포장이 변경될 수 있으므로 실제 제품 표기사항을 확인해 주세요.
    </p>
  </div>
</div>`;
}
async function toDataUri(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return `data:${res.headers.get("content-type") || "image/jpeg"};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch { return null; }
}

function extractSize(name) {
  const v = name.match(/\d+(\.\d+)?\s*(ml|mL|ML|L|l|g|kg)/i);
  const c = name.match(/(\d+)\s*(개|팩|롤|매|입|P|p)/);
  if (v && c) return `${v[0].replace(/\s/g, "")} x ${c[1]}${c[2]}`;
  return v ? v[0].replace(/\s/g, "") : (c ? `${c[1]}${c[2]}` : "");
}

// ── 실행 ──────────────────────────────────────────────
await openSession();

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, user_id, product_name, thumbnail_url, item_info")
    .eq("rebuild_status", "대기")
    .in("category", ["생활용품", "욕실/세탁(세제샴푸등)", "물티슈"])
    .neq("registration_status", "판매중지")
    .order("sort_order").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
// 아직 손대지 않은 것 + 지난 회차에 보류로 남은 것(재시도대상)
all = all.filter((p) => !p.item_info || p.item_info.재시도대상);
const targets = all.slice(0, Number.isFinite(MAX) ? MAX : undefined);
console.log(`[ecolife] 대상 ${targets.length}개 (전체 대기 ${all.length})`);

const browser = DRY ? null : await chromium.launch({ headless: true });
let ok = 0, skip = 0;

for (const p of targets) {
  const core = coreName(p.product_name);
  let hits = [];
  // 유통사(쿠팡 등) 신고보다 제조사 신고를 우선한다
  const consider = (r) => {
    const sc = score(core, r.PRDCT_NM);
    if (sc < 0.7) return;
    // 품목이 어긋나면 이름이 비슷해도 다른 제품이다
    const want = expectedItem(p.product_name);
    if (want && r.ITEM_NM && !want.includes(r.ITEM_NM)) return;
    const bonus = /쿠팡|이마트|홈플러스|롯데쇼핑|지에스|코스트코/.test(r.CONM_NM ?? "") ? -0.05 : 0;
    hits.push({ sc: sc + bonus, raw: sc, extra: extraTokens(core, r.PRDCT_NM), r });
  };

  if (CATALOG.length) {
    // 검색은 연속 문자열만 맞아서 놓치는 게 많다. 카탈로그가 있으면 전량 대조한다.
    for (const r of CATALOG) consider(r);
  }
  if (!hits.length) {
    for (const q of makeQueries(p.product_name)) {
      const rows = await searchProducts(q);
      await new Promise((s) => setTimeout(s, 300));
      if (!rows.length) continue;
      for (const r of rows) consider(r);
      if (hits.length) break;
    }
  }
  // 점수가 비슷하면 군더더기가 적은 쪽을 앞에 둔다
  hits.sort((a, b) => (b.sc - a.sc) || (a.extra - b.extra));

  // 향·종류만 다른 형제 제품이 신고번호까지 다른 경우가 많다
  // (아우라 실내건조: 체리블라썸 FB20-05-0031 / 윌유메리미 FB22-05-0070).
  // 상품명에 향이 안 적혀 있으면 어느 쪽인지 알 수 없으므로 찍지 말고 보류한다.
  const contenders = hits.filter((h) => h.sc >= (hits[0]?.sc ?? 0) - 0.08);
  // 다만 군더더기 없는 후보가 하나뿐이면 그건 모호가 아니라 정답이다
  const minExtra = Math.min(...contenders.map((h) => h.extra));
  const near = contenders.filter((h) => h.extra === minExtra);
  const ambiguous = new Set(near.map((h) => h.r.APRV_NO)).size > 1;
  const best = near[0];

  if (!best || ambiguous) {
    skip++;
    const why = ambiguous
      ? `초록누리 후보 ${near.length}건이 신고번호가 서로 달라 특정 불가 (${[...new Set(near.slice(0, 3).map((h) => h.r.PRDCT_NM))].join(" / ")}) [검수필요-수동조사]`
      : "초록누리 미등록 — 공산품이거나 이름이 달라 못 찾음 [검수필요-수동조사]";
    console.log(`  · 보류 ${p.product_name} — ${ambiguous ? "후보 여럿(신고번호 상이)" : "초록누리 미등록"}`);
    if (!DRY) await sb.from("products").update({ item_info: { 스킵사유: why, 재시도대상: true } }).eq("id", p.id);
    continue;
  }

  const d = await fetchDetail(best.r.DCLR_MST_ID, best.r.UNQ_NO);
  await new Promise((s) => setTimeout(s, 300));
  const 제조 = (d?.["제조국명, 제조회사"] ?? "").split(",");
  const info = {
    품목군: "생활화학제품",
    // 신고번호가 같은 형제 제품이 여럿이면(향만 다른 경우) 어느 향인지 단정할 수 없다.
    // 신고번호는 어느 쪽이든 같으므로 쓰되, 품명에는 확인 안 된 향 이름을 적지 않는다.
    품명및모델명: near.length > 1 ? p.product_name : best.r.PRDCT_NM,
    제품분류: d?.분류 || best.r.ITEM_NM || "",
    용도: d?.["품목.용도"] || best.r.ITEM_NM || "",
    제형: d?.제품제형 || best.r.FMTN_NM || "",
    중량용량: extractSize(p.product_name) || d?.["중량·용량·매수·크기"] || "",
    제조국: 제조[0]?.trim() || "",
    제조회사: 제조.slice(1).join(",").trim() || best.r.CONM_NM || "",
    수입자: d?.수입자 || "",
    인증허가: `안전확인대상 생활화학제품 신고번호 ${best.r.APRV_NO}`,
    표준사용량: d?.표준사용량 && d.표준사용량 !== "해당없음" ? d.표준사용량 : "",
    사용방법: d?.사용방법 && d.사용방법 !== "해당없음" ? d.사용방법 : "",
    사용상주의사항: d?.["사용상 주의사항"] ?? "",
    응급처치: d?.응급처치 ?? "",
    유통기한: d?.유통기한 && d.유통기한 !== "해당없음" ? d.유통기한 : "제품 별도 표시일까지",
    품질보증기준: "관련 법 및 소비자분쟁해결기준에 따름",
    소비자상담번호: SELLER_PHONE,
    신고번호: best.r.APRV_NO,
    출처: `환경부 화학제품안전포털(초록누리) 안전확인대상 생활화학제품 신고, ${TODAY} 조회`,
    자동매칭점수: best.raw.toFixed(2),
  };

  console.log(`  ✓ ${p.product_name} → ${best.r.PRDCT_NM} (${best.raw.toFixed(2)}) ${best.r.APRV_NO}`);
  ok++;
  if (DRY) continue;

  const html = buildDetailHtml(p.product_name, p.thumbnail_url, info);
  await sb.from("products").update(html ? { item_info: info, rebuild_status: "조사완료", detail_html: html } : { item_info: info, rebuild_status: "조사완료" }).eq("id", p.id);

  if (html && browser) {
    try {
      let capture = html;
      if (p.thumbnail_url) {
        const uri = await toDataUri(p.thumbnail_url);
        if (uri) capture = capture.split(p.thumbnail_url).join(uri);
      }
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const page = await ctx.newPage();
      await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;}</style></head><body>${capture}</body></html>`, { waitUntil: "load" });
      const h = await page.evaluate(() => document.body.scrollHeight);
      await page.setViewportSize({ width: 1000, height: Math.max(h, 100) });
      const shot = await page.screenshot({ fullPage: true, type: "png" });
      await ctx.close();
      const sp = `products/${p.user_id}/ai_detail_${Date.now()}_${p.id.slice(0, 8)}.png`;
      await sb.storage.from("product-images").upload(sp, shot, { contentType: "image/png", upsert: true });
      const { data: { publicUrl } } = sb.storage.from("product-images").getPublicUrl(sp);
      await sb.from("products").update({ detail_image_url: publicUrl }).eq("id", p.id);
    } catch (e) {
      console.log(`    (렌더 실패: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

if (browser) await browser.close();
console.log(`\n[ecolife] 완료 — 매칭 ${ok} / 보류 ${skip}`);
