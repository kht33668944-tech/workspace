// 코리안넷 카탈로그에서 상품의 "낱개 바코드"를 찾아 item_info.바코드에 채운다.
//
//   node scripts/koreannet-match.mjs          미리보기
//   node scripts/koreannet-match.mjs --apply  저장
//
// 규칙 — 틀린 바코드는 빈칸보다 나쁘다. 애매하면 버린다.
//   1) 용량이 정확히 같아야 한다 (1L=1000ml, 2.5L=2500ml로 환산해 비교)
//   2) 상품명의 구분 낱말(핑크로즈·옐로미모사 …)이 후보에 전부 들어 있어야 한다
//   3) 후보가 묶음 상품(190ml x 6캔)이면 버린다 — 우리는 낱개 바코드를 쓴다
//   4) 남은 후보의 바코드가 서로 다르면 버린다
import { createClient } from "@supabase/supabase-js";
import { loadCatalog } from "./koreannet-catalog.mjs";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");

const gtinCheck = (d12) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(d12[i]) * (i % 2 ? 3 : 1); return String((10 - (s % 10)) % 10); };
const validGtin = (b) => /^\d{13}$/.test(b) && gtinCheck(b.slice(0, 12)) === b[12];

/** "2.5L", "500ml", "1.35 L" → ml 숫자. g/kg는 g 숫자에 "w" 표시를 붙여 용량과 섞이지 않게 한다 */
function caps(text) {
  const out = new Set();
  const re = /(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|밀리리터|L|l|리터|g|G|그램|kg|KG|킬로그램)(?![a-zA-Z가-힣])/g;
  let m;
  while ((m = re.exec(text))) {
    const v = Number(m[1].replace(",", "."));
    const u = m[2].toLowerCase();
    if (u === "ml" || u === "밀리리터") out.add("v" + v);
    else if (u === "l" || u === "리터") out.add("v" + v * 1000);
    else if (u === "g" || u === "그램") out.add("w" + v);
    else out.add("w" + v * 1000);
  }
  return out;
}

/** 묶음 표기가 있는 후보인가 — "(190ml x 6캔)", "× 6ea", "20병" */
const isBundle = (nm) => /[xX×]\s*\d+\s*(개|캔|병|입|ea|EA|팩|포)?|\d+\s*(캔|병|입|매|포|봉|팩)\s*\)?$/.test(nm) || /\(\s*\d/.test(nm);

const STOP = /^(개|캔|병|펫|입|봉|매|포|팩|세트|기획|증정|리필|용기|겸용|대용량|묶음|무료배송|무라벨)$/;
const tok = (s) => String(s).replace(/[^가-힣A-Za-z0-9]/g, " ").split(/\s+/).filter((t) => t && !STOP.test(t) && !/^\d+$/.test(t));

/** 두 글자 묶음 유사도 (0~1) */
function dice(a, b) {
  const bg = (s) => { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; };
  const A = bg(a), B = bg(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}

// 품목을 설명할 뿐 제품을 구분하지 않는 낱말 — 후보에 없어도 넘어간다
const GENERIC = new Set(["섬유유연제","유연제","세탁세제","액체세탁세제","액체세제","주방세제","세제","세정제",
  "우유","음료","음료수","커피","블랙커피","생수","탄산수","주스","두유","녹차","보리차","식혜",
  "샴푸","린스","로션","바디워시","치약","구강청결제","화장지","물티슈","기저귀",
  "리필","용기","겸용","드럼용","일반용","드럼","일반","대용량","무라벨","페트","캔","병","팩","봉지",
  "고농축","초고농축","향","맛","제품","오리지널","오리지날","스탠다드","에너지","드링크","액","담은","시원한","진한","맑고","신선한","깊은","부드러운","고소한","담백한","인증","겸용"]);

// 이게 한쪽에만 있으면 다른 제품이다 — 맛·기능 구분 낱말
const VARIANT = ["제로","무가당","무첨가","무설탕","디카페인","디카페","카페인","저지방","무지방","라이트","유기농","무항생제","저염","프리미엄",
  "딸기","바나나","초코","초콜릿","커피","포도","사과","레몬","라임","자몽","오렌지","복숭아","망고","파인애플","애플망고","청포도",
  "솔잎","라벤더","로즈","미모사","레몬그라스","라일락","머스크","바닐라","코튼","베리","목련","화이트티","블랙","그린","퍼플","핑크",
  "실내건조","베이킹소다","구연산","항균","탈취","울드라이","저자극","순한","매운","마일드","오리지날"];

/** 용량·묶음수량을 뺀 낱말 목록 */
function words(s) {
  return String(s)
    .replace(/(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|L|l|g|G|kg|KG)(?![a-zA-Z가-힣])/g, " ")
    .replace(/\d+\s*(개|캔|병|펫|입|봉|매|포|팩|종|EA|ea)/g, " ")
    .replace(/[^가-힣A-Za-z0-9]/g, " ")
    .split(/\s+/).filter((t) => t && !STOP.test(t) && !/^\d+$/.test(t));
}
const core = (s) => words(s).join("");

/** 낱말이 후보 이름 안에 있는가 — 어미 한 글자 차이는 같은 것으로 본다 */
function has(cn, t) {
  if (cn.includes(t)) return true;
  // 어미 한 글자 차이(가려운/가려움)는 같은 것으로 본다. 숫자가 붙은 낱말(금3)은 그대로 비교한다.
  if (t.length >= 3 && !/\d/.test(t) && cn.includes(t.slice(0, -1))) return true;
  return false;
}

/** "200g x 6개입" 같은 묶음 표기에서 [낱개용량, 개수]를 뽑는다 */
function bundleOk(nm, myCaps, cnt) {
  const b = bundleSpec(nm);
  return !!(b && cnt && b.n === cnt && myCaps.has(b.cap));
}
function bundleSpec(nm) {
  const m = nm.match(/(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|L|l|g|G|kg|KG)\s*[xX×]\s*(\d+)/);
  if (!m) return null;
  return { cap: [...caps(m[1] + m[2])][0], n: Number(m[3]) };
}
/** 상품명 끝의 묶음 개수 */
function myCount(name) {
  const m = String(name).match(/(\d+)\s*(개|캔|병|펫|입|봉|매|포|팩)\s*$/);
  return m ? Number(m[1]) : 0;
}

function match(name, rows, hint = "") {
  const myCaps = caps(name + " " + hint);
  if (!myCaps.size) return { why: "상품명에 용량 없음" };
  const my = words(name);
  const myCore = core(name);
  if (myCore.length < 3) return { why: "구분 낱말 부족" };
  const myFlat = myCore;
  const need = my.filter((t) => !GENERIC.has(t));
  const myVar = VARIANT.filter((v) => myFlat.includes(v));
  const cnt = myCount(name);

  const hits = [], why = new Map();
  for (const r of rows) {
    if (!validGtin(r.bar)) continue;
    if (isBundle(r.nm) && !bundleOk(r.nm, myCaps, cnt)) continue;
    const bs = bundleSpec(r.nm);
    if (bs) {
      // 묶음 바코드는 "낱개 용량 x 개수"가 우리 상품과 똑같을 때만 쓴다
      if (!cnt || bs.n !== cnt || !myCaps.has(bs.cap)) continue;
    } else {
      const rc = caps(r.nm);
      if (!rc.size || ![...myCaps].some((c) => rc.has(c))) continue;   // 용량이 정확히 같아야 한다
    }
    const cn = words(r.nm).join("");
    // 1) 우리 쪽 구분 낱말이 후보에 다 있어야 한다 (앞자리 회사명 하나는 빠져도 봐준다)
    const miss = need.filter((t) => !has(cn, t));
    if (miss.length > 1 || (miss.length === 1 && (miss[0] !== need[0] || need.length < 3))) { why.set(r.bar, `낱말 부족 ${miss.join(",")} — ${r.nm}`); continue; }
    // 2) 후보에만 있는 맛·기능 낱말이 있으면 다른 제품이다.
    //    단 우리 상품명에 맛 정보가 아예 없으면 이 걸러내기를 쓰지 않는다 —
    //    안 그러면 목록에 없는 맛(블루비앙카) 하나만 살아남아 엉뚱한 걸 고른다.
    const cross = VARIANT.filter((v) => cn.includes(v) && !myVar.includes(v));
    if (cross.length) { why.set(r.bar, `후보에만 ${cross.join(",")} — ${r.nm}`); continue; }
    // 3) 후보에만 있는 구분 낱말이 있으면 다른 제품이다 (앞자리 회사명·영문은 뺀다)
    const cw = words(r.nm);
    const extra = cw.slice(1).filter((t) => !GENERIC.has(t) && !/^[A-Za-z0-9]+$/.test(t) && !my.some((x) => has(x, t) || has(t, x)));
    if (extra.length) { why.set(r.bar, `후보에만 ${extra.join(",")} — ${r.nm}`); continue; }
    hits.push({ ...r, s: dice(myCore, core(r.nm)) + (bs ? 0.2 : 0), bundle: !!bs });
  }
  if (!hits.length) return { why: "일치 후보 없음", detail: [...why.values()].slice(0, 2) };
  hits.sort((a, b) => b.s - a.s);
  const top = hits[0];
  const rival = hits.find((h) => h.bar !== top.bar);
  if (rival && top.s - rival.s < 0.15) return { why: `1·2위 접전 (${top.nm} vs ${rival.nm})` };
  return { bar: top.bar, src: top.nm, score: top.s, bundle: top.bundle };
}

const cat = loadCatalog();
const allRows = Object.values(cat).flat();
const miss = JSON.parse(fs.readFileSync("scripts/output/no-barcode.json", "utf8"));

let ok = 0; const fails = [];
const found = [];
for (const p of miss) {
  const kw = (p.brand || p.name.split(/\s+/)[0]).trim();
  const pool = cat[kw]?.length ? cat[kw] : allRows;
  // 이름이 아주 짧은 상품(밀키스)은 브랜드 목록 안에서만 찾는다 — 전체에서 찾으면 엉뚱한 게 걸린다
  if (core(p.name).length < 5 && !cat[kw]?.length) { fails.push({ name: p.name, why: "브랜드 목록 없음(이름 짧음)" }); continue; }
  const r = match(p.name, pool, [p.cap, p.wt].filter(Boolean).join(" "));
  if (r.bar) { found.push({ ...p, bar: r.bar, src: r.src, score: r.score }); ok++; }
  else fails.push({ name: p.name, why: r.why });
}
console.log(`카탈로그 브랜드 ${Object.keys(cat).length} / 상품 ${allRows.length}`);
console.log(`대상 ${miss.length} → 찾음 ${ok} / 못찾음 ${fails.length}\n`);
for (const f of found) console.log(`  ✓ ${f.name}\n        ${f.bar}  ←  ${f.src}`);
const byWhy = {};
for (const f of fails) byWhy[f.why] = (byWhy[f.why] ?? 0) + 1;
console.log("\n== 못 찾은 이유 ==");
for (const [w, n] of Object.entries(byWhy).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${w}`);
fs.writeFileSync("scripts/output/kn-found.json", JSON.stringify(found, null, 1));
fs.writeFileSync("scripts/output/kn-notfound.json", JSON.stringify(fails, null, 1));

if (!APPLY) { console.log("\n(저장하려면 --apply)"); process.exit(0); }
let saved = 0;
for (const f of found) {
  const { data } = await sb.from("products").select("item_info").eq("id", f.id).limit(1);
  const info = { ...(data?.[0]?.item_info ?? {}) };
  info.바코드 = f.bar;
  info.바코드출처 = `코리안넷 GS1 표준DB — ${f.src}`;
  const { error } = await sb.from("products").update({ item_info: info }).eq("id", f.id);
  if (error) console.error(`[kn] 저장 실패 ${f.name}: ${error.message}`); else saved++;
}
console.log(`[kn] 저장 ${saved}건`);
