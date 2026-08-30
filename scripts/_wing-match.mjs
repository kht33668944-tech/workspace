// 발주서 취소대상 40건 ↔ 쿠팡윙 목록 대조
import fs from "fs";
const OUT = "./.cancel-shots";
fs.mkdirSync(OUT, { recursive: true });
const targets = JSON.parse(fs.readFileSync("scripts/_cancel-targets.json", "utf8"));
const rowsRaw = JSON.parse(fs.readFileSync(`${OUT}/wing-rows.json`, "utf8"));

const seen = new Set();
const rows = rowsRaw.filter((r) => !seen.has(r.orderNo) && seen.add(r.orderNo));
console.log("[대조] 윙 행:", rowsRaw.length, "→ 중복 제거:", rows.length);

const norm = (s) => (s || "").replace(/\s+/g, "").toLowerCase();
// 윙 등록상품명에서 "등록상품명: XXX,수량" 앞부분 추출
const wingProduct = (p) => {
  const m = p.match(/등록상품명:\s*(.+?)(?:,\s*\d|노출상품명)/);
  return m ? m[1].trim() : p;
};
// 끝의 "N개" = 주문 수량
const wingQty = (p) => {
  const m = p.match(/(\d+)개\s*$/);
  return m ? Number(m[1]) : null;
};

const matched = [], ambiguous = [], missing = [];
for (const t of targets) {
  const byName = rows.filter((r) => norm(r.recipientFull).startsWith(norm(t.recipient_name)) || norm(t.recipient_name).startsWith(norm(r.recipient)));
  const byBoth = byName.filter((r) => norm(wingProduct(r.product)) === norm(t.product_name));
  const pick = byBoth.length ? byBoth : byName.filter((r) => norm(r.product).includes(norm(t.product_name)));
  if (pick.length === 1) {
    matched.push({ ...t, orderNo: pick[0].orderNo, wingQty: wingQty(pick[0].product), wingStatus: pick[0].status, wingProduct: wingProduct(pick[0].product) });
  } else if (pick.length > 1) {
    ambiguous.push({ ...t, candidates: pick.map((r) => ({ orderNo: r.orderNo, product: wingProduct(r.product), qty: wingQty(r.product), at: r.orderedAt })) });
  } else {
    missing.push(t);
  }
}
fs.writeFileSync("scripts/_cancel-matched.json", JSON.stringify(matched, null, 1), "utf8");
console.log(`[대조] 매칭 ${matched.length} / 중복후보 ${ambiguous.length} / 미발견 ${missing.length}`);
console.log("\n--- 매칭됨 ---");
for (const m of matched) console.log(`  ${m.orderNo} | ${m.recipient_name} | ${m.wingProduct} | 발주서 ${m.quantity}개 / 윙 ${m.wingQty}개 | ${m.wingStatus}`);
console.log("\n--- 후보 여러 개 ---");
for (const a of ambiguous) console.log(`  ${a.recipient_name} | ${a.product_name} | ${a.quantity}개 →`, JSON.stringify(a.candidates));
console.log("\n--- 윙 목록에 없음 ---");
for (const m of missing) console.log(`  ${m.recipient_name} | ${m.product_name} | ${m.quantity}개 | 묶음 ${m.bundle_no}`);
