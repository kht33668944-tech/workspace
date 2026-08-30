// 캐시가 더 채워진 뒤 돌리는 보강 패스.
//
//   node scripts/rebuild-enrich.mjs
//
// 하는 일 두 가지:
//   ① 자동매칭에 실패해 [재시도대상] 표식이 붙은 상품의 item_info를 비워 다시 조사 대상으로 되돌린다
//   ② 이미 조사완료지만 원재료명·바코드가 비어 있는 상품을 C002/C005 캐시로 채우고
//      상세페이지 HTML과 PNG까지 다시 만든다
//
// 이 스크립트가 끝난 뒤 rebuild-auto-batch.mjs를 다시 돌리면 ①이 처리된다.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const load = (n) => {
  const f = `scripts/output/mfds-${n}.json`;
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
};
const C002 = load("C002"), C005 = load("C005"), C006 = load("C006"), C003 = load("C003");
console.log(`[enrich] 캐시 — C002 ${C002.length.toLocaleString()} / C005 ${C005.length.toLocaleString()} / C006 ${C006.length.toLocaleString()} / C003 ${C003.length.toLocaleString()}`);

// 품목보고번호 → 원재료 / 바코드
const rawByNo = new Map(), barByNo = new Map();
const addRaw = (no, raw) => {
  if (!raw) return;
  const cur = rawByNo.get(no);
  // C006(축산물)은 원재료가 한 줄에 하나씩이라 이어붙인다
  rawByNo.set(no, cur ? (cur.includes(raw) ? cur : `${cur}, ${raw}`) : raw);
};
for (const r of [...C002, ...C005, ...C006, ...C003]) {
  addRaw(r.no, r.raw);
  if (r.bar) { if (!barByNo.has(r.no)) barByNo.set(r.no, []); barByNo.get(r.no).push(r.bar); }
}

// ── ① 재시도 대상 되돌리기 ──────────────────────────
{
  const { data } = await sb.from("products").select("id, item_info")
    .eq("rebuild_status", "대기").not("item_info", "is", null);
  // 재시도 표식이 있거나, 이제 자료가 생긴 분류(축산물 C006 / 건강기능식품 C003)면 되돌린다
  const targets = (data ?? []).filter((p) => {
    const why = p.item_info?.스킵사유 ?? "";
    if (p.item_info?.재시도대상) return true;
    if (C006.length && /축산물/.test(why)) return true;
    if (C003.length && /건강기능식품/.test(why)) return true;
    return false;
  });
  for (const p of targets) await sb.from("products").update({ item_info: null }).eq("id", p.id);
  console.log(`[enrich] 재조사 대상 복구 ${targets.length}건`);
}

// ── ② 조사완료 상품 보강 ────────────────────────────
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

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, user_id, product_name, thumbnail_url, item_info")
    .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지")
    .range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
const needs = all.filter((p) => {
  const i = p.item_info;
  if (!i || i.스킵사유) return false;
  return /검수필요-원재료/.test(i.원재료명 ?? "") || !i.바코드;
});
console.log(`[enrich] 조사완료 ${all.length}건 중 보강 대상 ${needs.length}건`);

const browser = await chromium.launch({ headless: true });
let fixedRaw = 0, fixedBar = 0, rendered = 0;

for (const p of needs) {
  const nos = String(p.item_info.품목보고번호 ?? "").match(/\d{8,}/g) ?? [];
  const info = { ...p.item_info };
  let changed = false;

  if (/검수필요-원재료/.test(info.원재료명 ?? "")) {
    const raws = nos.map((n) => rawByNo.get(n)).filter(Boolean).sort((a, b) => b.length - a.length);
    if (raws[0]) { info.원재료명 = raws[0]; fixedRaw++; changed = true; }
  }
  if (!info.바코드) {
    const bars = [...new Set(nos.flatMap((n) => barByNo.get(n) ?? []))];
    if (bars.length) { info.바코드 = bars[0]; info.바코드_후보 = bars.slice(0, 8).join(", "); fixedBar++; changed = true; }
  }
  if (!changed) continue;

  const html = buildDetailHtml(p.product_name, p.thumbnail_url, info);
  await sb.from("products").update(html ? { item_info: info, detail_html: html } : { item_info: info }).eq("id", p.id);

  if (html) {
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
      rendered++;
    } catch (e) {
      console.log(`  (렌더 실패 ${p.product_name}: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
}
await browser.close();
console.log(`[enrich] 완료 — 원재료 보강 ${fixedRaw} / 바코드 보강 ${fixedBar} / PNG ${rendered}`);
