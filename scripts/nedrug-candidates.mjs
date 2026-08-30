// 자동으로 특정하지 못한 의약외품에 대해 "고를 수 있는 후보 목록"을 뽑는다.
//
//   node scripts/nedrug-candidates.mjs
//     → scripts/output/의약외품_후보.md  (사람이 읽고 고르는 표)
//       scripts/output/의약외품_후보.json (고른 뒤 적용할 원본)
//
// 왜 자동으로 못 하나:
//   허가명이 상품명과 체계가 다르다. "좋은느낌 생리대 오리지널 수퍼롱 오버나이트"의
//   허가명은 "뉴좋은느낌수퍼롱"이고, 같은 제품이 제조소별로 여러 허가를 갖기도 한다.
//   여기서 더 밀어붙이면 엉뚱한 허가번호가 고시에 박히므로 사람이 확인하게 둔다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const UA = { "User-Agent": "Mozilla/5.0", "Accept-Language": "ko-KR" };

const MEDIC_RE = /생리대|탐폰|팬티라이너|오버나이트|바디피트|안심숙면팬티|순면커버|유기농순면|치약|가글|구강청결/;

function parseRows(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]
    .replace(/<[^>]+>/g, "|").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\|+/g, "|").replace(/[ \t]+/g, " ").replace(/\s*\|\s*/g, "|").trim());
  return rows.filter((s) => /\|품목기준코드\|\d/.test(s)).map((s) => {
    const p = s.split("|");
    const f = (label) => {
      const i = p.indexOf(label);
      if (i < 0) return "";
      for (let j = i + 1; j < Math.min(i + 4, p.length); j++) if (p[j].trim()) return p[j].trim();
      return "";
    };
    return { nm: f("제품명"), co: f("업체명"), code: f("품목기준코드"), date: f("허가일"), state: f("취소/취하구분") };
  }).filter((r) => r.nm && /^\d+$/.test(r.code) && !/^\d+\./.test(r.nm) && r.nm.length <= 60);
}

async function search(word, pages = 30) {
  const out = [], seen = new Set();
  for (let p = 1; p <= pages; p++) {
    let rows = [];
    try {
      const r = await fetch(`https://nedrug.mfds.go.kr/searchDrug?searchYn=true&itemName=${encodeURIComponent(word)}&page=${p}`, { headers: UA });
      rows = parseRows(await r.text());
    } catch { break; }
    if (!rows.length) break;
    let fresh = 0;
    for (const r of rows) if (!seen.has(r.code)) { seen.add(r.code); out.push(r); fresh++; }
    if (!fresh) break;
    await new Promise((s) => setTimeout(s, 120));
  }
  return out;
}

function unifySize(s) {
  return String(s ?? "")
    .replace(/(^|\s)XL(?=\s|$)/gi, "$1특대형").replace(/(^|\s)L(?=\s|$)/g, "$1대형")
    .replace(/(^|\s)M(?=\s|$)/g, "$1중형").replace(/미디움|미디엄/g, "중형")
    .replace(/라지/g, "대형").replace(/수퍼/g, "슈퍼");
}
const norm = (s) => unifySize(s).toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
function bigrams(s) { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; }
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let c = 0; for (const g of A) if (B.has(g)) c++;
  return (2 * c) / (A.size + B.size);
}
const core = (n) => unifySize(n)
  .replace(/\d+(\.\d+)?\s*(ml|g|kg|cm|매|P|p|입|팩)(?=\s|$)/gi, " ")
  .replace(/\d+\s*(개|팩|입|박스|세트)(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();

let all = [], from = 0;
while (true) {
  const { data } = await sb.from("products")
    .select("id, product_name, item_info, rebuild_status")
    .in("category", ["생활용품", "욕실/세탁(세제샴푸등)", "물티슈"])
    .neq("registration_status", "판매중지")
    .order("sort_order").range(from, from + 499);
  if (!data?.length) break;
  all = all.concat(all.length ? data : data); if (data.length < 500) break; from += 500;
}
const targets = all.filter((p) => p.rebuild_status !== "조사완료" && MEDIC_RE.test(p.product_name));
console.log(`[cand] 미해결 의약외품 ${targets.length}개`);

const cache = new Map();
const out = [];
for (const p of targets) {
  const t = core(p.product_name).split(/\s+/).filter(Boolean);
  // 브랜드(첫 단어)로 넓게 훑고, 점수순으로 후보를 고른다
  const brand = t[0] === "유한킴벌리" ? (t[1] ?? t[0]) : t[0];
  if (!cache.has(brand)) { cache.set(brand, await search(brand)); }
  const pool = cache.get(brand).filter((r) => /정상/.test(r.state));
  const a = norm(p.product_name);
  const ranked = pool.map((r) => ({ r, sc: dice(a, norm(r.nm)) })).sort((x, y) => y.sc - x.sc).slice(0, 5);
  out.push({ id: p.id, product: p.product_name, brand, candidates: ranked.map((x) => ({ ...x.r, score: Number(x.sc.toFixed(2)) })) });
  console.log(`  · ${p.product_name} — 후보 ${ranked.length}`);
}

fs.mkdirSync("scripts/output", { recursive: true });
fs.writeFileSync("scripts/output/의약외품_후보.json", JSON.stringify(out, null, 2));

const md = ["# 의약외품 허가 후보 — 확인 필요", "",
  "자동으로 특정하지 못한 상품입니다. 각 상품마다 맞는 허가를 하나 고르시면 됩니다.",
  "맞는 게 없으면 `없음`이라고 적어 주세요.", ""];
for (const o of out) {
  md.push(`## ${o.product}`, "");
  if (!o.candidates.length) { md.push("후보 없음 — 이 이름으로 허가된 품목이 없습니다.", ""); continue; }
  md.push("| 고름 | 허가 제품명 | 제조사 | 품목기준코드 | 허가일 | 유사도 |", "|---|---|---|---|---|---|");
  o.candidates.forEach((c) => md.push(`| ☐ | ${c.nm} | ${c.co} | ${c.code} | ${c.date} | ${c.score} |`));
  md.push("");
}
fs.writeFileSync("scripts/output/의약외품_후보.md", md.join("\n"));
console.log(`\n[cand] 저장 — scripts/output/의약외품_후보.md (${out.length}개 상품)`);
