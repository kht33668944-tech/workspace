// 비식품(생활용품·세제·화장지 등)의 상품정보제공고시를 원본 판매처(지마켓)에서 긁어온다.
//
//   node scripts/gmarket-notice-scrape.mjs --dry      확인만
//   node scripts/gmarket-notice-scrape.mjs            저장 + 상세페이지 + PNG
//   node scripts/gmarket-notice-scrape.mjs --max 20
//
// 왜 지마켓인가:
//   식품은 원재료명까지 써야 해서 식약처 DB가 필요했지만,
//   비식품은 공정위 "기타 재화" 고시 5항목(품명·인증·제조국·제조자·연락처)이면 된다.
//   그 5항목이 지마켓 상품페이지의 고시표(.box__product-notice)에 그대로 들어있다.
//
// 주의: 판매자 상세설명 이미지는 절대 가져오지 않는다 (저작권·개인정보 침해 사유).
//       사실정보(제조사·제조국)만 취하고, 소비자상담번호는 우리 번호로 바꾼다.
import { createClient } from "@supabase/supabase-js";
import { chromium as stealth } from "patchright";
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

const NON_FOOD_CATEGORIES = ["생활용품", "욕실/세탁(세제샴푸등)", "물티슈"];

// ── 상세페이지 HTML ───────────────────────────────────
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const clean = (v) => String(v ?? "").replace(/\s*\[검수필요[^\]]*\]/g, "").replace(/\s{2,}/g, " ").trim();

// 초록누리에서 온 항목과 지마켓에서 온 항목을 한 표에 같이 담는다
const DISPLAY_FIELDS = [
  ["품명및모델명", "품명 및 모델명"], ["제품분류", "제품 분류"], ["용도", "용도"], ["제형", "제형"],
  ["중량용량", "중량·용량·수량"], ["제조국", "제조국"], ["제조회사", "제조자·수입자"],
  ["수입자", "수입자"], ["인증허가", "법에 의한 인증·허가 등"], ["표준사용량", "표준 사용량"],
  ["사용방법", "사용방법"], ["사용상주의사항", "사용상 주의사항"], ["응급처치", "응급처치"],
  ["유통기한", "유통기한"], ["품질보증기준", "품질보증기준"],
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
  const 출처 = info.출처 ?? "";
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
      · ${escapeHtml(출처)}<br>
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
  const c = name.match(/(\d+)\s*(개|팩|롤|매|입|P|p)/);
  if (v && c) return `${v[0].replace(/\s/g, "")} x ${c[1]}${c[2]}`;
  return v ? v[0].replace(/\s/g, "") : (c ? `${c[1]}${c[2]}` : "");
}

// ── 대상 조회 ─────────────────────────────────────────
let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, user_id, product_name, thumbnail_url, purchase_url, item_info, rebuild_status")
    .in("category", NON_FOOD_CATEGORIES)
    .neq("registration_status", "판매중지")
    .order("sort_order").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
// 아직 고시가 없는 것 + 초록누리에서 못 찾아 보류된 것
const targets = all
  .filter((p) => p.purchase_url && (p.rebuild_status !== "조사완료"))
  .slice(0, Number.isFinite(MAX) ? MAX : undefined);
console.log(`[gmarket] 비식품 ${all.length}개 중 대상 ${targets.length}개`);

const browser = await stealth.launch({ headless: false, channel: "chrome" });
const ctx = await browser.newContext({ locale: "ko-KR", viewport: { width: 1400, height: 900 } });
const renderer = DRY ? null : await chromium.launch({ headless: true });
let ok = 0, fail = 0;

for (const p of targets) {
  let notice = null;
  try {
    const page = await ctx.newPage();
    await page.goto(p.purchase_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1800);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(250); }
    await page.waitForTimeout(1500);
    notice = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll(".box__product-notice table tr, .table_productinfo tr").forEach((tr) => {
        const th = tr.querySelector("th")?.innerText.trim();
        const td = tr.querySelector("td")?.innerText.trim();
        if (th && td && !out[th]) out[th] = td;
      });
      return out;
    });
    await page.close();
  } catch (e) {
    console.log(`  ✗ ${p.product_name} — 페이지 오류: ${e instanceof Error ? e.message : String(e)}`);
    fail++;
    continue;
  }

  const 품명 = notice["품명 및 모델명"];
  const 제조자 = notice["제조자/수입자"];
  const 제조국 = notice["제조국 또는 원산지"] || notice["원산지"];
  const 허가 = notice["허가 관련"];
  const 참조 = (v) => !v || /상세(페이지|설명)\s*참[조고]|해당없음|^-$/.test(v) ? "" : v;
  if (process.argv.includes("--debug")) console.log("    [debug]", JSON.stringify(notice));

  if (!참조(제조자) && !참조(제조국) && !참조(품명)) {
    console.log(`  · 보류 ${p.product_name} — 지마켓 고시표도 "상세페이지 참조" [검수필요-수동조사]`);
    if (!DRY) await sb.from("products").update({ item_info: { 스킵사유: "지마켓 고시표가 비어 있음 [검수필요-수동조사]", 재시도대상: true } }).eq("id", p.id);
    fail++;
    continue;
  }

  // 초록누리에서 이미 받아둔 정보가 있으면 그 위에 덧입힌다 (초록누리 값 우선)
  const prev = p.item_info && !p.item_info.스킵사유 ? p.item_info : {};
  const info = {
    ...prev,
    품목군: prev.품목군 ?? "기타재화",
    품명및모델명: prev.품명및모델명 || 참조(품명) || p.product_name,
    중량용량: prev.중량용량 || extractSize(p.product_name),
    제조국: prev.제조국 || 참조(제조국) || "제품 표기 참조",
    제조회사: prev.제조회사 || 참조(제조자) || "제품 표기 참조",
    인증허가: prev.인증허가 || 참조(허가) || "해당사항 없음",
    품질보증기준: prev.품질보증기준 ?? "관련 법 및 소비자분쟁해결기준에 따름",
    소비자상담번호: SELLER_PHONE,
    출처: prev.출처
      ? `${prev.출처} / 제조사·제조국은 판매처 상품정보제공고시 확인, ${TODAY}`
      : `제조사·제조국은 판매처 상품정보제공고시 확인, ${TODAY} 조회`,
  };

  console.log(`  ✓ ${p.product_name} → ${info.제조회사} / ${info.제조국}`);
  ok++;
  if (DRY) continue;

  const html = buildDetailHtml(p.product_name, p.thumbnail_url, info);
  await sb.from("products")
    .update(html ? { item_info: info, rebuild_status: "조사완료", detail_html: html } : { item_info: info, rebuild_status: "조사완료" })
    .eq("id", p.id);

  if (html && renderer) {
    try {
      let capture = html;
      if (p.thumbnail_url) {
        const uri = await toDataUri(p.thumbnail_url);
        if (uri) capture = capture.split(p.thumbnail_url).join(uri);
      }
      const rctx = await renderer.newContext({ viewport: { width: 1000, height: 800 } });
      const rpage = await rctx.newPage();
      await rpage.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;}</style></head><body>${capture}</body></html>`, { waitUntil: "load" });
      const h = await rpage.evaluate(() => document.body.scrollHeight);
      await rpage.setViewportSize({ width: 1000, height: Math.max(h, 100) });
      const shot = await rpage.screenshot({ fullPage: true, type: "png" });
      await rctx.close();
      const sp = `products/${p.user_id}/ai_detail_${Date.now()}_${p.id.slice(0, 8)}.png`;
      await sb.storage.from("product-images").upload(sp, shot, { contentType: "image/png", upsert: true });
      const { data: { publicUrl } } = sb.storage.from("product-images").getPublicUrl(sp);
      await sb.from("products").update({ detail_image_url: publicUrl }).eq("id", p.id);
    } catch (e) {
      console.log(`    (렌더 실패: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

await browser.close();
if (renderer) await renderer.close();
console.log(`\n[gmarket] 완료 — 확보 ${ok} / 실패·보류 ${fail}`);
