// 품목군에 맞는 서식으로 상세페이지를 다시 만든다.
//
//   node scripts/regen-detail-all.mjs --apply
//
// regenerate-detail-html.mjs 는 식품 서식만 알고 있어서
// 세제·의약외품·기타재화에 돌리면 표가 비어 버린다. 이 스크립트가 품목군별로 나눠 처리한다.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");

const FIELDS = {
  가공식품: [["제품명", "제품명"], ["식품유형", "식품의 유형"], ["제조원", "생산자 및 소재지"], ["판매원", "판매원"],
    ["소비기한", "소비기한"], ["포장단위별용량", "포장단위별 용량·수량"], ["원재료명", "원재료명 및 함량"],
    ["영양성분", "영양성분"], ["품목보고번호", "품목보고번호"], ["유전자변형식품", "유전자변형식품 여부"],
    ["소비자안전주의사항", "소비자안전을 위한 주의사항"], ["수입여부", "수입식품 여부"], ["소비자상담번호", "소비자상담 관련 전화번호"]],
  생활화학제품: [["품명및모델명", "품명 및 모델명"], ["제품분류", "제품 분류"], ["용도", "용도"], ["제형", "제형"],
    ["중량용량", "중량·용량"], ["제조국", "제조국"], ["제조회사", "제조회사"], ["수입자", "수입자"],
    ["인증허가", "법에 의한 인증·허가 등"], ["표준사용량", "표준 사용량"], ["사용방법", "사용방법"],
    ["사용상주의사항", "사용상 주의사항"], ["응급처치", "응급처치"], ["유통기한", "유통기한"],
    ["품질보증기준", "품질보증기준"], ["소비자상담번호", "소비자상담 관련 전화번호"]],
  의약외품: [["품명및모델명", "품목 및 제품명"], ["품목구분", "품목 구분"], ["인증허가", "식약처 허가·신고 여부"],
    ["중량용량", "용량·중량·매수"], ["성상", "성상"], ["효능효과", "효능·효과"], ["사용방법", "사용방법"],
    ["원료", "원료·재질"], ["제조회사", "제조자"], ["사용기한", "사용기한"], ["보관방법", "보관방법"],
    ["사용상주의사항", "사용상 주의사항"], ["품질보증기준", "품질보증기준"], ["소비자상담번호", "소비자상담 관련 전화번호"]],
  기타재화: [["품명및모델명", "품목 및 제품명"], ["제품분류", "제품 분류"], ["중량용량", "중량·용량·수량"],
    ["제조국", "제조국"], ["제조회사", "제조자·수입자"], ["인증허가", "법에 의한 인증·허가 등"],
    ["사용상주의사항", "사용상 주의사항"], ["품질보증기준", "품질보증기준"], ["소비자상담번호", "소비자상담 관련 전화번호"]],
};
FIELDS.축산물 = FIELDS.가공식품;

const NOTE = {
  가공식품: "· 정확한 원재료·제조정보는 제품 포장의 표기사항을 확인해 주세요.<br>· 제조사 사정에 따라 원재료·포장이 변경될 수 있습니다.",
  축산물: "· 정확한 원재료·제조정보는 제품 포장의 표기사항을 확인해 주세요.<br>· 제조사 사정에 따라 원재료·포장이 변경될 수 있습니다.",
  생활화학제품: "· 위 정보는 환경부 화학제품안전포털(초록누리) 안전확인대상 생활화학제품 신고자료를 기준으로 작성되었습니다.<br>· 제조사 사정에 따라 성분·포장이 변경될 수 있으므로 실제 제품 표기사항을 확인해 주세요.",
  의약외품: "· 위 정보는 식품의약품안전처 의약품통합정보시스템 품목허가 자료를 기준으로 작성되었습니다.<br>· 제조사 사정에 따라 사양·포장이 변경될 수 있으므로 실제 제품 표기사항을 확인해 주세요.",
  기타재화: "· 정확한 제조정보는 제품 포장의 표기사항을 확인해 주세요.<br>· 제조사 사정에 따라 사양이 변경될 수 있습니다.",
};

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const strip = (v) => String(v ?? "").replace(/\s*\[검수필요[^\]]*\]/g, "").replace(/\s{2,}/g, " ").trim();

function build(name, thumb, info) {
  const kind = info.품목군 ?? "가공식품";
  const rows = (FIELDS[kind] ?? FIELDS.가공식품).map(([k, l]) => {
    const v = strip(info[k]);
    if (!v) return null;
    return `<tr><td style="padding:10px 16px;background:#f8f8f8;font-weight:bold;border:1px solid #e0e0e0;width:160px;vertical-align:top;white-space:nowrap;word-break:keep-all;">${escapeHtml(l)}</td><td style="padding:10px 16px;border:1px solid #e0e0e0;vertical-align:top;line-height:1.8;">${escapeHtml(v)}</td></tr>`;
  }).filter(Boolean);
  if (!rows.length) return null;
  const t = thumb ? `<div style="text-align:center;padding:20px 0;"><img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" style="max-width:800px;width:100%;height:auto;display:block;margin:0 auto;"></div>` : "";
  return `<div style="max-width:1000px;margin:0 auto;font-family:'맑은 고딕',sans-serif;font-size:14px;color:#333;background:#fff;">
  <div style="background:#222;color:#fff;padding:16px 20px;text-align:center;"><h2 style="margin:0;font-size:18px;font-weight:bold;">${escapeHtml(name)}</h2></div>
  ${t}
  <div style="padding:20px;">
    <h3 style="font-size:15px;border-bottom:2px solid #222;padding-bottom:8px;margin-bottom:0;">상품정보제공고시</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">${rows.join("\n")}</table>
    <p style="margin:16px 0 0;font-size:12px;color:#777;line-height:1.7;">${NOTE[kind] ?? NOTE.기타재화}</p>
  </div>
</div>`;
}
async function toDataUri(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return `data:${r.headers.get("content-type") || "image/jpeg"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`; } catch { return null; }
}

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, user_id, product_name, thumbnail_url, item_info, detail_html")
    .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
console.log(`[regen] 조사완료 ${all.length}개`);
if (!APPLY) {
  const cnt = {};
  for (const p of all) { const k = p.item_info?.품목군 ?? "(없음)"; cnt[k] = (cnt[k] ?? 0) + 1; }
  console.log(cnt, "\n(적용하려면 --apply)");
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
let ok = 0, empty = 0;
for (const p of all) {
  const html = build(p.product_name, p.thumbnail_url, p.item_info ?? {});
  if (!html) { empty++; continue; }
  await sb.from("products").update({ detail_html: html }).eq("id", p.id);
  try {
    let cap = html;
    if (p.thumbnail_url) { const u = await toDataUri(p.thumbnail_url); if (u) cap = cap.split(p.thumbnail_url).join(u); }
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const pg = await ctx.newPage();
    await pg.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;}</style></head><body>${cap}</body></html>`, { waitUntil: "load" });
    const h = await pg.evaluate(() => document.body.scrollHeight);
    await pg.setViewportSize({ width: 1000, height: Math.max(h, 100) });
    const shot = await pg.screenshot({ fullPage: true, type: "png" });
    await ctx.close();
    const sp = `products/${p.user_id}/ai_detail_${Date.now()}_${p.id.slice(0, 8)}.png`;
    await sb.storage.from("product-images").upload(sp, shot, { contentType: "image/png", upsert: true });
    const { data: { publicUrl } } = sb.storage.from("product-images").getPublicUrl(sp);
    await sb.from("products").update({ detail_image_url: publicUrl }).eq("id", p.id);
  } catch (e) { console.log(`  (렌더 실패 ${p.product_name}: ${e instanceof Error ? e.message : String(e)})`); }
  if (++ok % 100 === 0) console.log(`   · ${ok}/${all.length}`);
}
await browser.close();
console.log(`\n[regen] 완료 ${ok} / 표가 비어 건너뜀 ${empty}`);
