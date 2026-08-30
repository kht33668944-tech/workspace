// 보류 식품의 "제조사"를 판매처(지마켓)에서 긁어 캐시해 둔다.
//
//   node scripts/food-maker-scrape.mjs           이어받기 (이미 받은 건 건너뜀)
//   node scripts/food-maker-scrape.mjs --max 20
//
// 왜 필요한가:
//   식약처 자료에는 "멸균우유"라는 이름이 수백 개 있고 회사만 다르다.
//   이름만 맞추면 서울우유가 매일유업으로 붙는다. 제조사를 알면 그 회사 것만 놓고
//   고를 수 있어 남의 제품이 붙을 여지가 사라진다.
//   지마켓 고시표의 식품 항목은 전부 "상세설명참조"라 쓸 수 없지만,
//   브랜드·제조자·원산지·연락처는 실제로 채워져 있다.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "patchright";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const MAX = arg("--max", Infinity);
const OUT = "scripts/output/food-maker.json";

const WANT = ["브랜드", "제조자/수입자", "제조사/수입자", "제조원", "원산지", "제조국 또는 원산지",
  "관련 연락처", "소비자상담 관련 전화번호", "생산자 및 소재지", "유효일"];
const 참조 = (v) => !v || /상세(설명|페이지)\s*참[조고]|해당(사항)?없음|대상아님|^-$/.test(v) ? "" : v;

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, product_name, purchase_url")
    .eq("rebuild_status", "대기")
    .in("category", ["가공식품", "건강식품/다이어트", "출산/유아동식품"])
    .neq("registration_status", "판매중지")
    .not("purchase_url", "is", null)
    .order("sort_order").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(data); if (data.length < 500) break; from += 500;
}

fs.mkdirSync("scripts/output", { recursive: true });
const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const targets = all.filter((p) => !cache[p.id]).slice(0, Number.isFinite(MAX) ? MAX : undefined);
console.log(`[maker] 보류 ${all.length}개 / 이미 받음 ${Object.keys(cache).length} / 이번 대상 ${targets.length}`);

const browser = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await browser.newContext({ locale: "ko-KR", viewport: { width: 1400, height: 900 } });
let ok = 0, fail = 0, n = 0;

for (const p of targets) {
  try {
    const page = await ctx.newPage();
    await page.goto(p.purchase_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1200);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 2600); await page.waitForTimeout(150); }
    await page.waitForTimeout(1200);
    const pairs = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("table tr, dl").forEach((el) => {
        const k = el.querySelector("th, dt")?.innerText.trim();
        const v = el.querySelector("td, dd")?.innerText.trim();
        if (k && v && k.length < 40) out.push([k.replace(/\s+/g, " "), v.replace(/\s+/g, " ")]);
      });
      return out;
    });
    await page.close();

    const info = {};
    for (const [k, v] of pairs) {
      if (!WANT.includes(k) || info[k]) continue;
      const clean = 참조(v);
      if (clean) info[k] = clean.slice(0, 120);
    }
    cache[p.id] = { name: p.product_name, ...info };
    const maker = info["제조자/수입자"] || info["제조사/수입자"] || info["제조원"] || info["브랜드"] || "";
    console.log(`  ${maker ? "✓" : "·"} ${p.product_name} → ${maker || "(제조사 없음)"}`);
    maker ? ok++ : fail++;
  } catch (e) {
    cache[p.id] = { name: p.product_name, 오류: e instanceof Error ? e.message : String(e) };
    fail++;
    console.log(`  ✗ ${p.product_name} — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (++n % 10 === 0) fs.writeFileSync(OUT, JSON.stringify(cache, null, 2));
}
fs.writeFileSync(OUT, JSON.stringify(cache, null, 2));
await browser.close();
console.log(`\n[maker] 제조사 확보 ${ok} / 실패 ${fail} → ${OUT}`);
