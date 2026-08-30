// 보류 식품을 "제조사까지 맞을 때만" 식약처 자료에 붙인다.
//
//   node scripts/food-rematch.mjs            미리보기
//   node scripts/food-rematch.mjs --apply    저장 + 상세페이지 + PNG
//
// 왜 제조사가 필요한가:
//   식약처에는 "멸균우유"라는 이름이 수백 개 있고 회사만 다르다.
//   이름만 맞추면 서울우유가 매일유업으로 붙는다. 실제로 그렇게 붙었었다.
//
// 두 갈래로 찾는다:
//   ① 식약처 제품명에 브랜드가 들어있는 경우 → 그 안에서만 고른다 (비비고, 팔도…)
//   ② 브랜드가 빠진 경우 → 제조사가 일치하는 것만 고른다 (해찬들 → "구수한 가정식 집된장")
// 어느 쪽이든 후보가 둘 이상이면 손대지 않는다. 맛·용량 변형을 찍는 것보다 빈칸이 낫다.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");
const SELLER_PHONE = "010-6564-4459";

const load = (n) => { const f = `scripts/output/mfds-${n}.json`; return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []; };
const C002 = load("C002"), C005 = load("C005"), C006 = load("C006");
const rows = [...C002, ...C005, ...C006];
console.log(`[rematch] 식약처 캐시 ${rows.length.toLocaleString()}건`);

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "");

/**
 * 브랜드 → 제조사. 식약처 집계와 웹 확인을 함께 거친 값만 넣는다.
 * 값이 없는 브랜드(수입품·PB 등)는 ②번 갈래를 쓰지 않는다.
 */
const BRAND_MAKER = {
  오뚜기: /오뚜기/, 진라면: /오뚜기/,
  해찬들: /씨제이제일제당/, 비비고: /씨제이제일제당|씨제이씨푸드/, 백설: /씨제이제일제당/,
  햇반: /씨제이제일제당/, 씨제이: /씨제이제일제당/, cj: /씨제이제일제당/,
  핫식스: /롯데칠성음료/, 펩시콜라: /롯데칠성음료/, 펩시제로: /롯데칠성음료/, 펩시: /롯데칠성음료/,
  트레비: /롯데칠성음료/, 칸타타: /롯데칠성음료/, 레쓰비: /롯데칠성음료/, 아이시스: /롯데칠성음료/,
  강원평창수: /롯데칠성음료/,
  마가렛트: /롯데웰푸드/, 파스퇴르: /롯데웰푸드/, 롯데웰푸드: /롯데웰푸드/,
  샘표: /샘표식품/, 폰타나: /샘표식품|진성에프엠/,
  서울우유: /서울우유협동조합/, 매일: /매일유업/, 상하목장: /매일유업/,
  나랑드사이다: /동아오츠카/, 오설록: /오설록농장/, 맥심: /동서식품/, 오리온: /오리온/,
  과일촌: /해태에이치티비/, 코코팜: /해태에이치티비/,
  씨그램: /코카콜라음료|한국코카콜라/, 조지아: /코카콜라음료|한국코카콜라/,
  파워에이드: /코카콜라음료|한국코카콜라/, 암바사: /코카콜라음료|한국코카콜라/,
  닥터페퍼: /코카콜라음료|한국코카콜라/, 코크제로: /코카콜라음료|한국코카콜라/,
  제주삼다수: /제주특별자치도개발공사/, 삼다수: /제주특별자치도개발공사/,
  뽀로로: /팔도/, 짬뽕왕뚜껑: /팔도/, 팔도: /팔도/,
  홍초: /^대상|대상\(주\)/, 청정원: /^대상|대상\(주\)/,
  풀무원: /풀무원/, 정식품: /정\.?식품/, 사조해표: /사조/, 사조: /사조/,
  백제: /백제/, 명가김: /삼해상사/, 동원에프앤비: /동원에프앤비|동원에프앤비/,
  농심: /농심/, 삼양: /삼양식품/, 빙그레: /빙그레/, 크라운: /크라운제과/,
};
// 식품이 아니라 여기서 다루면 안 되는 것들
const NOT_FOOD = /헤드앤숄더|존슨즈베이비|존슨앤존슨|리스테린|가그린|치약|샴푸|린스|로션|바디워시/;

const MODIFIER = ["오리지널", "무라벨", "에코무라벨", "에코", "리뉴얼", "신제품", "정품", "국내산",
  "대용량", "기획", "증정", "묶음", "박스", "행사", "본품", "선물세트", "세트", "페트", "봉지", "총"];
const core = (n) => n
  .replace(/\d+(\.\d+)?\s*(ml|g|kg|l|캔|펫|병)(?=\s|$)/gi, " ")
  .replace(/\d+\s*(개|입|봉|팩|캔|병|박스|세트|포|매|펫|리터)(?=\s|$)/g, " ")
  .replace(/\s+/g, " ").trim();
/**
 * 후보 이름의 "○○맛 / ○○향"이 상품명에도 있는지 본다.
 *
 * "오리온 무뚝뚝감자칩"에 "무뚝뚝 감자칩 갈릭솔트맛"이 붙으면 없는 맛을 지어내는 것이다.
 * 반대로 "포카칩 어니언" ↔ "포카칩 어니언맛"은 같은 제품이므로 통과시켜야 한다.
 */
function flavorOk(mine, candName) {
  const flavors = String(candName).match(/[가-힣A-Za-z]+[맛향]/g) ?? [];
  return flavors.every((f) => {
    const stem = norm(f.slice(0, -1));
    return stem.length < 2 || mine.includes(stem);
  });
}
function bigrams(s) { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; }
function dice(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let c = 0; for (const g of A) if (B.has(g)) c++; return 2 * c / (A.size + B.size); }

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, user_id, product_name, thumbnail_url, item_info")
    .eq("rebuild_status", "대기")
    .in("category", ["가공식품", "건강식품/다이어트", "출산/유아동식품"])
    .neq("registration_status", "판매중지")
    .order("sort_order").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}
const targets = all.filter((p) => !NOT_FOOD.test(p.product_name));
console.log(`[rematch] 보류 ${all.length}개 중 식품 ${targets.length}개\n`);

const brandIndex = new Map();
const makerIndex = new Map();
const indexByBrand = (b) => {
  if (!brandIndex.has(b)) brandIndex.set(b, rows.filter((r) => norm(r.nm).includes(b)));
  return brandIndex.get(b);
};
const indexByMaker = (re) => {
  const k = String(re);
  if (!makerIndex.has(k)) makerIndex.set(k, rows.filter((r) => re.test(String(r.bssh ?? ""))));
  return makerIndex.get(k);
};

const picks = [];
let byBrand = 0, byMaker = 0, ambiguous = 0, none = 0;

for (const p of targets) {
  const toks = core(p.product_name).split(/\s+/).filter(Boolean);
  const brandRaw = toks[0] ?? "";
  const brand = norm(brandRaw);
  const ac = norm(core(p.product_name));
  const rest = toks.slice(1).map(norm).filter((t) => t.length >= 2 && !MODIFIER.includes(t));
  const maker = BRAND_MAKER[brand];

  /** 후보를 좁힌다. 하나로 떨어지지 않으면 버린다. */
  const narrow = (pool, minDice) => {
    const scored = pool
      .filter((r) => !/^\(수\)|수출용/.test(String(r.nm)))   // 수출용은 국내 유통 제품이 아니다
      .filter((r) => flavorOk(ac, r.nm))                      // 없는 맛을 붙이지 않는다
      .map((r) => {
        const b = norm(r.nm);
        const cover = rest.length ? rest.filter((t) => b.includes(t)).length / rest.length : 0;
        return { r, cover, d: dice(ac, b) };
      })
      .filter((x) => x.cover >= 0.8 && x.d >= minDice);
    const uniq = new Map();
    for (const x of scored) uniq.set(`${norm(x.r.nm)}|${norm(x.r.bssh)}`, x);
    return [...uniq.values()];
  };

  // ① 브랜드가 식약처 이름에 들어있는 경우
  let hit = null, via = "";
  if (brand.length >= 2) {
    const c = narrow(indexByBrand(brand), 0.8);
    if (c.length === 1) { hit = c[0]; via = "브랜드"; }
    else if (c.length > 1) { ambiguous++; continue; }
  }
  // ② 브랜드가 빠진 경우 — 제조사가 맞는 것만
  if (!hit && maker) {
    const c = narrow(indexByMaker(maker), 0.55);
    if (c.length === 1) { hit = c[0]; via = "제조사"; }
    else if (c.length > 1) { ambiguous++; continue; }
  }
  if (!hit) { none++; continue; }
  via === "브랜드" ? byBrand++ : byMaker++;
  picks.push({ p, r: hit.r, via, d: hit.d.toFixed(2) });
}

console.log(`  ① 브랜드로 확정 ${byBrand}`);
console.log(`  ② 제조사로 확정 ${byMaker}`);
console.log(`  ? 후보 여럿    ${ambiguous}`);
console.log(`  · 못 찾음      ${none}\n`);
picks.forEach((x) => console.log(`  ✓[${x.via}] ${x.p.product_name}\n        → ${x.r.nm}  (${x.r.bssh})  ${x.d}`));

if (!APPLY) { console.log("\n(미리보기 — 저장하려면 --apply)"); process.exit(0); }

// ── 저장 + 상세페이지 + PNG ───────────────────────────
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const DISPLAY = [["제품명", "제품명"], ["식품유형", "식품의 유형"], ["제조원", "생산자 및 소재지"], ["판매원", "판매원"],
  ["소비기한", "소비기한"], ["포장단위별용량", "포장단위별 용량·수량"], ["원재료명", "원재료명 및 함량"],
  ["영양성분", "영양성분"], ["품목보고번호", "품목보고번호"], ["유전자변형식품", "유전자변형식품 여부"],
  ["소비자안전주의사항", "소비자안전을 위한 주의사항"], ["수입여부", "수입식품 여부"], ["소비자상담번호", "소비자상담 관련 전화번호"]];
function buildHtml(name, thumb, info) {
  const rs = DISPLAY.map(([k, l]) => {
    const v = String(info[k] ?? "").replace(/\s*\[검수필요[^\]]*\]/g, "").trim();
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
      · 위 정보는 식품의약품안전처 식품안전나라 품목제조보고 자료를 기준으로 작성되었습니다.<br>
      · 제조사 사정에 따라 원재료·포장이 변경될 수 있으므로 실제 제품 표기사항을 확인해 주세요.
    </p>
  </div>
</div>`;
}
async function toDataUri(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return `data:${r.headers.get("content-type") || "image/jpeg"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`; } catch { return null; }
}
/** 상품명에서 용량·수량을 뽑는다. 용량 표기가 없는 상품("스낵면 40개")은 수량만 쓴다. */
const sizeOf = (n) => {
  const v = n.match(/\d+(\.\d+)?\s*(ml|g|kg|l)(?=\s|$)/i)?.[0]?.replace(/\s/g, "");
  const c = n.match(/(\d+)\s*(개|입|캔|병|팩|봉|펫|봉지)(?=\s|$)/);
  const cnt = c ? `${c[1]}${c[2]}` : "";
  if (v && cnt) return `${v} x ${cnt}`;
  return v || cnt || "제품 표시 참조";
};

// 품목보고번호 → 원재료 (C005에는 원재료가 없어 C002·C006에서 찾아온다)
const rawByNo = new Map();
for (const r of [...C002, ...C006]) {
  if (!r.raw) continue;
  const cur = rawByNo.get(r.no);
  if (!cur || cur.length < r.raw.length) rawByNo.set(r.no, r.raw);
}

const browser = await chromium.launch({ headless: true });
let saved = 0;
for (const { p, r } of picks) {
  // 같은 이름·같은 회사의 기록을 모아 원재료·바코드를 합친다
  const sib = rows.filter((x) => norm(x.nm) === norm(r.nm) && norm(x.bssh) === norm(r.bssh));
  const raws = sib.map((x) => x.raw || rawByNo.get(x.no)).filter(Boolean).sort((a, b) => b.length - a.length);
  const bars = [...new Set(sib.map((x) => x.bar).filter(Boolean))];
  const info = {
    품목군: "가공식품",
    제품명: r.nm,
    식품유형: r.dc || "",
    제조원: r.bssh || "",
    판매원: r.bssh || "",
    소비기한: r.pog ? `제조일로부터 ${r.pog} (표시일까지)` : "제품 표시일까지",
    포장단위별용량: sizeOf(p.product_name),
    원재료명: raws[0] ?? "",
    품목보고번호: [...new Set(sib.map((x) => x.no))].map((n) => `${n}(${r.bssh})`).join(", "),
    유전자변형식품: "해당없음",
    소비자안전주의사항: "직사광선을 피해 서늘한 곳에 보관, 개봉 후 빨리 드시기 바랍니다.",
    수입여부: "국내산",
    소비자상담번호: SELLER_PHONE,
    출처: `식품의약품안전처 품목제조보고 (제조사 대조 확인), ${new Date().toISOString().slice(0, 10)} 조회`,
  };
  if (bars.length) { info.바코드 = bars[0]; info.바코드_후보 = bars.slice(0, 8).join(", "); }

  const html = buildHtml(p.product_name, p.thumbnail_url, info);
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
  saved++;
}
await browser.close();
console.log(`\n[rematch] 저장 ${saved}건`);
