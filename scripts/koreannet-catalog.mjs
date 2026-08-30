// 코리안넷(GS1 Korea 유통상품 표준DB)에서 브랜드별 상품 카탈로그를 통째로 받아 캐시한다.
//
//   node scripts/koreannet-catalog.mjs 피죤 다우니 ...
//
// 코리안넷 검색은 "입력한 문구 전체"가 상품명/업체명에 들어가야 걸린다.
// 여러 낱말로 찾으면 0건이 나오므로, 브랜드 한 낱말로 전부 받아 두고 로컬에서 맞춘다.
// 페이지가 서버 렌더링 HTML이라 브라우저 없이 fetch로 충분하다.
import fs from "fs";

const FILE = "scripts/output/koreannet-catalog.json";
const BASE = "https://www.koreannet.or.kr/front/allproduct/prodSrchList.do";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function loadCatalog() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}

async function getPage(kw, n, retry = 0) {
  try {
    const r = await fetch(`${BASE}?searchText=${encodeURIComponent(kw)}&pageNum=${n}`, {
      headers: { "User-Agent": UA, "Accept-Language": "ko-KR" }, signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const html = await r.text();
    const total = Number((html.match(/총\s*:\s*([\d,]+)건/) || [])[1]?.replace(/,/g, "") ?? 0);
    const rows = [];
    const re = /<div class="num">(\d{8,14})<\/div>\s*<div class="nm">([\s\S]*?)<\/div>([\s\S]{0,600}?)<\/li>/g;
    let m;
    while ((m = re.exec(html))) {
      const cat = (m[3].match(/class="cate"[^>]*>([\s\S]*?)</) || [])[1] ?? "";
      rows.push({ bar: m[1], nm: m[2].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(), cat: cat.trim() });
    }
    return { total, rows };
  } catch (e) {
    if (retry < 3) { await new Promise((s) => setTimeout(s, 1500 * (retry + 1))); return getPage(kw, n, retry + 1); }
    console.error(`[koreannet] ${kw} p${n} 실패: ${e instanceof Error ? e.message : String(e)}`);
    return { total: 0, rows: [] };
  }
}

async function fetchBrand(kw, maxPage) {
  const first = await getPage(kw, 1);
  const pages = Math.min(maxPage, Math.ceil(first.total / 10) || 1);
  const all = [...first.rows];
  for (let n = 2; n <= pages; n += 5) {
    const batch = await Promise.all(Array.from({ length: Math.min(5, pages - n + 1) }, (_, i) => getPage(kw, n + i)));
    for (const b of batch) all.push(...b.rows);
  }
  const seen = new Set();
  return { total: first.total, rows: all.filter((r) => (seen.has(r.bar + r.nm) ? false : seen.add(r.bar + r.nm))) };
}

if (process.argv[1]?.endsWith("koreannet-catalog.mjs")) {
  const kws = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const MAXP = Number(process.env.KN_MAXPAGE ?? 60);
  const cat = loadCatalog();
  const todo = kws.filter((k) => !cat[k]?.length);
  console.log(`[koreannet] 검색어 ${kws.length} / 받을 것 ${todo.length}`);
  const LANES = 4;
  let idx = 0, done = 0;
  await Promise.all(Array.from({ length: LANES }, async () => {
    while (idx < todo.length) {
      const kw = todo[idx++];
      const { total, rows } = await fetchBrand(kw, MAXP);
      cat[kw] = rows;
      done++;
      console.log(`  ${String(done).padStart(3)}/${todo.length} ${kw} — ${rows.length}/${total}건`);
      if (done % 10 === 0) fs.writeFileSync(FILE, JSON.stringify(cat, null, 1));
    }
  }));
  fs.mkdirSync("scripts/output", { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cat, null, 1));
  console.log(`[koreannet] 브랜드 ${Object.keys(cat).length} / 상품 ${Object.values(cat).reduce((a, b) => a + b.length, 0)}건`);
}
