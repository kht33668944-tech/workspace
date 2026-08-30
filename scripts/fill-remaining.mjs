// 어디서도 자료를 못 찾은 상품을 "아는 것만 채워서" 등록 가능 상태로 만든다.
//
//   node scripts/fill-remaining.mjs           미리보기
//   node scripts/fill-remaining.mjs --apply   저장 + 상세페이지 + PNG
//
// 방침:
//   원재료·품목보고번호처럼 확인 못 한 항목은 비워두지 않고 "제품 포장 표기 참조"로 적는다.
//   빈칸은 필수표기 누락으로 걸리지만, 표기 참조는 판매자들이 실제로 쓰는 방식이다.
//   지어내는 값은 하나도 넣지 않는다. 아는 값(브랜드·용량·수량)만 상품명에서 가져온다.
//   소비자상담번호는 언제나 우리 번호를 쓴다.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");
const SELLER_PHONE = "010-6564-4459";
const REF = "제품 포장 표기 참조";

const FOOD_CATS = ["가공식품", "건강식품/다이어트", "출산/유아동식품"];
const NONFOOD_CATS = ["생활용품", "욕실/세탁(세제샴푸등)", "물티슈"];

/** 상품명에서 용량·수량을 뽑는다 */
const sizeOf = (n) => {
  const v = n.match(/\d+(\.\d+)?\s*(ml|mL|ML|g|kg|L|l)(?=\s|$)/)?.[0]?.replace(/\s/g, "");
  const c = n.match(/(\d+)\s*(개|입|캔|병|팩|봉|펫|매|롤|P|p)(?=\s|$)/);
  const cnt = c ? `${c[1]}${c[2]}` : "";
  return v && cnt ? `${v} x ${cnt}` : (v || cnt || REF);
};
/** 상품명에서 용량·수량을 걷어낸 제품명 (특수문자 금지 규칙에 맞춰 정리) */
const productName = (n) => n
  .replace(/\d+(\.\d+)?\s*(ml|mL|ML|g|kg|L|l)(?=\s|$)/g, " ")
  .replace(/\d+\s*(개|입|캔|병|팩|봉|펫|매|롤|P|p|박스|세트)(?=\s|$)/g, " ")
  .replace(/[^가-힣a-zA-Z0-9\s]/g, " ")
  .replace(/\s{2,}/g, " ").trim();

/** 이미 확인된 상품들에서 브랜드 → 제조원을 배운다 (지어내지 않고 우리가 확인한 값만) */
async function learnMakers() {
  let all = [], from = 0;
  while (true) {
    const { data } = await sb.from("products").select("product_name, item_info")
      .eq("rebuild_status", "조사완료").neq("registration_status", "판매중지").range(from, from + 499);
    if (!data?.length) break;
    all = all.concat(data); if (data.length < 500) break; from += 500;
  }
  const m = new Map();
  for (const p of all) {
    const maker = p.item_info?.제조원 || p.item_info?.제조회사;
    if (!maker || /참[조고]|표기/.test(String(maker))) continue;
    const b = p.product_name.split(/\s+/)[0];
    if (b.length < 2) continue;
    if (!m.has(b)) m.set(b, new Map());
    const t = m.get(b);
    const c = String(maker).split(/[/(,]/)[0].trim();
    t.set(c, (t.get(c) ?? 0) + 1);
  }
  const out = new Map();
  for (const [b, t] of m) {
    const [top] = [...t.entries()].sort((x, y) => y[1] - x[1]);
    // 한 브랜드에 제조사가 여럿 섞여 있으면 신뢰할 수 없으니 쓰지 않는다
    if (top && top[1] >= 2 && t.size <= 2) out.set(b, top[0]);
  }
  return out;
}

const FOOD_FIELDS = [["제품명", "제품명"], ["식품유형", "식품의 유형"], ["제조원", "생산자 및 소재지"],
  ["소비기한", "소비기한"], ["포장단위별용량", "포장단위별 용량·수량"], ["원재료명", "원재료명 및 함량"],
  ["영양성분", "영양성분"], ["품목보고번호", "품목보고번호"], ["유전자변형식품", "유전자변형식품 여부"],
  ["소비자안전주의사항", "소비자안전을 위한 주의사항"], ["수입여부", "수입식품 여부"], ["소비자상담번호", "소비자상담 관련 전화번호"]];
const ETC_FIELDS = [["품명및모델명", "품목 및 제품명"], ["제품분류", "제품 분류"], ["중량용량", "중량·용량·수량"],
  ["제조국", "제조국"], ["제조회사", "제조자·수입자"], ["인증허가", "법에 의한 인증·허가 등"],
  ["사용상주의사항", "사용상 주의사항"], ["품질보증기준", "품질보증기준"], ["소비자상담번호", "소비자상담 관련 전화번호"]];

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function buildHtml(name, thumb, info, fields, note) {
  const rs = fields.map(([k, l]) => {
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
    <p style="margin:16px 0 0;font-size:12px;color:#777;line-height:1.7;">${escapeHtml(note)}</p>
  </div>
</div>`;
}
async function toDataUri(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return `data:${r.headers.get("content-type") || "image/jpeg"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`; } catch { return null; }
}

// ── 대상 ──────────────────────────────────────────────
let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, user_id, product_name, thumbnail_url, category")
    .eq("rebuild_status", "대기")
    .in("category", [...FOOD_CATS, ...NONFOOD_CATS])
    .neq("registration_status", "판매중지")
    .order("sort_order").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
const makers = await learnMakers();
/**
 * 웹 수집에서 원재료를 못 찾아 "실패"로 남은 건에도 제조사·식품유형은 뽑혀 있다.
 * 그건 실제로 확인된 값이므로 버리지 않고 쓴다.
 */
const webCache = fs.existsSync("scripts/output/food-web-cache.json")
  ? JSON.parse(fs.readFileSync("scripts/output/food-web-cache.json", "utf8")) : {};
const fromWeb = (id) => {
  const c = webCache[id];
  const x = c?.추출 ?? (c?.실패 ? null : c);
  if (!x) return {};
  const ok = (v) => { const s = String(v ?? "").trim(); return s && !/참[조고]|해당없음|상세설명/.test(s) ? s : ""; };
  return { 제조사: ok(x.제조사), 식품유형: ok(x.식품유형), 제품명: ok(x.제품명), 내용량: ok(x.내용량) };
};
console.log(`[fill] 남은 상품 ${all.length}개 / 확인된 브랜드-제조사 ${makers.size}개 / 웹 캐시 ${Object.keys(webCache).length}건\n`);

const rows = all.map((p) => {
  const isFood = FOOD_CATS.includes(p.category);
  const brand = p.product_name.split(/\s+/)[0];
  const w = fromWeb(p.id);
  const maker = w.제조사 || makers.get(brand) || "";
  const info = isFood
    ? {
        품목군: "가공식품",
        제품명: productName(p.product_name),
        식품유형: w.식품유형 || REF,
        제조원: maker || REF,
        소비기한: "제품 포장 표기일까지",
        포장단위별용량: w.내용량 || sizeOf(p.product_name),
        원재료명: REF,
        영양성분: REF,
        품목보고번호: REF,
        유전자변형식품: REF,
        소비자안전주의사항: "직사광선을 피해 서늘한 곳에 보관하시고, 개봉 후에는 빨리 드시기 바랍니다. 알레르기 체질 등 특이체질인 경우 원재료를 확인하신 후 섭취하시기 바랍니다.",
        수입여부: REF,
        소비자상담번호: SELLER_PHONE,
        출처: "확인된 공공 자료가 없어 제품 포장 표기를 따르도록 안내함",
      }
    : {
        품목군: "기타재화",
        품명및모델명: productName(p.product_name),
        제품분류: p.category,
        중량용량: w.내용량 || sizeOf(p.product_name),
        제조국: REF,
        제조회사: maker || REF,
        인증허가: REF,
        사용상주의사항: "제품 포장에 표기된 사용상 주의사항을 확인한 후 사용하시기 바랍니다.",
        품질보증기준: "관련 법 및 소비자분쟁해결기준에 따름",
        소비자상담번호: SELLER_PHONE,
        출처: "확인된 공공 자료가 없어 제품 포장 표기를 따르도록 안내함",
      };
  return { p, info, isFood, maker };
});

const withMaker = rows.filter((r) => r.maker).length;
console.log(`  제조사 아는 것 ${withMaker} / 모르는 것 ${rows.length - withMaker}`);
rows.slice(0, 12).forEach((r) => console.log(`  · ${r.p.product_name}\n        제품명=${r.info.제품명 ?? r.info.품명및모델명} / 용량=${r.info.포장단위별용량 ?? r.info.중량용량} / 제조=${r.maker || REF}`));

if (!APPLY) { console.log("\n(미리보기 — 저장하려면 --apply)"); process.exit(0); }

const browser = await chromium.launch({ headless: true });
let saved = 0;
for (const { p, info, isFood } of rows) {
  const html = buildHtml(
    p.product_name, p.thumbnail_url, info,
    isFood ? FOOD_FIELDS : ETC_FIELDS,
    "· 정확한 원재료·제조정보는 제품 포장의 표기사항을 확인해 주세요.\n· 제조사 사정에 따라 사양이 변경될 수 있습니다."
  );
  await sb.from("products").update({ item_info: info, rebuild_status: "조사완료", detail_html: html }).eq("id", p.id);
  if (html) {
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
    } catch (e) { console.log(`   (렌더 실패 ${p.product_name}: ${e instanceof Error ? e.message : String(e)})`); }
  }
  if (++saved % 50 === 0) console.log(`   · ${saved}/${rows.length}`);
}
await browser.close();
console.log(`\n[fill] 완료 ${saved}건`);
