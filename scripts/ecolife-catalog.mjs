// 초록누리 제조사별 신고목록을 통째로 받아 로컬에 캐시한다.
//
//   node scripts/ecolife-catalog.mjs            전체 제조사
//   node scripts/ecolife-catalog.mjs 애경산업    한 곳만
//
// 왜 필요한가:
//   초록누리 검색은 "연속된 문자열"만 맞는다. 등록명이 "리큐 얼룩제거 올인원"이면
//   "리큐 얼룩제거"는 찾지만 "리큐 올인원"은 0건이다. 게다가 브랜드만으로 치면
//   ("다우니" 3,161건) 짝퉁 향 제품이 최신순 앞자리를 다 차지해 진짜 제품이 묻힌다.
//   그래서 제조사(CONM_NM)로 전량을 받아두고 대조는 로컬에서 한다.
import fs from "fs";

const BASE = "https://ecolife.mcee.go.kr";
const LIST_PAGE = `${BASE}/ecolife/chemiProd/safeDclrProd?pMENU_NO=596`;
const OUT = "scripts/output/ecolife-catalog.json";

// 우리가 파는 생활화학제품 브랜드의 신고 주체들
const MANUFACTURERS = [
  "한국피앤지", "애경산업", "라이온코리아", "엘지생활건강", "피죤",
  "헨켈컨슈머", "헨켈홈케어", "유한크로락스", "유한클로락스",
  "켐스필드", "옥시레킷벤키저", "무궁화", "네오팜그린",
];

let COOKIE = "";
async function openSession() {
  const r = await fetch(LIST_PAGE, { headers: { "User-Agent": "Mozilla/5.0" } });
  COOKIE = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  await r.text();
}

async function fetchPage(word, page, retry = 0) {
  try {
    const body = new URLSearchParams({
      pSearchType: "CONM_NM", pSearchWord: word, page: String(page), pOrderby: "REG_DT", pSelectedLi: "",
    });
    const r = await fetch(`${BASE}/ecolife/chemiProd/safeDclrProd/listJson`, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded",
        Cookie: COOKIE, Referer: LIST_PAGE, "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    const j = JSON.parse(await r.text());
    return { total: j.totalCnt ?? 0, list: j.list ?? [] };
  } catch (e) {
    if (retry < 3) {
      await new Promise((s) => setTimeout(s, 1500 * (retry + 1)));
      await openSession();
      return fetchPage(word, page, retry + 1);
    }
    console.log(`  (실패 ${word} p${page}: ${e instanceof Error ? e.message : String(e)})`);
    return { total: 0, list: [] };
  }
}

const unescape = (s) => String(s ?? "")
  .replace(/&#x2F;/g, "/").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

await openSession();
fs.mkdirSync("scripts/output", { recursive: true });

// 이어받기 — 이미 받은 제조사는 건너뛴다
const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const only = process.argv[2];
const targets = only ? MANUFACTURERS.filter((m) => m.includes(only)) : MANUFACTURERS;

for (const co of targets) {
  if (cache[co]?.length && !only) { console.log(`[catalog] ${co} — 캐시 ${cache[co].length}건, 건너뜀`); continue; }
  const first = await fetchPage(co, 1);
  const pages = Math.ceil(first.total / 10);
  console.log(`[catalog] ${co} — ${first.total}건 / ${pages}페이지`);
  const rows = [];
  const push = (list) => list.forEach((r) => rows.push({
    nm: unescape(r.PRDCT_NM), item: unescape(r.ITEM_NM), co: unescape(r.CONM_NM),
    aprv: unescape(r.APRV_NO), id: r.DCLR_MST_ID, unq: r.UNQ_NO, fmtn: unescape(r.FMTN_NM),
  }));
  push(first.list);
  for (let p = 2; p <= pages; p++) {
    const { list } = await fetchPage(co, p);
    if (!list.length) break;
    push(list);
    if (p % 30 === 0) console.log(`   · ${rows.length}/${first.total}`);
    await new Promise((s) => setTimeout(s, 120));
  }
  // 같은 신고번호·같은 이름이 여러 번 올라오므로 중복을 없앤다
  const seen = new Set();
  cache[co] = rows.filter((r) => {
    const k = `${r.nm}|${r.aprv}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`[catalog] ${co} 완료 — ${rows.length}건 → 중복제거 ${cache[co].length}건`);
  fs.writeFileSync(OUT, JSON.stringify(cache));
}

const total = Object.values(cache).reduce((a, v) => a + v.length, 0);
console.log(`\n[catalog] 전체 ${total.toLocaleString()}건 → ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)}MB)`);
