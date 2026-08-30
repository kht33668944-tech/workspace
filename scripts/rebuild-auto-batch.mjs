// 상품 재정비 무인 배치 — 식약처 조사 → item_info → 상세페이지 HTML → PNG 렌더까지 한 번에.
//
//   node scripts/rebuild-auto-batch.mjs            전부 (대기 소진까지)
//   node scripts/rebuild-auto-batch.mjs --max 100  100개만
//   node scripts/rebuild-auto-batch.mjs --batch 20 배치 크기(기본 30)
//   node scripts/rebuild-auto-batch.mjs --no-render  PNG 렌더 생략
//
// 대상: rebuild_status='대기' && category='가공식품' && item_info 없음 && 판매중지 아님
//
// 기존 mfds-batch-apply*.mjs는 Claude가 후보를 손으로 골라야 했다.
// 이 스크립트는 이름 유사도로 자동 판별하고, 확신이 없으면 건드리지 않고
// item_info에 [검수필요-수동조사] 사유만 남겨 다음 실행 때 다시 잡히지 않게 한다.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const KEY = get("MFDS_API_KEY");
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const MAX = arg("--max", Infinity);
const BATCH = arg("--batch", 30);
const RENDER = !process.argv.includes("--no-render") && !process.argv.includes("--dry");
const DRY = process.argv.includes("--dry"); // DB를 건드리지 않고 매칭 결과만 출력

const SELLER_PHONE = "010-6564-4459";

// ── 로컬 캐시(mfds-bulk-download.mjs 결과) ────────────
// 캐시가 있으면 API를 아예 쓰지 않는다 → 하루 1,000회 제한과 무관하게 전량 처리 가능
const CACHE_DIR = "scripts/output";
function loadCache(name) {
  const f = `${CACHE_DIR}/mfds-${name}.json`;
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const C002 = loadCache("C002");   // 가공식품 — 제품명·식품유형·업소·보고번호·소비기한·원재료
const C005 = loadCache("C005");   // 바코드연계 — 위 + 바코드·소재지 (원재료 없음)
const C006 = loadCache("C006");   // 축산물(우유·가공유·포장육) — 원재료가 한 줄에 하나씩
const C003 = loadCache("C003");   // 건강기능식품
const OFFLINE = !!(C002 || C005 || C006 || C003);
if (OFFLINE) {
  console.log(`[auto] 로컬 캐시 — C002 ${(C002?.length ?? 0).toLocaleString()} / C005 ${(C005?.length ?? 0).toLocaleString()} / C006 ${(C006?.length ?? 0).toLocaleString()} / C003 ${(C003?.length ?? 0).toLocaleString()} (API 호출 없음)`);
}
const byName = new Map();         // 정규화 제품명 → 행들
const barByReport = new Map();    // 품목보고번호 → 바코드들
const rawByReport = new Map();    // 품목보고번호 → 원재료명

const TODAY = new Date().toISOString().slice(0, 10);

// 식약처가 아닌 다른 기관 소관이라 C002로는 못 채우는 것들
const SKIP_RULES = [
  { re: /삼다수|아이시스|생수|먹는샘물|백산수/, 사유: "먹는샘물 — 환경부 소관, 식약처 C002 미등록 [검수필요-환경부]" },
  { re: /\d+종\s*세트|선물세트|모음전|골라담기/, 사유: "세트상품 — 구성품별 개별 표기 필요 [검수필요-세트상품]" },
];

// ── 이름 정규화·유사도 ────────────────────────────────
const norm = (s) => String(s ?? "")
  .toLowerCase()
  .replace(/[()[\]{}<>·・,.\-_/\\'"!?+*&#%~^`|:;]/g, "")
  .replace(/\s+/g, "");

/** 상품명에서 용량·수량·포장 토큰을 걷어낸 "핵심 이름" */
function coreName(name) {
  return name
    .replace(/\d+(\.\d+)?\s*(ml|mL|ML|l|L|g|kg|Kg|KG)(?=\s|$)/g, " ")
    .replace(/\d+\s*(개|팩|캔|병|입|봉|매|포|박스|세트|묶음|스틱|정|환|구|장|펫|페트|롤|캅셀)(?=\s|$)/g, " ")
    .replace(/(^|\s)x\s*\d+(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeVariants(name) {
  const cleaned = coreName(name);
  const tokens = cleaned.split(" ").filter(Boolean);
  const v = new Set();
  if (tokens.length) {
    v.add(tokens.join(""));
    v.add(cleaned);
    if (tokens.length > 1) {
      v.add(tokens.slice(1).join(""));
      v.add(tokens.slice(0, -1).join(""));
      v.add(tokens[0] + tokens[1]);
    }
    v.add(tokens[0]);
  }
  return [...v].filter((x) => x.length >= 2);
}

// 제품을 가르는 수식어. 한쪽에만 있으면 다른 제품이다 (제로 ↔ 일반).
// 주의: 긴 것을 먼저 두면 "제로제로"가 "제로"에 묻히지 않는다 (둘 다 includes로 검사하므로 순서와 무관하지만 의미상 함께 둔다)
const VARIANT_WORDS = ["제로제로", "무카페인", "제로", "라이트", "저칼로리", "무설탕", "무가당", "디카페인", "저카페인",
  "고단백", "프로틴", "저지방", "무지방", "유기농", "오리지널", "스위트", "블랙", "라떼", "마일드",
  "매운", "순한", "쿨", "핫", "차가운", "따뜻한", "다이어트", "미니", "라지", "대용량"];
// 포장·표기 차이일 뿐 제품이 달라지지 않는 말
const NOISE_WORDS = ["무라벨", "에코", "리뉴얼", "신제품", "정품", "국내산", "박스", "묶음", "드링크"];

/** 두 글자씩 잘라 겹치는 비율(다이스 계수)로 이름 유사도를 잰다 */
function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function dice(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  return (2 * common) / (A.size + B.size);
}

/**
 * 후보 제품명이 상품명과 얼마나 맞는지 0~1로 점수화.
 *
 * ① 제로·디카페인 같은 수식어가 한쪽에만 있으면 즉시 탈락 (다른 제품이다)
 * ② 상품명 앞쪽 브랜드 토큰은 식약처 제품명에 없는 경우가 많으므로,
 *    앞 토큰을 하나씩 떼어낸 꼬리들 중 가장 잘 맞는 것으로 점수를 낸다.
 *      "롯데칠성음료 칠성사이다" → "칠성사이다"가 후보와 완전 일치
 * ③ 그래도 "포카리스웨트" ↔ "포카리스웨트 이온워터"처럼 후보가 더 구체적이면
 *    다이스 계수가 떨어져 임계값(0.7)에서 걸러진다.
 */
function similarity(core, candidate) {
  const b = norm(candidate);
  if (!b) return 0;
  const a = norm(core);
  if (!a) return 0;

  for (const w of VARIANT_WORDS) {
    if (a.includes(w) !== b.includes(w)) return 0;
  }

  // ④ 후보에만 있는 낯선 단어가 있으면 다른 제품이다 ("포카리스웨트" ↔ "포카리스웨트 이온워터")
  const coreTokens = core.split(/\s+/).map(norm).filter((t) => t.length >= 2);
  const candTokens = String(candidate).split(/\s+/).map(norm).filter((t) => t.length >= 2);
  const overlaps = (t) => coreTokens.some((c) => c.includes(t) || t.includes(c));
  if (!candTokens.every(overlaps)) return 0;

  const tokens = core.split(/\s+/).filter(Boolean);
  let best = 0;
  for (let i = 0; i < tokens.length; i++) {
    const suffix = norm(tokens.slice(i).join(""));
    if (suffix.length < 2) break;
    best = Math.max(best, dice(suffix, b));
  }
  return best;
}

// ── 식약처 API ────────────────────────────────────────
// 캐시 인덱스 구축 (norm 정의 이후여야 한다)
if (OFFLINE) {
  // 두 자료를 품목보고번호 기준으로 합친다. 같은 보고번호가 양쪽에 있으면 정보가 서로를 채운다.
  const merged = new Map(); // 보고번호+제품명 → 레코드
  const put = (r) => {
    const k = `${r.no}|${r.nm}`;
    const cur = merged.get(k) ?? { nm: r.nm, no: r.no };
    merged.set(k, {
      ...cur,
      dc: cur.dc || r.dc || "",
      bssh: cur.bssh || r.bssh || "",
      pog: cur.pog || r.pog || "",
      // C006(축산물)은 원재료가 한 줄에 하나씩 나뉘어 오므로 이어붙인다
      raw: cur.raw && r.raw && !cur.raw.includes(r.raw) ? `${cur.raw}, ${r.raw}` : (cur.raw || r.raw || ""),
      bar: cur.bar || r.bar || "",
      site: cur.site || r.site || "",
    });
  };
  for (const r of C002 ?? []) put(r);
  for (const r of C005 ?? []) put(r);
  for (const r of C006 ?? []) put(r);
  for (const r of C003 ?? []) put(r);

  for (const r of merged.values()) {
    const k = norm(r.nm);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
    if (r.bar) {
      if (!barByReport.has(r.no)) barByReport.set(r.no, []);
      barByReport.get(r.no).push(r.bar);
    }
    if (r.raw && !rawByReport.has(r.no)) rawByReport.set(r.no, r.raw);
  }
  console.log(`[auto] 인덱스 완료 — 고유 제품명 ${byName.size.toLocaleString()}개, 바코드 보유 ${barByReport.size.toLocaleString()}건`);
}

/** 식약처 오픈API 일일 호출한도(INFO-300)에 걸리면 자정(KST) 리셋까지 기다린다 */
async function waitForQuotaReset() {
  const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
  const nextKst = new Date(nowKst);
  nextKst.setUTCHours(0, 5, 0, 0);
  if (nextKst <= nowKst) nextKst.setUTCDate(nextKst.getUTCDate() + 1);
  const waitMs = nextKst - nowKst;
  const until = new Date(Date.now() + waitMs);
  console.log(`
[auto] 식약처 일일 호출한도 소진 — ${until.toLocaleString("ko-KR")}까지 ${(waitMs / 3600000).toFixed(1)}시간 대기 후 자동 재개`);
  // 30분마다 살아있음을 알린다
  const step = 30 * 60 * 1000;
  for (let left = waitMs; left > 0; left -= step) {
    await new Promise((s) => setTimeout(s, Math.min(step, left)));
    if (left > step) console.log(`[auto] 대기 중… 남은 시간 ${((left - step) / 3600000).toFixed(1)}시간`);
  }
  console.log("[auto] 한도 리셋 — 재개");
}

async function mfds(service, query, retry = 0) {
  const url = `http://openapi.foodsafetykorea.go.kr/api/${KEY}/${service}/json/1/50/${query}`;
  try {
    const r = await fetch(url);
    const j = JSON.parse(await r.text());
    const code = j[service]?.RESULT?.CODE;
    // 인증키 동시접속 1개 제한 → 대기 후 재시도
    if (code === "INFO-500" && retry < 6) {
      await new Promise((s) => setTimeout(s, 1500 * (retry + 1)));
      return mfds(service, query, retry + 1);
    }
    // 일일 호출한도 초과 → 자정까지 기다렸다가 같은 요청을 다시 보낸다
    if (code === "INFO-300") {
      await waitForQuotaReset();
      return mfds(service, query, 0);
    }
    return j[service]?.row || [];
  } catch {
    return [];
  }
}

function extractPackaging(name) {
  const vol = name.match(/\d+(\.\d+)?\s*(ml|mL|ML|L|l|g|kg)/i);
  const cnt = name.match(/(\d+)\s*(개|팩|캔|병|입|펫|페트|봉|포)/);
  if (vol && cnt) return `${vol[0].replace(/\s/g, "")} x ${cnt[1]}${cnt[2]}`;
  return vol ? vol[0].replace(/\s/g, "") : null;
}

/** 회사명에서 판매원 표기를 만든다 */
function sellerFrom(bssh) {
  return String(bssh ?? "").trim() || "제품 표기 참조";
}

// ── 상세페이지 HTML (lib/detail-html.ts와 동일) ────────
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const stripInternalTags = (v) => String(v).replace(/\s*\[검수필요[^\]]*\]/g, "").replace(/\(\s*\)/g, "").replace(/\s+\)/g, ")").replace(/\s{2,}/g, " ").trim();
const DISPLAY_FIELDS = [
  ["제품명", "제품명"], ["식품유형", "식품의 유형"], ["제조원", "생산자 및 소재지"], ["판매원", "판매원"],
  ["소비기한", "소비기한"], ["포장단위별용량", "포장단위별 용량·수량"], ["원재료명", "원재료명 및 함량"],
  ["영양성분", "영양성분"], ["품목보고번호", "품목보고번호"], ["유전자변형식품", "유전자변형식품 여부"],
  ["소비자안전주의사항", "소비자안전을 위한 주의사항"], ["수입여부", "수입식품 여부"], ["소비자상담번호", "소비자상담 관련 전화번호"],
];

function buildDetailHtml(productName, thumbnailUrl, itemInfo) {
  if (!itemInfo || itemInfo.스킵사유) return null;
  const rows = DISPLAY_FIELDS.map(([key, label]) => {
    const raw = itemInfo[key];
    if (!raw) return null;
    const value = stripInternalTags(raw);
    if (!value) return null;
    return `<tr>
      <td style="padding:10px 16px;background:#f8f8f8;font-weight:bold;border:1px solid #e0e0e0;width:160px;vertical-align:top;white-space:nowrap;word-break:keep-all;">${escapeHtml(label)}</td>
      <td style="padding:10px 16px;border:1px solid #e0e0e0;vertical-align:top;line-height:1.8;">${escapeHtml(value)}</td>
    </tr>`;
  }).filter(Boolean);
  if (!rows.length) return null;

  const safeName = escapeHtml(productName);
  const thumbHtml = thumbnailUrl
    ? `<div style="text-align:center;padding:20px 0;">
    <img src="${escapeHtml(thumbnailUrl)}" alt="${safeName}" style="max-width:800px;width:100%;height:auto;display:block;margin:0 auto;">
  </div>`
    : "";

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
      · 위 정보는 식품의약품안전처 식품안전나라 품목제조보고 자료를 기준으로 작성되었습니다.<br>
      · 제조사 사정에 따라 원재료·포장이 변경될 수 있으므로 실제 제품 표기사항을 확인해 주세요.
    </p>
  </div>
</div>`;
}

async function toDataUri(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${res.headers.get("content-type") || "image/jpeg"};base64,${buf.toString("base64")}`;
  } catch { return null; }
}

// ── 상품 1개 조사 ─────────────────────────────────────
async function research(p) {
  const skip = SKIP_RULES.find((s) => s.re.test(p.product_name));
  if (skip) return { skip: skip.사유 };

  const core = coreName(p.product_name);
  let best = null;   // { score, name }
  let rows = [];

  if (OFFLINE) {
    // 로컬 캐시 전수 비교. 후보를 미리 좁히려고 상품명 토큰이 들어간 제품명만 훑는다.
    const tokens = core.split(/\s+/).map(norm).filter((t) => t.length >= 2);
    if (!tokens.length) return { skip: "상품명에서 검색 가능한 단어를 못 찾음 [검수필요-수동조사]" };
    const anchor = tokens.reduce((a, b) => (a.length >= b.length ? a : b)); // 가장 긴 토큰
    for (const [k, list] of byName) {
      if (!k.includes(anchor) && !anchor.includes(k)) continue;
      const score = similarity(core, list[0].nm);
      if (score >= 0.7 && (!best || score > best.score)) best = { score, name: list[0].nm, key: k };
    }
    if (!best) return { skip: "자동매칭 실패 — 식약처 자료에 같은 이름 없음 [검수필요-수동조사]" };
    rows = byName.get(best.key).map((r) => ({
      PRDLST_NM: r.nm, PRDLST_DCNM: r.dc, BSSH_NM: r.bssh,
      PRDLST_REPORT_NO: r.no, POG_DAYCNT: r.pog,
      RAWMTRL_NM: r.raw || rawByReport.get(r.no) || "",
      SITE_ADDR: r.site || "",
    }));
  } else {
    for (const v of makeVariants(p.product_name)) {
      const found = await mfds("C002", `PRDLST_NM=${encodeURIComponent(v)}`);
      await new Promise((s) => setTimeout(s, 500));
      if (!found.length) continue;
      for (const r of found) {
        const score = similarity(core, r.PRDLST_NM);
        if (score >= 0.7 && (!best || score > best.score)) best = { score, name: r.PRDLST_NM };
      }
      if (best) break;
    }
    if (!best) return { skip: "자동매칭 실패 — 식약처에서 같은 이름을 못 찾음 [검수필요-수동조사]" };
    const all = await mfds("C002", `PRDLST_NM=${encodeURIComponent(best.name)}`);
    rows = all.filter((x) => x.PRDLST_NM === best.name);
    if (!rows.length) return { skip: "자동매칭 실패 — 재조회 0건 [검수필요-수동조사]" };
  }

  // 바코드
  let uniqBarcodes = [];
  if (OFFLINE) {
    uniqBarcodes = [...new Set(rows.flatMap((r) => barByReport.get(r.PRDLST_REPORT_NO) ?? []))];
  } else {
    const bs = [];
    for (const r of rows.slice(0, 4)) {
      const b = await mfds("C005", `PRDLST_REPORT_NO=${r.PRDLST_REPORT_NO}`);
      bs.push(...b.map((x) => x.BAR_CD).filter(Boolean));
      await new Promise((s) => setTimeout(s, 500));
    }
    uniqBarcodes = [...new Set(bs)];
  }

  const pog = rows.map((x) => x.POG_DAYCNT).filter(Boolean)[0];
  const dcName = rows[0].PRDLST_DCNM ?? "";
  const info = {
    품목군: /포장육|식육|우유|가공유|유가공/.test(dcName) ? "축산물" : "가공식품",
    제품명: best.name,
    식품유형: rows[0].PRDLST_DCNM,
    제조원: (() => {
      const withSite = [...new Set(rows.map((x) => x.SITE_ADDR ? `${x.BSSH_NM} / ${x.SITE_ADDR}` : x.BSSH_NM))].slice(0, 6).join(", ");
      // 소재지가 시·군 단위까지만 나오므로 상세주소는 라벨 참조로 안내한다
      return withSite + " (상세 소재지는 제품 라벨 표기 참조 [검수필요-주소보강])";
    })(),
    소비기한: pog ? `${pog} (표시일까지)` : "제품 별도 표시일까지",
    판매원: sellerFrom(rows[0].BSSH_NM),
    포장단위별용량: extractPackaging(p.product_name) || "[검수필요]",
    원재료명: rows.map((x) => x.RAWMTRL_NM || "").sort((a, b) => b.length - a.length)[0] || "제품 포장 표기 참조 [검수필요-원재료]",
    품목보고번호: rows.slice(0, 6).map((x) => `${x.PRDLST_REPORT_NO}(${x.BSSH_NM})`).join(", "),
    유전자변형식품: "해당없음",
    소비자안전주의사항: "직사광선을 피해 서늘한 곳에 보관, 개봉 후 빨리 섭취",
    수입여부: "국내산",
    소비자상담번호: SELLER_PHONE,
    ...(uniqBarcodes.length ? { 바코드: uniqBarcodes[0], 바코드_후보: uniqBarcodes.slice(0, 8).join(", ") } : {}),
    출처: `식약처 식품안전나라 품목제조보고, ${TODAY} 조회`,
    자동매칭점수: best.score.toFixed(2),
  };
  return { info };
}

// ── 메인 루프 ─────────────────────────────────────────
let done = 0, matched = 0, skipped = 0, rendered = 0;
const browser = RENDER ? await chromium.launch({ headless: true }) : null;
const startedAt = Date.now();

while (done < MAX) {
  const { data: products, error } = await sb
    .from("products")
    .select("id, user_id, product_name, thumbnail_url")
    .eq("rebuild_status", "대기")
    .in("category", ["가공식품", "건강식품/다이어트", "출산/유아동식품"])
    .neq("registration_status", "판매중지")
    .is("item_info", null)
    .order("sort_order", { ascending: true })
    .range(DRY ? done : 0, (DRY ? done : 0) + Math.min(BATCH, MAX - done) - 1);
  if (error) { console.error("[auto] 조회 실패:", error.message); break; }
  if (!products.length) { console.log("[auto] 남은 대기 상품 없음 — 종료"); break; }

  for (const p of products) {
    let res;
    try {
      res = await research(p);
    } catch (e) {
      res = { skip: `조사 중 오류: ${e instanceof Error ? e.message : String(e)} [검수필요-수동조사]` };
    }
    done++;

    if (DRY) {
      console.log(res.skip ? `  · 보류 ${p.product_name} — ${res.skip.slice(0, 30)}`
                           : `  ✓ ${p.product_name} → ${res.info.제품명} (${res.info.자동매칭점수})`);
      if (res.skip) skipped++; else matched++;
      continue;
    }
    if (res.skip) {
      // 자동매칭 실패는 캐시가 더 채워지면 다시 시도할 수 있다 → 재시도 표식을 남긴다
      const retryable = /자동매칭 실패|검색 가능한 단어/.test(res.skip);
      await sb.from("products").update({
        item_info: retryable ? { 스킵사유: res.skip, 재시도대상: true } : { 스킵사유: res.skip },
      }).eq("id", p.id);
      skipped++;
      console.log(`  · 보류 ${p.product_name} — ${res.skip.slice(0, 40)}`);
      continue;
    }

    const html = buildDetailHtml(p.product_name, p.thumbnail_url, res.info);
    const patch = { item_info: res.info, rebuild_status: "조사완료" };
    if (html) patch.detail_html = html;
    const { error: ue } = await sb.from("products").update(patch).eq("id", p.id);
    if (ue) { console.log(`  ✗ 저장실패 ${p.product_name}: ${ue.message}`); continue; }
    matched++;
    console.log(`  ✓ ${p.product_name} → ${res.info.제품명} (${res.info.자동매칭점수})`);

    // 상세페이지 PNG (이미지 관리 탭에 보이는 그림)
    if (browser && html) {
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
        const { error: upe } = await sb.storage.from("product-images").upload(sp, shot, { contentType: "image/png", upsert: true });
        if (upe) throw new Error(upe.message);
        const { data: { publicUrl } } = sb.storage.from("product-images").getPublicUrl(sp);
        await sb.from("products").update({ detail_image_url: publicUrl }).eq("id", p.id);
        rendered++;
      } catch (e) {
        console.log(`    (렌더 실패: ${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }

  const min = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`[auto] 진행 ${done}건 (성공 ${matched} / 보류 ${skipped} / 렌더 ${rendered}) — ${min}분 경과`);
}

if (browser) await browser.close();
console.log(`\n[auto] 종료 — 처리 ${done} / 조사완료 ${matched} / 보류 ${skipped} / PNG ${rendered}`);
