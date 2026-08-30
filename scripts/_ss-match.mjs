// 발주서 스마트스토어 취소대상 ↔ 발주/발송관리 목록 대조.
// 목록에는 취소하면 안 되는 주문이 섞여 있다. 수취인명·구매자명·상품명·수량이
// 모두 일치할 때만 대상으로 삼고, 같은 조합이 여러 건이면 개수만큼만 소비한다.
import fs from "fs";
const OUT = "./.cancel-shots";
const targets = JSON.parse(fs.readFileSync("scripts/_ss-targets.json", "utf8"));
const rows = JSON.parse(fs.readFileSync(`${OUT}/ss-rows.json`, "utf8"));

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const key = (수취, 구매, 상품, 수량) => [norm(수취), norm(구매), norm(상품), String(수량).trim()].join("|");

const need = new Map();
for (const t of targets) {
  const k = key(t.수취인명, t.구매자명, t.상품명, t.수량);
  need.set(k, (need.get(k) || []).concat(t));
}

const matched = [], skipped = [];
for (const r of rows) {
  const k = key(r.수취인명, r.구매자명, r.상품명, r.수량);
  const pool = need.get(k);
  if (pool && pool.length) matched.push({ ...r, id: pool.shift().id });
  else skipped.push(r);
}
const 미발견 = [...need.values()].flat();

fs.writeFileSync("scripts/_ss-matched.json", JSON.stringify(matched, null, 1), "utf8");
console.log(`[스토어대조] 대상 ${targets.length} / 목록 ${rows.length}`);
console.log(`[스토어대조] 매칭 ${matched.length} | 취소 안 할 행 ${skipped.length} | 목록에 없는 대상 ${미발견.length}`);
console.log("\n--- 취소할 행 ---");
for (const m of matched) console.log(`  ${m.수취인명}/${m.구매자명} | ${m.상품명} | ${m.수량}개 | ${m.주문상태} | 상품주문번호 ${m.상품주문번호}`);
console.log("\n--- 발주서 대상인데 목록에 없음 ---");
for (const m of 미발견) console.log(`  ${m.수취인명}/${m.구매자명} | ${m.상품명} | ${m.수량}개 | 묶음 ${m.bundle_no}`);
