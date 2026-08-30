// 상세페이지 HTML은 있는데 PNG(detail_image_url)가 없거나 옛것인 상품을 찾아 렌더링한다.
//   node scripts/render-missing-details.mjs [--all]
//   기본: PNG 없는 것만 / --all: 조사완료 전부 다시
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const ALL = process.argv.includes("--all");

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
    .select("id, user_id, product_name, thumbnail_url, detail_html, detail_image_url")
    .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지")
    .not("detail_html", "is", null)
    .range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
const targets = ALL ? all : all.filter((p) => !p.detail_image_url);
console.log(`[render] 조사완료 ${all.length}건 중 대상 ${targets.length}건`);
if (!targets.length) process.exit(0);

const browser = await chromium.launch({ headless: true });
let ok = 0, fail = 0;
for (const p of targets) {
  try {
    let html = p.detail_html;
    if (p.thumbnail_url) {
      const uri = await toDataUri(p.thumbnail_url);
      if (uri) html = html.split(p.thumbnail_url).join(uri);
    }
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await ctx.newPage();
    await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;}</style></head><body>${html}</body></html>`, { waitUntil: "load" });
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewportSize({ width: 1000, height: Math.max(h, 100) });
    const shot = await page.screenshot({ fullPage: true, type: "png" });
    await ctx.close();

    const sp = `products/${p.user_id}/ai_detail_${Date.now()}_${p.id.slice(0, 8)}.png`;
    const { error: upe } = await sb.storage.from("product-images").upload(sp, shot, { contentType: "image/png", upsert: true });
    if (upe) throw new Error(upe.message);
    const { data: { publicUrl } } = sb.storage.from("product-images").getPublicUrl(sp);
    await sb.from("products").update({ detail_image_url: publicUrl }).eq("id", p.id);
    ok++;
    if (ok % 50 === 0) console.log(`  · ${ok}/${targets.length}`);
  } catch (e) {
    fail++;
    console.log(`  실패 ${p.product_name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
await browser.close();
console.log(`[render] 완료 ${ok} / 실패 ${fail}`);
