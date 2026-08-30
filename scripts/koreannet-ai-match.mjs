// 규칙으로 못 고른 상품을, 용량이 같은 후보만 추려 Gemini에게 고르게 한다.
//
//   node scripts/koreannet-ai-match.mjs           판정만 (사람이 검토)
//   node scripts/koreannet-ai-match.mjs --apply   저장
//
// 후보는 반드시 "용량이 같은 것"만 넣는다 — AI가 용량을 착각할 여지를 없앤다.
// AI가 확신하지 못하면 빈 값을 내도록 하고, 빈 값은 그대로 미해결로 남긴다.
import { createClient } from "@supabase/supabase-js";
import { loadCatalog } from "./koreannet-catalog.mjs";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const KEY = get("GEMINI_API_KEY");
const MODEL = get("GEMINI_MODEL") || "gemini-2.5-flash";
const APPLY = process.argv.includes("--apply");
const CACHE = "scripts/output/kn-ai-cache.json";

const gtinCheck = (d) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 ? 3 : 1); return String((10 - (s % 10)) % 10); };
const validGtin = (b) => /^\d{13}$/.test(b) && gtinCheck(b.slice(0, 12)) === b[12];
function caps(text) {
  const out = new Set(); const re = /(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|L|l|g|G|kg|KG)(?![a-zA-Z가-힣])/g; let m;
  while ((m = re.exec(text))) {
    const v = Number(m[1].replace(",", ".")), u = m[2].toLowerCase();
    if (u === "ml") out.add("v" + v); else if (u === "l") out.add("v" + v * 1000);
    else if (u === "g") out.add("w" + v); else out.add("w" + v * 1000);
  }
  return out;
}

async function gemini(prompt, retry = 0) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: "application/json" } }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!t) throw new Error(j?.error?.message ?? "빈 응답");
    return JSON.parse(t);
  } catch (e) {
    if (retry < 2) { await new Promise((s) => setTimeout(s, 2000 * (retry + 1))); return gemini(prompt, retry + 1); }
    console.error(`[kn-ai] Gemini 실패: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const cat = loadCatalog();
const all = Object.values(cat).flat();
const miss = JSON.parse(fs.readFileSync("scripts/output/no-barcode.json", "utf8"));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};

const targets = miss.filter((p) => caps(p.name + " " + (p.cap ?? "") + " " + (p.wt ?? "")).size && !cache[p.id]);
console.log(`[kn-ai] 미해결 ${miss.length} / 용량 있는 것 ${targets.length}\n`);

let n = 0;
async function work(p) {
  const myCaps = caps(p.name + " " + (p.cap ?? "") + " " + (p.wt ?? ""));
  const brand = (p.brand || p.name.split(/\s+/)[0]).trim();
  const pool = (cat[brand]?.length ? cat[brand] : all).filter((r) => validGtin(r.bar) && [...caps(r.nm)].some((c) => myCaps.has(c)));
  const seen = new Set();
  const cands = pool.filter((r) => (seen.has(r.bar) ? false : seen.add(r.bar))).slice(0, 30);
  if (!cands.length) { cache[p.id] = { name: p.name, why: "용량 같은 후보 없음" }; return; }

  const out = await gemini(
    `한국 유통 상품의 바코드(GTIN)를 고른다.\n` +
    `찾는 상품: "${p.name}"\n\n` +
    `아래 후보는 모두 용량이 같다. 이 중 "완전히 같은 제품"이 있으면 그 번호를 답하라.\n` +
    `- 향/맛/기능(제로, 실내건조, 라벤더 등)이 하나라도 다르면 같은 제품이 아니다.\n` +
    `- 표기만 다른 것(핑크로즈 = 핑크 로즈, 피죤 = 피존)은 같은 제품이다.\n` +
    `- 확신이 없으면 반드시 빈 문자열로 답하라. 틀린 답은 빈 답보다 나쁘다.\n\n` +
    cands.map((c, i) => `${i + 1}. ${c.bar} | ${c.nm}`).join("\n") +
    `\n\n{"바코드":"","후보명":"","확신":"높음|낮음","이유":""}`
  );
  const bar = String(out?.바코드 ?? "").trim();
  const pick = cands.find((c) => c.bar === bar);
  // 묶음 바코드라면 묶음 개수가 우리 상품과 같아야 한다 (4개들이 번호를 24개 상품에 쓰면 안 된다)
  const bm = pick && pick.nm.match(/[xX×]\s*(\d+)\s*(개|입|봉|캔|병|팩|PACK|pack|EA)?/);
  const myN = Number((p.name.match(/(\d+)\s*(개|캔|병|펫|입|봉|매|포|팩|갑|알)\s*$/) || [])[1] ?? 0);
  const bundleAll = pick ? [...pick.nm.matchAll(/[xX×]\s*(\d+)/g)].reduce((a, m) => a * Number(m[1]), 1) : 1;
  const bundleBad = !!(bm && myN && bundleAll !== myN);
  // 사람이 확인해 걸러낸 오답
  const REJECT = new Set(["매일 찰잡곡밥 210g 24개","다우니 섬유유연제 퍼퓸 블랙 미스티크 향 1L 4개",
    "액체세제 테크 호르몬 제거 액체세제 일반 리필 2L 4개","퍼실 라벤더 듀얼 드럼 일반 겸용 세탁세제 2.7L 4개",
    "퍼실 라벤더 듀얼 드럼 일반 겸용 2.7L 2개","자유시간 쿠키엔크림 미니 408g 2개",
    "피죤 섬유유연제 리필 2300ml 6개"]);
  if (bundleBad || REJECT.has(p.name)) {
    cache[p.id] = { name: p.name, why: bundleBad ? `묶음 개수 불일치 (${pick.nm})` : "사람 검토에서 제외" };
    return;
  }
  if (bar && pick && out?.확신 === "높음") {
    cache[p.id] = { name: p.name, bar, src: pick.nm, why: out?.이유 ?? "" };
    console.log(`  ✓ ${p.name}\n        ${bar}  ←  ${pick.nm}`);
  } else {
    cache[p.id] = { name: p.name, why: bar ? `확신 낮음 (${out?.후보명 ?? ""})` : "AI 미선택" };
  }
  if (++n % 20 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1)); console.log(`  ... ${n}/${targets.length}`); }
}
let qi = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (qi < targets.length) await work(targets[qi++]); }));
fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
const ok = Object.values(cache).filter((c) => c.bar);
console.log(`\n[kn-ai] 판정 ${Object.keys(cache).length} / 확보 ${ok.length}`);

if (!APPLY) { console.log("(저장하려면 --apply)"); process.exit(0); }
let saved = 0;
for (const [id, c] of Object.entries(cache)) {
  if (!c.bar) continue;
  const { data } = await sb.from("products").select("item_info").eq("id", id).limit(1);
  const info = { ...(data?.[0]?.item_info ?? {}) };
  if (String(info.바코드 ?? "").trim()) continue;
  info.바코드 = c.bar;
  info.바코드출처 = `코리안넷 GS1 표준DB — ${c.src}`;
  const { error } = await sb.from("products").update({ item_info: info }).eq("id", id);
  if (error) console.error(`[kn-ai] 저장 실패 ${c.name}: ${error.message}`); else saved++;
}
console.log(`[kn-ai] 저장 ${saved}건`);
