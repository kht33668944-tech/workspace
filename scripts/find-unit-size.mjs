// 상품명에 용량이 없어 쿠팡 옵션을 못 만드는 상품의 "개당 용량/중량"을 웹에서 찾는다.
//
//   node scripts/find-unit-size.mjs --dry     확인만
//   node scripts/find-unit-size.mjs --apply   item_info에 저장
//
// 쿠팡은 카테고리마다 "개당 용량" 또는 "개당 중량"을 요구한다.
// "카프리썬 오렌지 50개"처럼 낱개 용량이 상품명에 없으면 옵션을 만들 수 없어 반려된다.
//
// 검증: 찾은 값이 숫자+단위 형태이고, 상식적인 범위인지 본다.
//       못 믿을 값은 저장하지 않는다 — 틀린 용량은 빈칸보다 나쁘다.
import { createClient } from "@supabase/supabase-js";
import { chromium as stealth } from "patchright";
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const GEMINI_KEY = get("GEMINI_API_KEY");
const MODEL = get("GEMINI_MODEL") || "gemini-2.5-flash";
const APPLY = process.argv.includes("--apply");
const CACHE_FILE = "scripts/output/unit-size-cache.json";

async function gemini(prompt, retry = 0) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: "application/json" } }),
    });
    const j = await r.json();
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!t) throw new Error(j?.error?.message ?? "빈 응답");
    return JSON.parse(t);
  } catch (e) {
    if (retry < 2) { await new Promise((s) => setTimeout(s, 2000 * (retry + 1))); return gemini(prompt, retry + 1); }
    return null;
  }
}

const BAD_HOST = /google|gstatic|youtube|instagram|facebook|policies|tistory|brunch|melon|blog\.|cafe\.|ader\.naver|saedu\.naver/i;

async function collect(ctx, query) {
  const texts = [];
  let page;
  try {
    page = await ctx.newPage();
    let links = [];
    for (const [url, sel] of [
      [`https://search.daum.net/search?w=web&q=${encodeURIComponent(query)}`, ".c-item-doc a"],
      [`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=ko`, "a[href^='http']"],
    ]) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(1500);
      links = await page.evaluate((s) => [...document.querySelectorAll(s)].map((a) => a.href).filter(Boolean), sel);
      if (links.length >= 3) break;
    }
    await page.close(); page = null;
    for (const url of [...new Set(links)].filter((h) => !BAD_HOST.test(h)).slice(0, 4)) {
      try {
        const p = await ctx.newPage();
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        await p.waitForTimeout(1000);
        for (let i = 0; i < 5; i++) { await p.mouse.wheel(0, 2200); await p.waitForTimeout(120); }
        const t = await p.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
        await p.close();
        if (/\d+\s*(ml|mL|g|kg|L)/.test(t)) texts.push({ url, text: t.slice(0, 7000) });
        if (texts.length >= 2) break;
      } catch { /* 한 페이지 실패는 넘어간다 */ }
    }
  } catch { /* 검색 실패 */ } finally { if (page) await page.close().catch(() => {}); }
  return texts;
}

/** 값이 쓸 만한지 본다 — 숫자 + 단위, 그리고 상식 범위 */
function validate(raw) {
  const m = String(raw ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(ml|mL|ML|L|g|kg|G|KG)$/);
  if (!m) return null;
  let v = Number(m[1]);
  const u = m[2].toLowerCase() === "ml" ? "ml" : m[2].toLowerCase();
  if (!(v > 0)) return null;
  // 낱개 하나가 5L·5kg를 넘으면 묶음 전체를 잘못 읽은 값으로 본다.
  // 하한은 낮게 둔다 — 커피 스틱(0.9g), 티백(1.5g)처럼 아주 가벼운 제품이 있다.
  if (u === "ml" && (v < 1 || v > 5000)) return null;
  if (u === "l" && (v < 0.05 || v > 5)) return null;
  if (u === "g" && (v < 0.3 || v > 5000)) return null;
  if (u === "kg" && (v < 0.05 || v > 5)) return null;
  return `${m[1]}${u === "l" ? "L" : u === "kg" ? "kg" : u}`;
}

// ── 대상: 쿠팡 엑셀에서 옵션이 비어 있는 상품 ──
const dir = path.join(os.homedir(), "Desktop", "상품등록");
const rows = [];
for (const f of fs.readdirSync(dir).filter((f) => /쿠팡/.test(f) && f.endsWith(".xlsx"))) {
  const wb = XLSX.readFile(path.join(dir, f));
  rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }));
}
const names = [...new Set(rows.filter((r) => !String(r["옵션"] ?? "").trim()).map((r) => String(r["온라인 상품명"])))];
const { data: products } = await sb.from("products").select("id, product_name, item_info").in("product_name", names);
fs.mkdirSync("scripts/output", { recursive: true });
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
const targets = (products ?? []).filter((p) => !cache[p.id]);
console.log(`[unit] 옵션 미산출 ${names.length}건 / 이번 대상 ${targets.length}\n`);

const browser = await stealth.launch({ headless: false, channel: "chrome" });
const ctx = await browser.newContext({ locale: "ko-KR", viewport: { width: 1280, height: 900 } });
let ok = 0, bad = 0, n = 0;

for (const p of targets) {
  const q = `${p.item_info?.제품명 || p.product_name} 용량 중량`;
  const docs = await collect(ctx, q);
  let picked = null, why = "페이지 없음";
  if (docs.length) {
    const out = await gemini(
      `한국 제품 "${p.product_name}"의 낱개 하나의 용량 또는 중량을 웹페이지 본문에서 찾아라.\n` +
      `묶음 전체가 아니라 "낱개 1개"의 값이다. 예: "카프리썬 오렌지 50개"라면 파우치 한 개의 용량(200ml).\n` +
      `본문에 명확히 없으면 빈 문자열로 두어라. 절대 추측하지 마라.\n` +
      `숫자와 단위만 붙여 답하라 (예: "200ml", "45g").\n\n` +
      `{"개당용량":"","개당중량":"","근거":""}\n\n` +
      docs.map((d) => `[출처 ${d.url}]\n${d.text}`).join("\n\n---\n\n")
    );
    const vol = validate(out?.개당용량);
    const wt = validate(out?.개당중량);
    if (vol || wt) picked = { 개당용량: vol ?? "", 개당중량: wt ?? "", 근거: out?.근거 ?? "", 출처: docs.map((d) => d.url) };
    else why = `값 부적합 (${out?.개당용량 ?? "-"} / ${out?.개당중량 ?? "-"})`;
  }
  if (picked) {
    cache[p.id] = { name: p.product_name, ...picked };
    console.log(`  ✓ ${p.product_name}\n        ${picked.개당용량 || picked.개당중량}   ${String(picked.근거).slice(0, 60)}`);
    ok++;
  } else {
    cache[p.id] = { name: p.product_name, 실패: why };
    console.log(`  · ${p.product_name} — ${why}`);
    bad++;
  }
  await new Promise((s) => setTimeout(s, 6000));
  if (++n % 5 === 0) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}
fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
await browser.close();
console.log(`\n[unit] 확보 ${ok} / 실패 ${bad}`);

if (!APPLY) { console.log("(저장하려면 --apply)"); process.exit(0); }
let saved = 0;
for (const [id, c] of Object.entries(cache)) {
  if (c.실패) continue;
  const p = (products ?? []).find((x) => x.id === id);
  if (!p) continue;
  const info = { ...(p.item_info ?? {}) };
  if (c.개당용량) info.개당용량 = c.개당용량;
  if (c.개당중량) info.개당중량 = c.개당중량;
  info.용량출처 = `제조사·판매처 공개정보 확인 (${(c.출처 ?? []).slice(0, 2).join(", ")})`;
  await sb.from("products").update({ item_info: info }).eq("id", p.id);
  saved++;
}
console.log(`[unit] 저장 ${saved}건`);
