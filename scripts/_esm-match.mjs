// 발주서 ESM 취소대상 ↔ ESM 발송처리 목록 대조.
// 목록에는 취소하면 안 되는 주문도 섞여 있다. 마켓·수령인명·구매자명·상품명·수량이
// 모두 일치할 때만 대상으로 삼고, 같은 조합이 여러 건이면 개수만큼만 소비한다.
import fs from "fs";
const OUT = "./.cancel-shots";
const targets = JSON.parse(fs.readFileSync("scripts/_esm-targets.json", "utf8"));
const rows = JSON.parse(fs.readFileSync(`${OUT}/esm-rows.json`, "utf8"));

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
const key = (마켓, 수령, 구매, 상품, 수량) => [마켓, norm(수령), norm(구매), norm(상품), String(수량).trim()].join("|");

// 발주서 대상을 키별 개수로
const need = new Map();
for (const t of targets) {
  const k = key(t.마켓, t.수령인명, t.구매자명, t.상품명, t.수량);
  need.set(k, (need.get(k) || []).concat(t));
}

const matched = [], skipped = [];
for (const r of rows) {
  const k = key(r.마켓, r.수령인명, r.구매자명, r.상품명, r.수량);
  const pool = need.get(k);
  // 발송처리필요·발송지연 모두 취소 대상이다 (발주서에서 이미 취소준비로 지정한 건)
  if (pool && pool.length) {
    matched.push({ ...r, id: pool.shift().id });
  } else {
    skipped.push({ ...r, 사유: "발주서 취소대상 아님" });
  }
}
const 미발견 = [...need.values()].flat();

fs.writeFileSync("scripts/_esm-matched.json", JSON.stringify(matched, null, 1), "utf8");
console.log(`[ESM대조] 대상 ${targets.length} / 목록 ${rows.length}`);
console.log(`[ESM대조] 매칭 ${matched.length} | 취소 안 할 행 ${skipped.length} | 목록에 없는 대상 ${미발견.length}`);
console.log("\n--- 취소할 행 (마켓 | 수령/구매 | 상품 | 수량 | 주문번호) ---");
for (const m of matched) console.log(`  ${m.마켓} | ${m.수령인명}/${m.구매자명} | ${m.상품명} | ${m.수량}개 | ${m.주문번호}`);
console.log("\n--- 목록에 있으나 취소 안 함 ---");
for (const s of skipped) console.log(`  ${s.마켓} | ${s.수령인명}/${s.구매자명} | ${s.상품명} | ${s.수량}개 | ${s.주문번호} | ${s.사유}`);
console.log("\n--- 발주서 대상인데 목록에 없음 ---");
for (const m of 미발견) console.log(`  ${m.마켓} | ${m.수령인명}/${m.구매자명} | ${m.상품명} | ${m.수량}개 | 묶음 ${m.bundle_no}`);
