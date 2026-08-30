// 재생성된 detail_html을 PNG로 렌더링해 detail_image_url을 갱신한다.
// → 워크스페이스 "이미지 관리" 탭의 [상세] 썸네일에 새 상세페이지가 보이게 된다.
//
// 사용법: node scripts/render-detail-images.mjs [개수]
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import { chromium } from "playwright";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const LIMIT = Number(process.argv[2] || 200);

// 썸네일을 data URI로 변환 (외부 URL 로딩 실패로 이미지가 빈 채 캡처되는 것 방지)
async function toDataUri(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") || "image/jpeg";
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

const { data: products, error } = await sb
  .from("products")
  .select("id, user_id, product_name, thumbnail_url, detail_html")
  .eq("rebuild_status", "조사완료")
  .neq("registration_status", "판매중지")
  .not("detail_html", "is", null)
  .order("sort_order")
  .limit(LIMIT);
if (error) { console.error("[render] 조회 실패:", error.message); process.exit(1); }

console.log(`[render] 대상 ${products.length}개 렌더링 시작`);
const browser = await chromium.launch({ headless: true });
let ok = 0, fail = 0;

for (const p of products) {
  try {
    // 캡처용 HTML: 썸네일만 data URI로 치환 (DB의 detail_html은 원본 URL 유지)
    let html = p.detail_html;
    if (p.thumbnail_url) {
      const dataUri = await toDataUri(p.thumbnail_url);
      if (dataUri) html = html.split(p.thumbnail_url).join(dataUri);
    }

    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await ctx.newPage();
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;background:#fff;}</style></head><body>${html}</body></html>`,
      { waitUntil: "load" }
    );
    const height = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewportSize({ width: 1000, height: Math.max(height, 100) });
    const shot = await page.screenshot({ fullPage: true, type: "png" });
    await ctx.close();

    const storagePath = `products/${p.user_id}/ai_detail_${Date.now()}_${p.id.slice(0, 8)}.png`;
    const { error: upErr } = await sb.storage
      .from("product-images")
      .upload(storagePath, shot, { contentType: "image/png", upsert: true });
    if (upErr) throw new Error("업로드 실패: " + upErr.message);

    const { data: { publicUrl } } = sb.storage.from("product-images").getPublicUrl(storagePath);
    const { error: updErr } = await sb.from("products").update({ detail_image_url: publicUrl }).eq("id", p.id);
    if (updErr) throw new Error("DB 갱신 실패: " + updErr.message);

    ok++;
    console.log(`(${ok}/${products.length}) ${p.product_name}`);
  } catch (e) {
    fail++;
    console.log("실패:", p.product_name, e instanceof Error ? e.message : String(e));
  }
}

await browser.close();
console.log(`[render] 완료 ${ok}건 / 실패 ${fail}건`);
