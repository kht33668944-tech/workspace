import { makeCoupangOptionLookup, buildOptionFor } from "./coupang-option-map.mjs";
import { makePicker } from "./category-rules.mjs";
const pick = makePicker();
const L = makeCoupangOptionLookup();
function parseSpec(productName) {
  const text = productName.replace(/(\d)\s*ML\b/g, "$1ml").replace(/(\d)\s*mL\b/g, "$1ml").replace(/(\d)\s*G\b/g, "$1g").replace(/(\d)\s*KG\b/g, "$1kg");
  const counts = [...text.matchAll(/(\d+)\s*(개입|개|봉지|봉|캔|병|팩|입|박스|롤|매|장|포|갑|곽|세트|펫|페트|P|p|피스)/g)];
  const c = counts.at(-1);
  let quantity = c ? Number(c[1]) : 1;
  let unit = c?.[2] ?? "개";
  if (["봉","캔","병","팩","포","갑","곽","봉지","입","펫","페트"].includes(unit)) unit = "개";
  const units = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|ml|L)\b/g)];
  const u = units.at(-1);
  const len = text.match(/(\d+(?:\.\d+)?)\s*[mM](?![lL가-힣])/);
  return { quantity, quantityUnit: unit, unitValue: u?.[1] ?? "", unitType: u?.[2] ?? "", counts: counts.map((m) => ({ n: Number(m[1]), unit: m[2] })), length: len ? `${len[1]}m` : "" };
}
for (const n of ["쏘피 유기농 100 순면커버 소형 20P 5개", "템포 탐폰 오리지널 슈퍼 20P 5개"]) {
  const s = { ...parseSpec(n), name: n };
  console.log(n, JSON.stringify(s.counts), "len=", s.length);
  console.log("  ", JSON.stringify(buildOptionFor(L.lookup(pick(n).full), s, {})));
}
