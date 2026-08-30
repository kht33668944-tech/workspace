// 외부(플레이오토 S3) 썸네일을 우리 저장소로 옮긴다.
//
//   node scripts/rehost-thumbnails.mjs
//
// 왜:
//   플레이오토 S3 주소는 만료되면 403이 나고, 그 상태로 올리면
//   "기본이미지는 필수값입니다" / "정상적인 이미지가 아닙니다"로 반려된다.
//   상세페이지 HTML 안의 주소도 같이 바꿔야 이미지가 깨지지 않는다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import sharp from "sharp";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));

const EXTERNAL = /s3-ap-northeast-2\.amazonaws\.com|gmarket|auction|ohou|coupang|11st/;

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, user_id, product_name, thumbnail_url, image_urls, detail_html")
    .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지")
    .range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
const targets = all.filter((p) => p.thumbnail_url && EXTERNAL.test(p.thumbnail_url));
console.log(`[rehost] 외부 썸네일 ${targets.length}개`);

let ok = 0, dead = 0;
for (const p of targets) {
  try {
    const r = await fetch(p.thumbnail_url);
    if (!r.ok) { console.log(`  ✗ ${p.product_name} — 원본 ${r.status} (만료)`); dead++; continue; }
    let buf = Buffer.from(await r.arrayBuffer());
    let type = r.headers.get("content-type") ?? "image/jpeg";
    // Supabase Storage가 못 받는 형식은 jpg로 바꾼다
    if (!/jpeg|jpg|png|webp/.test(type)) { buf = await sharp(buf).jpeg({ quality: 92 }).toBuffer(); type = "image/jpeg"; }
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const sp = `products/${p.user_id}/thumb_${Date.now()}_${p.id.slice(0, 8)}.${ext}`;
    const { error } = await sb.storage.from("product-images").upload(sp, buf, { contentType: type, upsert: true });
    if (error) throw new Error(error.message);
    const { data: { publicUrl } } = sb.storage.from("product-images").getPublicUrl(sp);

    const patch = { thumbnail_url: publicUrl };
    // 상세페이지 안의 옛 주소도 함께 교체한다
    if (p.detail_html?.includes(p.thumbnail_url)) patch.detail_html = p.detail_html.split(p.thumbnail_url).join(publicUrl);
    if (Array.isArray(p.image_urls) && p.image_urls.includes(p.thumbnail_url)) {
      patch.image_urls = p.image_urls.map((u) => (u === p.thumbnail_url ? publicUrl : u));
    }
    // 상세이미지(PNG)는 옛 주소로 그려졌으므로 다시 만들게 비운다
    patch.detail_image_url = null;
    await sb.from("products").update(patch).eq("id", p.id);
    ok++;
    if (ok % 10 === 0) console.log(`   · ${ok}/${targets.length}`);
  } catch (e) {
    console.log(`  ✗ ${p.product_name} — ${e instanceof Error ? e.message : String(e)}`);
    dead++;
  }
}
console.log(`\n[rehost] 옮김 ${ok} / 실패 ${dead}`);
if (dead) console.log("실패한 건은 scripts/fetch-missing-thumbnails.mjs 로 판매처에서 다시 받으면 된다");
