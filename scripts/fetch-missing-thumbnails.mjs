// 썸네일이 없거나 깨진(403) 상품의 대표 이미지를 원본 판매처에서 가져와 Supabase Storage에 저장.
//
//   node scripts/fetch-missing-thumbnails.mjs           썸네일 없는 상품 전부
//   node scripts/fetch-missing-thumbnails.mjs "상품명" "상품명" ...
//
// 지마켓: 배지 없는 추가이미지(exlarge_moreimg) _00 사용 (대표이미지는 프로모션 배지 합성됨)
// 오늘의집: og:image 사용
import { createClient } from "@supabase/supabase-js";
import { chromium } from "patchright";
import fs from "fs";
import sharp from "sharp";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const names = process.argv.slice(2);

let query = sb.from("products").select("id, user_id, product_name, purchase_url, thumbnail_url, image_urls");
query = names.length > 0 ? query.in("product_name", names) : query.is("thumbnail_url", null);
const { data: products, error } = await query;
if (error) { console.error("[thumbnails] 조회 실패:", error.message); process.exit(1); }

const targets = products.filter((p) => p.purchase_url);
console.log(`[thumbnails] 대상 ${targets.length}개`);
if (targets.length === 0) process.exit(0);

const browser = await chromium.launch({
  headless: false,
  channel: "chrome",
  args: ["--start-maximized"],
});
const context = await browser.newContext({ viewport: null, locale: "ko-KR" });

/** 페이지 HTML에서 이미지 후보 URL 추출 */
async function extractImageUrls(page, url) {
  return page.evaluate(() => {
    const html = document.documentElement.outerHTML.replace(/\\\//g, "/");

    // 지마켓: 배지 없는 추가이미지
    const re = /(?:https?:)?\/\/[^"'\s)\\]*?goods_image2\/[a-z]+_moreimg\/[^"'\s)\\]*?\.(?:jpg|jpeg|png|webp)/gi;
    const seen = new Set();
    const collected = [];
    for (const m of html.match(re) || []) {
      let u = m.split("?")[0];
      if (u.startsWith("//")) u = "https:" + u;
      u = u.replace(/\/[a-z]+_moreimg\//i, "/exlarge_moreimg/");
      if (/icon|logo|btn|blank/.test(u)) continue;
      if (!seen.has(u)) { seen.add(u); collected.push(u); }
    }
    collected.sort();
    if (collected.length > 0) return collected;

    // 그 외(오늘의집 등): og:image
    const og = document.querySelector('meta[property="og:image"]')?.content;
    return og ? [og.split("?")[0]] : [];
  });
}

async function uploadToStorage(imageUrl, storagePath, pageUrl) {
  // CDN이 Referer를 검사한다 → 원본 상품페이지 도메인으로 맞춘다
  const origin = new URL(pageUrl).origin;
  // "//gdimg.gmarket.co.kr/…"처럼 프로토콜이 빠진 주소가 있다
  if (imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;
  else if (imageUrl.startsWith("/")) imageUrl = origin + imageUrl;
  const res = await fetch(imageUrl, {
    headers: {
      Referer: origin + "/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`이미지 다운로드 실패 ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  let contentType = res.headers.get("content-type") || "image/jpeg";
  let finalPath = storagePath;
  // Supabase Storage·쇼핑몰이 못 받는 포맷(avif 등)은 jpeg로 변환한다
  if (!/^image\/(jpeg|jpg|png|webp)$/.test(contentType)) {
    buf = await sharp(buf).jpeg({ quality: 92 }).toBuffer();
    contentType = "image/jpeg";
    finalPath = storagePath.replace(/\.[a-z]+$/i, ".jpg");
  }
  const { error: upErr } = await sb.storage
    .from("product-images")
    .upload(finalPath, buf, { contentType, upsert: true });
  if (upErr) throw new Error(upErr.message);
  return sb.storage.from("product-images").getPublicUrl(finalPath).data.publicUrl;
}

const done = [], failed = [];

for (const p of targets) {
  const page = await context.newPage();
  try {
    await page.goto(p.purchase_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500 + Math.floor(Math.random() * 1500));

    const title = await page.title().catch(() => "");
    if (/잠시만 기다리|Just a moment/.test(title)) {
      // 봇 인터스티셜 — 리로드 후 한 번 더 대기
      await page.waitForTimeout(6000);
    }

    const urls = await extractImageUrls(page, p.purchase_url);
    await page.close();

    if (urls.length === 0) { failed.push([p.product_name, "이미지 못 찾음"]); continue; }

    const ext = urls[0].split(".").pop().replace(/[^a-z]/gi, "").toLowerCase() || "jpg";
    const path = `products/${p.user_id}/${Date.now()}_thumb.${ext}`;
    const publicUrl = await uploadToStorage(urls[0], path, p.purchase_url);

    const { error: updErr } = await sb.from("products")
      .update({ thumbnail_url: publicUrl, image_urls: urls.slice(0, 5) })
      .eq("id", p.id);
    if (updErr) throw new Error(updErr.message);

    done.push([p.product_name, publicUrl]);
    console.log(`  ✓ ${p.product_name}`);
  } catch (e) {
    await page.close().catch(() => {});
    failed.push([p.product_name, e instanceof Error ? e.message : String(e)]);
    console.log(`  ✗ ${p.product_name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

await browser.close();

console.log(`\n[thumbnails] 성공 ${done.length} / 실패 ${failed.length}`);
failed.forEach(([n, why]) => console.log(`   - ${n}: ${why}`));
