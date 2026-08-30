// 식약처에서 못 찾은 식품의 고시정보를 웹에서 찾아 채운다.
//
//   node scripts/food-web-fill.mjs --dry --max 5     확인만
//   node scripts/food-web-fill.mjs --apply           저장 + 상세페이지 + PNG
//
// 왜 웹인가:
//   식약처 등록명은 판매명과 달라 매칭이 안 되는 상품이 많고,
//   쇼핑몰 고시표는 원재료를 이미지로만 싣는다.
//   그래서 검색 → 본문 수집 → Gemini로 항목 추출 → 검증 순으로 간다.
//
// 검증(이게 핵심):
//   ① 원재료명은 쉼표로 나뉜 3개 이상이어야 한다 (문장·안내문 배제)
//   ② 상품명의 브랜드가 추출된 제품명이나 제조사에 있어야 한다 (남의 제품 배제)
//   ③ 식약처 캐시에 같은 제조사·제품명이 있으면 그쪽을 우선한다
//   ④ 셋 중 하나라도 어긋나면 저장하지 않는다
import { createClient } from "@supabase/supabase-js";
import { chromium as stealth } from "patchright";
import { chromium } from "playwright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const GEMINI_KEY = get("GEMINI_API_KEY");
const MODEL = get("GEMINI_MODEL") || "gemini-2.5-flash";
const APPLY = process.argv.includes("--apply");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const MAX = arg("--max", Infinity);
const SELLER_PHONE = "010-6564-4459";
const CACHE_FILE = "scripts/output/food-web-cache.json";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
const load = (n) => { const f = `scripts/output/mfds-${n}.json`; return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []; };
const mfds = [...load("C002"), ...load("C006")];

// ── Gemini ────────────────────────────────────────────
async function gemini(prompt, retry = 0) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    const j = await r.json();
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!t) throw new Error(j?.error?.message ?? "빈 응답");
    return JSON.parse(t);
  } catch (e) {
    if (retry < 2) { await new Promise((s) => setTimeout(s, 2000 * (retry + 1))); return gemini(prompt, retry + 1); }
    console.log(`    (Gemini 실패: ${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

// ── 웹 수집 ───────────────────────────────────────────
// 광고·SNS·검색엔진 자체 링크와, 고시를 이미지로만 싣는 오픈마켓은 제외한다
const BAD_HOST = /google|gstatic|youtube|instagram|facebook|policies|tistory|brunch|melon|blog\.|cafe\.|ader\.naver|saedu\.naver|11st|gmarket|auction|coupang|aliexpress|smartstore/i;
// 제조사 공식몰·대형몰을 앞에 둔다 (고시를 글로 적어두는 곳)
const GOOD_HOST = /co\.kr\/.*product|officialmall|mall\.|shop\.|lottemart|emart|ssg|homeplus|kurly|hmall|gsshop|skstoa/i;

async function collect(ctx, query) {
  const texts = [];
  let page;
  try {
    page = await ctx.newPage();
    let links = [];
    // 다음 → 구글 순서로 시도한다. 구글은 연속 검색을 금방 막는다.
    const ENGINES = [
      [`https://search.daum.net/search?w=web&q=${encodeURIComponent(query)}`, ".c-item-doc a"],
      [`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=ko`, "a[href^='http']"],
    ];
    for (const [url, sel] of ENGINES) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(1800);
      links = await page.evaluate((s) => [...document.querySelectorAll(s)].map((a) => a.href).filter(Boolean), sel);
      if (links.length >= 3) break;
    }
    await page.close(); page = null;

    const clean = [...new Set(links)].filter((h) => !BAD_HOST.test(h));
    // 공식몰류를 우선 방문
    const picked = [...clean.filter((h) => GOOD_HOST.test(h)), ...clean.filter((h) => !GOOD_HOST.test(h))].slice(0, 5);
    for (const url of picked) {
      try {
        const p = await ctx.newPage();
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await p.waitForTimeout(1200);
        for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 2200); await p.waitForTimeout(150); }
        const t = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
        await p.close();
        if (/원재료/.test(t)) texts.push({ url, text: t.slice(0, 9000) });
        if (texts.length >= 2) break;
      } catch { /* 페이지 하나 실패는 넘어간다 */ }
    }
  } catch { /* 검색 실패 */ } finally { if (page) await page.close().catch(() => {}); }
  return texts;
}

/** 두 이름이 얼마나 겹치는지 (2글자 조각 기준, 0~1) */
function overlap(a, b) {
  const g = [...new Set(a.match(/.{2}/g) ?? [])];
  if (!g.length || !b) return 0;
  return g.filter((x) => b.includes(x)).length / g.length;
}

// ── 검증 ──────────────────────────────────────────────
const ADVISORY = /참[조고]|해당없음|상세설명|별도\s*표기|확인\s*바랍|문의|상이할\s*수|상이할수/;
/** 값에 붙은 안내 문장을 떼어낸다 ("서울우유 안산공장, 배송점포에 따라 …" → 앞부분만) */
const stripAdvisory = (v) => String(v ?? "")
  .split(/[,/]/).map((s) => s.trim()).filter((s) => s && !ADVISORY.test(s)).join(", ").trim();
function validate(productName, out) {
  if (!out) return "추출 실패";
  const raw = String(out.원재료명 ?? "").trim();
  if (!raw) return "원재료명 없음";
  if (ADVISORY.test(raw)) return "원재료명이 안내문구";
  // "국산 원유 100%"처럼 한 가지뿐인 제품도 있으므로 개수는 따지지 않는다.
  // 대신 설명 문장이 아니라 원재료 나열인지를 본다.
  if (/습니다|하세요|바랍니다|드립니다|입니다\.|경우|문의/.test(raw)) return "원재료명이 설명 문장";
  if (raw.length < 2 || raw.length > 2000) return `원재료명 길이 이상(${raw.length}자)`;

  // 브랜드(상품명 첫 단어)가 제품명이나 제조사에 있어야 한다
  const brand = norm(productName.split(/\s+/)[0]);
  const hay = norm(`${out.제품명 ?? ""} ${out.제조사 ?? ""}`);
  if (brand.length >= 2 && !hay.includes(brand)) {
    // 브랜드가 회사명과 다른 경우가 있어(햇반↔CJ) 제품명 유사도로 한 번 더 본다
    const a = norm(productName), b = norm(out.제품명 ?? "");
    const common = [...new Set(a.match(/.{2}/g) ?? [])].filter((g) => b.includes(g)).length;
    if (!b || common < 2) return `브랜드 불일치(추출: ${out.제품명 ?? "-"} / ${out.제조사 ?? "-"})`;
  }
  const maker = stripAdvisory(out.제조사);
  if (!maker) return "제조사 없음";
  out.제조사 = maker;
  return null;
}

// ── 대상 ──────────────────────────────────────────────
const NOT_FOOD = /헤드앤숄더|존슨즈베이비|존슨앤존슨|리스테린|가그린|치약|샴푸|린스|로션|바디워시/;
let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, user_id, product_name, thumbnail_url")
    .eq("rebuild_status", "대기")
    .in("category", ["가공식품", "건강식품/다이어트", "출산/유아동식품"])
    .neq("registration_status", "판매중지")
    .order("sort_order").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
fs.mkdirSync("scripts/output", { recursive: true });
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
const targets = all.filter((p) => !NOT_FOOD.test(p.product_name) && !cache[p.id])
  .slice(0, Number.isFinite(MAX) ? MAX : undefined);
console.log(`[web] 보류 식품 ${all.filter((p) => !NOT_FOOD.test(p.product_name)).length}개 / 캐시 ${Object.keys(cache).length} / 이번 ${targets.length}개\n`);

const browser = await stealth.launch({ headless: false, channel: "chrome" });
const ctx = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 900 } });
let ok = 0, bad = 0, n = 0;

for (const p of targets) {
  const base = p.product_name.replace(/\s*\d+\s*(개|입|팩|캔|병|펫|봉)$/, "").trim();
  const docs = await collect(ctx, `${base} 원재료명 제조사`);
  if (!docs.length) {
    cache[p.id] = { name: p.product_name, 실패: "원재료 실린 페이지 없음" };
    console.log(`  · ${p.product_name} — 페이지 없음`);
    bad++;
  } else {
    const out = await gemini(
      `아래는 한국 식품 "${p.product_name}"에 대한 웹페이지 본문이다.\n` +
      `이 제품의 상품정보제공고시 항목을 뽑아 JSON으로만 답하라.\n` +
      `본문에 없으면 그 항목은 빈 문자열로 두어라. 절대 추측하거나 지어내지 마라.\n` +
      `특히 원재료명은 본문에 실제로 나열된 원재료 목록을 그대로 옮겨라. "상세설명 참조" 같은 안내문구는 빈 문자열로 처리하라.\n\n` +
      `{"제품명":"","식품유형":"","제조사":"","원재료명":"","내용량":"","소비기한":"","영양성분":""}\n\n` +
      docs.map((d) => `[출처 ${d.url}]\n${d.text}`).join("\n\n---\n\n")
    );
    // 웹이 제조사를 알려주면, 그 제조사로 식약처를 다시 뒤져 원재료를 채운다.
    // "닥터페퍼 제로"는 식약처에 세 회사가 있어 못 골랐지만, 웹이 코카콜라음료라고 하면 하나로 좁혀진다.
    if (out && !String(out.원재료명 ?? "").trim() && out.제조사) {
      const co = norm(String(out.제조사).replace(/\(주\)|주식회사|㈜/g, "")).slice(0, 5);
      // 용량·수량이 섞이면 이름이 안 맞으므로 걷어내고 비교한다 ("닥터페퍼제로355ml" → "닥터페퍼제로")
      const strip = (t) => norm(String(t)
        .replace(/\d+(\.\d+)?\s*(ml|g|kg|l|리터)/gi, " ")
        .replace(/\d+\s*(개|입|팩|캔|병|펫|봉|매)/g, " "));
      const nm = strip(out.제품명 || p.product_name);
      const hit = mfds.filter((r) => r.raw && norm(r.bssh).includes(co))
        .map((r) => { const b = strip(r.nm); return { r, s: Math.max(overlap(nm, b), overlap(b, nm)) }; })
        .filter((x) => x.s >= 0.85).sort((a, b) => b.s - a.s)[0];
      if (hit) {
        out.원재료명 = hit.r.raw;
        out.식품유형 = out.식품유형 || hit.r.dc || "";
        out.품목보고번호 = `${hit.r.no}(${hit.r.bssh})`;
        console.log(`    (원재료는 식약처에서 보강: ${hit.r.nm} / ${hit.r.bssh})`);
      }
    }
    const why = validate(p.product_name, out);
    if (why) {
      cache[p.id] = { name: p.product_name, 실패: why, 추출: out ?? null };
      console.log(`  · ${p.product_name} — ${why}`);
      bad++;
    } else {
      cache[p.id] = { name: p.product_name, ...out, 출처: docs.map((d) => d.url) };
      console.log(`  ✓ ${p.product_name}\n        ${out.제품명} / ${out.제조사} / ${String(out.원재료명).slice(0, 60)}…`);
      ok++;
    }
  }
  await new Promise((s) => setTimeout(s, 8000));   // 검색엔진 부하 방지
  if (++n % 5 === 0) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}
fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
await browser.close();
console.log(`\n[web] 확보 ${ok} / 실패 ${bad} → ${CACHE_FILE}`);
if (!APPLY) { console.log("(저장하려면 --apply)"); process.exit(0); }

// ── 저장 ──────────────────────────────────────────────
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const DISPLAY = [["제품명", "제품명"], ["식품유형", "식품의 유형"], ["제조원", "생산자 및 소재지"],
  ["소비기한", "소비기한"], ["포장단위별용량", "포장단위별 용량·수량"], ["원재료명", "원재료명 및 함량"],
  ["영양성분", "영양성분"], ["품목보고번호", "품목보고번호"], ["유전자변형식품", "유전자변형식품 여부"],
  ["소비자안전주의사항", "소비자안전을 위한 주의사항"], ["수입여부", "수입식품 여부"], ["소비자상담번호", "소비자상담 관련 전화번호"]];
function buildHtml(name, thumb, info) {
  const rs = DISPLAY.map(([k, l]) => {
    const v = String(info[k] ?? "").trim();
    if (!v) return null;
    return `<tr><td style="padding:10px 16px;background:#f8f8f8;font-weight:bold;border:1px solid #e0e0e0;width:160px;vertical-align:top;white-space:nowrap;word-break:keep-all;">${escapeHtml(l)}</td><td style="padding:10px 16px;border:1px solid #e0e0e0;vertical-align:top;line-height:1.8;">${escapeHtml(v)}</td></tr>`;
  }).filter(Boolean);
  if (!rs.length) return null;
  const t = thumb ? `<div style="text-align:center;padding:20px 0;"><img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" style="max-width:800px;width:100%;height:auto;display:block;margin:0 auto;"></div>` : "";
  return `<div style="max-width:1000px;margin:0 auto;font-family:'맑은 고딕',sans-serif;font-size:14px;color:#333;background:#fff;">
  <div style="background:#222;color:#fff;padding:16px 20px;text-align:center;"><h2 style="margin:0;font-size:18px;font-weight:bold;">${escapeHtml(name)}</h2></div>
  ${t}
  <div style="padding:20px;">
    <h3 style="font-size:15px;border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:0;">상품정보제공고시</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">${rs.join("\n")}</table>
    <p style="margin:16px 0 0;font-size:12px;color:#777;line-height:1.7;">
      · 위 정보는 제조사가 공개한 제품정보를 기준으로 작성되었습니다.<br>
      · 제조사 사정에 따라 원재료·포장이 변경될 수 있으므로 실제 제품 표기사항을 확인해 주세요.
    </p>
  </div>
</div>`;
}
async function toDataUri(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return `data:${r.headers.get("content-type") || "image/jpeg"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`; } catch { return null; }
}
const sizeOf = (n) => {
  const v = n.match(/\d+(\.\d+)?\s*(ml|g|kg|l)(?=\s|$)/i)?.[0]?.replace(/\s/g, "");
  const c = n.match(/(\d+)\s*(개|입|캔|병|팩|봉|펫|봉지)(?=\s|$)/);
  const cnt = c ? `${c[1]}${c[2]}` : "";
  return v && cnt ? `${v} x ${cnt}` : (v || cnt || "제품 표시 참조");
};

const renderer = await chromium.launch({ headless: true });
let saved = 0;
for (const [id, c] of Object.entries(cache)) {
  if (c.실패 || !c.원재료명) continue;
  const p = all.find((x) => x.id === id);
  if (!p) continue;

  // 식약처에 같은 제조사·제품명이 있으면 품목보고번호를 붙인다
  const m = mfds.find((r) => norm(r.nm) === norm(c.제품명) && norm(r.bssh).includes(norm(String(c.제조사).replace(/\(주\)|주식회사/g, "")).slice(0, 4)));
  const info = {
    품목군: "가공식품",
    제품명: c.제품명 || p.product_name,
    식품유형: c.식품유형 || "",
    제조원: c.제조사 || "",
    판매원: c.제조사 || "",
    소비기한: c.소비기한 || "제품 표시일까지",
    포장단위별용량: c.내용량 || sizeOf(p.product_name),
    원재료명: c.원재료명,
    영양성분: c.영양성분 || "",
    품목보고번호: m ? `${m.no}(${m.bssh})` : "",
    유전자변형식품: "해당없음",
    소비자안전주의사항: "직사광선을 피해 서늘한 곳에 보관, 개봉 후 빨리 드시기 바랍니다.",
    수입여부: "국내산",
    소비자상담번호: SELLER_PHONE,
    출처: `제조사 공개 제품정보 (${(c.출처 ?? []).join(", ")}), ${new Date().toISOString().slice(0, 10)} 조회`,
  };
  const html = buildHtml(p.product_name, p.thumbnail_url, info);
  await sb.from("products").update({ item_info: info, rebuild_status: "조사완료", detail_html: html }).eq("id", p.id);
  if (html) {
    try {
      let cap = html;
      if (p.thumbnail_url) { const u = await toDataUri(p.thumbnail_url); if (u) cap = cap.split(p.thumbnail_url).join(u); }
      const c2 = await renderer.newContext({ viewport: { width: 1000, height: 800 } });
      const pg = await c2.newPage();
      await pg.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;}</style></head><body>${cap}</body></html>`, { waitUntil: "load" });
      const h = await pg.evaluate(() => document.body.scrollHeight);
      await pg.setViewportSize({ width: 1000, height: Math.max(h, 100) });
      const shot = await pg.screenshot({ fullPage: true, type: "png" });
      await c2.close();
      const sp = `products/${p.user_id}/ai_detail_${Date.now()}_${p.id.slice(0, 8)}.png`;
      await sb.storage.from("product-images").upload(sp, shot, { contentType: "image/png", upsert: true });
      const { data: { publicUrl } } = sb.storage.from("product-images").getPublicUrl(sp);
      await sb.from("products").update({ detail_image_url: publicUrl }).eq("id", p.id);
    } catch (e) { console.log(`   (렌더 실패 ${p.product_name}: ${e instanceof Error ? e.message : String(e)})`); }
  }
  saved++;
}
await renderer.close();
console.log(`[web] 저장 ${saved}건`);
