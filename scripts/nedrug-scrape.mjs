// 의약품안전나라(nedrug)에서 의약외품(생리대·탐폰·치약) 고시정보를 긁어온다.
//
//   node scripts/nedrug-scrape.mjs --dry        매칭 결과만 출력
//   node scripts/nedrug-scrape.mjs              저장 + 상세페이지 + PNG
//   node scripts/nedrug-scrape.mjs --max 20
//
// 왜 여기인가:
//   생리대·탐폰·치약은 생활화학제품이 아니라 의약외품이라 초록누리에 없다.
//   식약처 의약품통합정보시스템에 품목허가 정보가 그대로 공개돼 있고
//   로그인·인증키 없이 서버렌더 HTML로 내려온다.
//     목록  GET /searchDrug?searchYn=true&itemName=<검색어>&page=N
//     상세  GET /pbp/CCBBB01/getItemDetail?itemSeq=<품목기준코드>
//
// 주의: 판매자 상세설명 이미지는 가져오지 않는다. 사실정보만 취하고
//       소비자상담번호는 우리 번호로 넣는다.
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
const UA = { "User-Agent": "Mozilla/5.0", "Accept-Language": "ko-KR" };

// 의약외품으로 다룰 상품 (초록누리·식약처 식품 어느 쪽에도 없는 것들)
const MEDIC_RE = /생리대|탐폰|팬티라이너|오버나이트|바디피트|안심숙면팬티|순면커버|유기농순면|치약|가글|구강청결/;

// ── 목록 검색 ─────────────────────────────────────────
function parseRows(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]
    .replace(/<[^>]+>/g, "|").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\|+/g, "|").replace(/[ \t]+/g, " ").replace(/\s*\|\s*/g, "|").trim());
  // 라벨과 값 사이에 빈 칸이 끼는 경우가 있다 (`|제품명||쏘피 …|`).
  // 그래서 정규식 한 방이 아니라 라벨 뒤 첫 번째 비어있지 않은 칸을 찾는다.
  const field = (parts, label) => {
    const i = parts.indexOf(label);
    if (i < 0) return "";
    for (let j = i + 1; j < Math.min(i + 4, parts.length); j++) {
      const v = parts[j].trim();
      if (v && v !== label) return v;
    }
    return "";
  };
  return rows.filter((s) => /\|품목기준코드\|\d/.test(s)).map((s) => {
    const parts = s.split("|");
    return {
      nm: field(parts, "제품명"),
      co: field(parts, "업체명"),
      code: field(parts, "품목기준코드"),
      permit: field(parts, "허가번호"),
      date: field(parts, "허가일"),
      kind: field(parts, "품목구분"),
      state: field(parts, "취소/취하구분"),
    };
  }).filter((r) => r.nm && /^\d+$/.test(r.code))
    // 묶음의약품 행은 제품명 칸에 "1.○○치약, 2.△△치약 …"처럼 목록이 들어온다
    .filter((r) => !/^\d+\./.test(r.nm) && r.nm.length <= 60);
}

async function fetchPage(word, page, retry = 0) {
  try {
    const url = `https://nedrug.mfds.go.kr/searchDrug?searchYn=true&itemName=${encodeURIComponent(word)}&page=${page}`;
    const r = await fetch(url, { headers: UA });
    return parseRows(await r.text());
  } catch (e) {
    if (retry < 3) { await new Promise((s) => setTimeout(s, 1500 * (retry + 1))); return fetchPage(word, page, retry + 1); }
    return [];
  }
}

/** 페이지당 15건뿐이라 전 페이지를 훑는다 ("쏘피"만 229건) */
async function searchItems(word, maxPages = 40) {
  const out = [];
  const seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    const rows = await fetchPage(word, p);
    if (!rows.length) break;
    let fresh = 0;
    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code); out.push(r); fresh++;
    }
    if (!fresh) break;  // 같은 페이지가 반복되면 끝
    await new Promise((s) => setTimeout(s, 150));
  }
  return out;
}

/** 상세페이지에서 필요한 항목만 뽑는다 */
async function fetchDetail(code, retry = 0) {
  try {
    const r = await fetch(`https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=${code}`, { headers: UA });
    const html = await r.text();
    if (html.length < 10000) throw new Error("상세 응답이 비정상");
    const txt = html
      .replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .split("\n").map((s) => s.trim()).filter(Boolean);

    // 페이지 안내문·버튼 텍스트는 값이 아니다
    const JUNK = /폴딩 버튼|다운로드|변경이력|엑셀|조회|참조하시기|바랍니다|-->|디자인 깨짐|^순번$/;
    /** 라벨 다음부터 멈춤 라벨 전까지 모은다 */
    const after = (label, stops, n = 30) => {
      const i = txt.lastIndexOf(label);
      if (i < 0) return "";
      const out = [];
      for (let j = i + 1; j < txt.length && out.length < n; j++) {
        if (stops.some((s) => txt[j] === s)) break;
        if (JUNK.test(txt[j])) continue;
        out.push(txt[j]);
      }
      return out.join(" ").replace(/\s{2,}/g, " ").trim();
    };
    const one = (label) => { const i = txt.lastIndexOf(label); return i < 0 ? "" : (txt[i + 1] ?? "").trim(); };

    return {
      성상: one("성상"),
      효능효과: after("효능효과", ["용법용량", "용법 용량"], 8),
      용법용량: after("용법용량", ["사용상의주의사항", "사용상의 주의사항"], 8),
      주의사항: after("사용상의주의사항", ["재심사, RMP, 보험, 기타정보", "재심사"], 25),
      원료: after("원료약품 및 분량", ["효능효과", "성상"], 6),
      저장방법: one("저장방법"),
      사용기간: one("사용기간"),
    };
  } catch (e) {
    if (retry < 3) { await new Promise((s) => setTimeout(s, 1500 * (retry + 1))); return fetchDetail(code, retry + 1); }
    return null;
  }
}

// ── 이름 매칭 (초록누리와 같은 원칙) ──────────────────
// 상품명은 "수퍼롱·M·라지", 허가명은 "슈퍼롱·중형·대형"으로 적는다. 같은 말로 맞춘다.
function unifySize(s) {
  return String(s ?? "")
    .replace(/(^|\s)XL(?=\s|$)/gi, "$1특대형")
    .replace(/(^|\s)L(?=\s|$)/g, "$1대형")
    .replace(/(^|\s)M(?=\s|$)/g, "$1중형")
    .replace(/미디움|미디엄/g, "중형")
    .replace(/라지/g, "대형")
    .replace(/수퍼/g, "슈퍼");
}
const norm = (s) => unifySize(s).toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
function coreName(name) {
  return unifySize(name)
    .replace(/\d+(\.\d+)?\s*(ml|mL|ML|l|L|g|kg|매|롤|P|p|입|팩)(?=\s|$)/g, " ")
    .replace(/\d+\s*(개|팩|입|박스|세트|묶음)(?=\s|$)/g, " ")
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
const NOISE = ["기획", "증정", "행사", "묶음", "세트", "본품", "리필"];
// 허가명에는 안 쓰이는 총칭·마케팅 라인명
// (상품명 "쏘피 바디피트 한결 대형"의 허가명은 "쏘피한결대형에이" — 바디피트가 없다)
const GENERIC = ["생리대", "날개형", "일반형", "위생대", "바디피트"];
// 허가명 끝에 붙는 제조소 구분 (같은 제품의 다른 허가)
const SUFFIX_RE = /(에이|비|씨|디|플러스)$/;
// 크기·종류는 반드시 맞아야 한다 (대형과 중형은 다른 품목이다)
const SIZE_WORDS = ["소형", "중형", "특대형", "대형", "슈퍼롱", "오버나이트"];

function score(core, cand) {
  const b = norm(cand);
  const raw = core.split(/\s+/).map(norm).filter((t) => t.length >= 2 && !NOISE.includes(t));
  if (!raw.length) return 0;
  if (!b.includes(raw[0])) return 0;                       // 브랜드 필수
  const a = norm(core);
  for (const w of SIZE_WORDS) if (a.includes(w) !== b.includes(w)) return 0;
  const must = raw.slice(1).filter((t) => !GENERIC.includes(t));
  if (!must.length) return 0;
  const cover = must.filter((t) => b.includes(t)).length / must.length;
  if (cover < 0.8) return 0;
  return 0.6 * cover + 0.4 * dice(a, b);
}
/** 후보에만 있고 상품명엔 없는 단어 수 — 적을수록 정확한 짝 */
function extraTokens(core, cand) {
  const mine = norm(core);
  return String(cand).split(/[\s()[\]/·,]+/).map(norm)
    .filter((t) => t.length >= 2 && !GENERIC.includes(t) && !mine.includes(t)).length;
}
/** 검색어 — 브랜드부터 한 단어씩 늘려가며 시도 */
function makeQueries(name) {
  const t = coreName(name).split(/\s+/).filter(Boolean);
  const q = [];
  for (let end = Math.min(3, t.length); end >= 1; end--) q.push(t.slice(0, end).join(" "));
  return [...new Set(q)].filter((x) => x.length >= 2);
}

// ── 상세페이지 HTML ───────────────────────────────────
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const clean = (v) => String(v ?? "").replace(/\s*\[검수필요[^\]]*\]/g, "").replace(/\s{2,}/g, " ").trim();
const DISPLAY_FIELDS = [
  ["품명및모델명", "품목 및 제품명"], ["품목구분", "품목 구분"], ["인증허가", "식약처 허가·신고 여부"],
  ["중량용량", "용량·중량·매수"], ["성상", "성상"], ["효능효과", "효능·효과"],
  ["사용방법", "사용방법"], ["원료", "원료·재질"], ["제조회사", "제조자"],
  ["사용기한", "사용기한"], ["보관방법", "보관방법"],
  ["사용상주의사항", "사용상 주의사항"], ["품질보증기준", "품질보증기준"],
  ["소비자상담번호", "소비자상담 관련 전화번호"],
];
function buildDetailHtml(productName, thumbnailUrl, info) {
  if (!info || info.스킵사유) return null;
  const rows = DISPLAY_FIELDS.map(([k, label]) => {
    const v = clean(info[k]);
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
      · 위 정보는 식품의약품안전처 의약품통합정보시스템 품목허가 자료를 기준으로 작성되었습니다.<br>
      · 제조사 사정에 따라 사양·포장이 변경될 수 있으므로 실제 제품 표기사항을 확인해 주세요.
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
  const c = name.match(/(\d+)\s*(매|P|p|입|개)(?=\s|$)/);
  if (v && c) return `${v[0].replace(/\s/g, "")} x ${c[1]}${c[2]}`;
  return v ? v[0].replace(/\s/g, "") : (c ? `${c[1]}${c[2]}` : "");
}

// ── 실행 ──────────────────────────────────────────────
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
const targets = all
  .filter((p) => MEDIC_RE.test(p.product_name))
  .filter((p) => !p.item_info || p.item_info.재시도대상)
  .slice(0, Number.isFinite(MAX) ? MAX : undefined);
console.log(`[nedrug] 의약외품 대상 ${targets.length}개 (비식품 대기 ${all.length})`);

const browser = DRY ? null : await chromium.launch({ headless: true });
const cache = new Map();
let ok = 0, skip = 0;

for (const p of targets) {
  const core = coreName(p.product_name);
  let hits = [];
  for (const q of makeQueries(p.product_name)) {
    if (!cache.has(q)) {
      cache.set(q, await searchItems(q));
      await new Promise((s) => setTimeout(s, 300));
    }
    for (const r of cache.get(q)) {
      // 취하된 허가는 현재 유통 제품이 아니므로 아예 후보에서 뺀다
      if (!/정상/.test(r.state)) continue;
      const sc = score(core, r.nm);
      if (sc < 0.7) continue;
      hits.push({ sc, raw: sc, extra: extraTokens(core, r.nm), r });
    }
    if (hits.length) break;
  }
  hits.sort((a, b) => (b.sc - a.sc) || (a.extra - b.extra));

  const contenders = hits.filter((h) => h.sc >= (hits[0]?.sc ?? 0) - 0.08);
  const minExtra = Math.min(...contenders.map((h) => h.extra));
  const near = contenders.filter((h) => h.extra === minExtra);
  // "쏘피한결대형에이"와 "쏘피한결대형비"는 제조소만 다른 같은 제품이다.
  // 접미사를 떼고 같은 이름·같은 업체면 모호한 게 아니라 하나로 본다(최근 허가 사용).
  const ident = (h) => `${norm(h.r.nm).replace(SUFFIX_RE, "")}|${norm(h.r.co)}`;
  const ambiguous = new Set(near.map(ident)).size > 1;
  const best = [...near].sort((a, b) => String(b.r.date).localeCompare(String(a.r.date)))[0];

  if (!best || ambiguous) {
    skip++;
    const why = ambiguous
      ? `의약외품 후보 ${near.length}건이 품목기준코드가 서로 달라 특정 불가 (${near.slice(0, 3).map((h) => h.r.nm).join(" / ")}) [검수필요-수동조사]`
      : "의약품안전나라에서 같은 이름 없음 [검수필요-수동조사]";
    console.log(`  · 보류 ${p.product_name} — ${ambiguous ? "후보 여럿(코드 상이)" : "미등록"}`);
    if (!DRY) await sb.from("products").update({ item_info: { 스킵사유: why, 재시도대상: true } }).eq("id", p.id);
    continue;
  }

  const d = await fetchDetail(best.r.code);
  await new Promise((s) => setTimeout(s, 300));

  const info = {
    품목군: "의약외품",
    품명및모델명: best.r.nm,
    품목구분: best.r.kind || "의약외품",
    인증허가: `식품의약품안전처 의약외품 품목허가 (품목기준코드 ${best.r.code}${best.r.date ? `, 허가일 ${best.r.date}` : ""})`,
    중량용량: extractSize(p.product_name),
    성상: d?.성상 ?? "",
    효능효과: d?.효능효과 ?? "",
    사용방법: d?.용법용량 ?? "",
    원료: d?.원료 ?? "",
    제조회사: best.r.co || "",
    사용기한: d?.사용기간 ? `${d.사용기간} (제품 표시일까지)` : "제품 별도 표시일까지",
    보관방법: d?.저장방법 ?? "",
    사용상주의사항: d?.주의사항 ?? "",
    품질보증기준: "관련 법 및 소비자분쟁해결기준에 따름",
    소비자상담번호: SELLER_PHONE,
    품목기준코드: best.r.code,
    출처: `식품의약품안전처 의약품통합정보시스템 의약외품 품목허가, ${TODAY} 조회`,
    자동매칭점수: best.raw.toFixed(2),
  };

  console.log(`  ✓ ${p.product_name} → ${best.r.nm} (${best.raw.toFixed(2)}) ${best.r.code} ${best.r.state}`);
  ok++;
  if (DRY) continue;

  const html = buildDetailHtml(p.product_name, p.thumbnail_url, info);
  await sb.from("products")
    .update(html ? { item_info: info, rebuild_status: "조사완료", detail_html: html } : { item_info: info, rebuild_status: "조사완료" })
    .eq("id", p.id);

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
console.log(`\n[nedrug] 완료 — 매칭 ${ok} / 보류 ${skip}`);
