// 식약처 C005(바코드연계)에서 "후보 바코드가 딱 하나인 상품"만 골라 채운다.
//
//   node scripts/mfds-barcode-match.mjs          미리보기
//   node scripts/mfds-barcode-match.mjs --apply  저장
//
// C005에는 용량 정보가 없다. 그래서 "밀키스"처럼 여러 용량이 한 이름으로 묶이면 쓸 수 없다.
// 하지만 그 이름으로 등록된 바코드가 단 하나뿐이라면 용량이 하나라는 뜻이므로 안전하다.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const sb = createClient("https://ygunjfbtyowsumtxkukr.supabase.co", get("SUPABASE_SERVICE_ROLE_KEY"));
const APPLY = process.argv.includes("--apply");

const chk = (d) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 ? 3 : 1); return String((10 - (s % 10)) % 10); };
const validGtin = (b) => /^\d{13}$/.test(b) && chk(b.slice(0, 12)) === b[12];

const STOP = /^(개|캔|병|펫|입|봉|매|포|팩|갑|박스|롤|세트|기획|증정|리필|용기|겸용|대용량|묶음|무라벨|페트|무료배송)$/;
const words = (s) => String(s)
  .replace(/(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|L|l|g|G|kg|KG)(?![a-zA-Z가-힣])/g, " ")
  .replace(/\d+\s*(개입|개|캔|병|펫|입|봉|매|포|팩|갑|롤|박스|종|P|p)/g, " ")
  .replace(/[^가-힣A-Za-z0-9]/g, " ")
  .split(/\s+/).filter((t) => t && !STOP.test(t) && !/^\d+$/.test(t));

const arr = JSON.parse(fs.readFileSync("scripts/output/mfds-C005.json", "utf8"));
// 이름을 붙여 쓴 형태로 색인해 둔다
const flat = arr.map((r) => ({ bar: String(r.bar ?? "").trim(), nm: String(r.nm ?? ""), key: String(r.nm ?? "").replace(/\s+/g, ""), bssh: String(r.bssh ?? "") }))
  .filter((r) => validGtin(r.bar));
console.log(`[mfds-bar] 유효 바코드 ${flat.length}건`);

const miss = JSON.parse(fs.readFileSync("scripts/output/no-barcode.json", "utf8"));
const found = [], fails = [];
for (const p of miss) {
  const my = words(p.name);
  if (my.length < 2) { fails.push([p.name, "구분 낱말 부족"]); continue; }
  // 식약처 제품명에는 판매용 수식어가 빠져 있다. 브랜드(첫 낱말)는 반드시,
  // 나머지는 8할 이상 겹칠 때만 후보로 본다.
  const brand = my[0];
  const need = Math.max(2, Math.ceil(my.length * 0.8));
  const hits = flat.filter((r) => r.key.includes(brand) && my.filter((t) => r.key.includes(t)).length >= need);
  if (!hits.length) { fails.push([p.name, "후보 없음"]); continue; }
  const bars = [...new Set(hits.map((r) => r.bar))];
  if (bars.length > 1) { fails.push([p.name, `후보 ${bars.length}개 (용량 구분 불가)`]); continue; }
  found.push({ ...p, bar: bars[0], src: hits[0].nm + " / " + hits[0].bssh });
}
console.log(`대상 ${miss.length} → 찾음 ${found.length} / 못찾음 ${fails.length}`);
for (const f of found) console.log(`  ✓ ${f.name}\n        ${f.bar}  ←  ${f.src}`);
const why = {}; fails.forEach(([, w]) => (why[w] = (why[w] ?? 0) + 1));
console.log("\n== 못 찾은 이유 ==");
Object.entries(why).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n}\t${w}`));
fs.writeFileSync("scripts/output/mfds-bar-found.json", JSON.stringify(found, null, 1));

if (!APPLY) { console.log("\n(저장하려면 --apply)"); process.exit(0); }
let saved = 0;
for (const f of found) {
  const { data } = await sb.from("products").select("item_info").eq("id", f.id).limit(1);
  const info = { ...(data?.[0]?.item_info ?? {}) };
  info.바코드 = f.bar;
  info.바코드출처 = `식약처 바코드연계(C005) — ${f.src}`;
  const { error } = await sb.from("products").update({ item_info: info }).eq("id", f.id);
  if (error) console.error(`[mfds-bar] 저장 실패 ${f.name}: ${error.message}`); else saved++;
}
console.log(`[mfds-bar] 저장 ${saved}건`);
