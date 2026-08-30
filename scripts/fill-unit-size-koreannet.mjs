// 이름에 용량이 없는 상품의 "개당 용량"을 코리안넷 카탈로그에서 채운다.
//
//   node scripts/fill-unit-size-koreannet.mjs          미리보기
//   node scripts/fill-unit-size-koreannet.mjs --apply  저장
//
// 왜 필요한가:
//   스마트스토어 단위가격은 개당 용량이 있어야 켤 수 있는데,
//   라면·커피처럼 이름에 g을 안 적는 상품이 100건 넘게 있다.
//   코리안넷 상품명에는 "오뚜기 진라면 약간매운맛 600g (120g x 5입)"처럼 낱개 용량이 들어 있다.
//
// 틀리면 안 되므로:
//   · 우리 상품명의 낱말이 후보에 전부 들어 있어야 한다
//   · 후보가 여럿이면 낱개 용량이 전부 같을 때만 채택한다 (포장만 다르고 낱개는 같으므로)
import { serviceClient, fetchTargetProducts } from "./_lib.mjs";
import fs from "fs";

const APPLY = process.argv.includes("--apply");

const RE_SIZE = /(\d+(?:\.\d+)?)\s*(ml|l|g|kg)(?=\s|$|\d|\))/i;
const norm = (s) => String(s).replace(/[^가-힣a-zA-Z0-9]/g, "").toLowerCase();

/** ml·L은 ml로, g·kg은 g으로 맞춘다 */
function toUnit(n, u) {
  const value = Math.round(u === "l" || u === "kg" ? n * 1000 : n);
  const unit = u === "ml" || u === "l" ? "ml" : "g";
  return value > 0 && value <= 5000 ? { value, unit } : null;
}

/**
 * 코리안넷 이름에서 낱개 용량을 뽑는다.
 *
 * 괄호 안 "(120g x 5입)" 꼴만 믿는다. 괄호 없는 단일 표기는 낱개인지 묶음 총량인지 구분이 안 된다.
 * 실제로 "삼양 큰컵 불닭볶음탕면 1920g"은 16개들이 박스 총량이고,
 * "피지 모락셀라 부스터 468g 26개입"도 총량이다. 둘 다 낱개로 읽으면 크게 틀린다.
 */
function perUnit(nm) {
  const paren = nm.match(/\(([^)]*)\)/);
  if (!paren) return null;
  const m = paren[1].match(/(\d+(?:\.\d+)?)\s*(ml|l|g|kg)\s*[x×X*]\s*\d+/i);
  return m ? toUnit(parseFloat(m[1]), m[2].toLowerCase()) : null;
}

// 카탈로그는 낱개 용량을 뽑을 수 있는 것만 남기고, 정규화한 이름을 미리 붙여 둔다.
// (상품마다 3만 건을 다시 정규화하면 수백만 번 헛일을 한다)
const CATALOG = Object.values(JSON.parse(fs.readFileSync("scripts/output/koreannet-catalog.json", "utf8")))
  .flatMap((v) => (Array.isArray(v) ? v : v.rows ?? []))
  .map((c) => ({ nm: c.nm, key: norm(c.nm), u: perUnit(c.nm) }))
  .filter((c) => c.u);

// 묶음 수량·포장 표현은 매칭에서 뺀다 (우리는 "40개", 코리안넷은 "5입")
const DROP = /^(\d+개|\d+입|\d+봉|\d+캔|\d+병|\d+팩|\d+박스|\d+알|\d+매|\d+p|\d+포|멀티팩|박스|봉지|번들)$/i;

const sb = serviceClient();
const products = await fetchTargetProducts(sb, "id, product_name, item_info");

/** 이 상품이 이미 용량을 아는가 (이름 또는 조사값) */
const known = (p) => RE_SIZE.test(p.product_name)
  || ["개당용량", "개당중량"].some((k) => RE_SIZE.test(String(p.item_info?.[k] ?? "")));

const targets = products.filter((p) => !known(p));
console.log(`용량 모르는 상품 ${targets.length}건 / 낱개 용량을 아는 카탈로그 ${CATALOG.length}건\n`);

const found = [], ambiguous = [], missing = [];
for (const p of targets) {
  const tokens = p.product_name.split(/\s+/).filter((t) => t && !DROP.test(t)).map(norm).filter(Boolean);
  if (tokens.length < 2) { missing.push([p.product_name, "낱말 부족"]); continue; }

  const hits = CATALOG.filter((c) => tokens.every((t) => c.key.includes(t)));
  if (!hits.length) { missing.push([p.product_name, "후보 없음"]); continue; }

  const keys = [...new Set(hits.map((h) => `${h.u.value}${h.u.unit}`))];
  if (keys.length !== 1) { ambiguous.push([p.product_name, keys.join(" / "), hits.slice(0, 3).map((h) => h.nm)]); continue; }
  found.push({ p, u: hits[0].u, sample: hits[0].nm, n: hits.length });
}

console.log(`■ 채울 수 있음 ${found.length}건`);
for (const f of found) console.log(`  ✓ ${f.p.product_name}\n        ${f.u.value}${f.u.unit}  ← ${f.sample} (후보 ${f.n})`);
console.log(`\n■ 후보끼리 값이 달라 보류 ${ambiguous.length}건`);
for (const [n, k, s] of ambiguous.slice(0, 20)) console.log(`  ? ${n}\n        ${k}\n        ${s.join("\n        ")}`);
console.log(`\n■ 못 찾음 ${missing.length}건 (매·롤·P 단위라 단위가격 대상이 아닌 것 포함)`);
for (const [n, why] of missing.slice(0, 15)) console.log(`  ✗ ${n} — ${why}`);

if (!APPLY) { console.log("\n(저장하려면 --apply)"); process.exit(0); }

let saved = 0;
for (const f of found) {
  const info = { ...(f.p.item_info ?? {}) };
  info[f.u.unit === "ml" ? "개당용량" : "개당중량"] = `${f.u.value}${f.u.unit}`;
  info.용량출처 = `코리안넷: ${f.sample}`;
  const { error } = await sb.from("products").update({ item_info: info }).eq("id", f.p.id);
  if (error) console.error(`[용량] 저장 실패 ${f.p.product_name}: ${error.message}`);
  else saved++;
}
console.log(`\n[용량] ${saved}건 저장`);
