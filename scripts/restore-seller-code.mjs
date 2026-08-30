// 이미 등록에 성공한 상품의 판매자관리코드를 결과 엑셀 기준으로 되돌린다.
//
//   node scripts/restore-seller-code.mjs <플랫폼키> <결과.xlsx> [--apply]
//   예) node scripts/restore-seller-code.mjs smartstore 결과.xlsx --apply
//
// 왜 필요한가:
//   --retry 없이 엑셀을 다시 만들면 모든 상품에 새 판매자관리코드가 발급되고 DB에 덮어써진다.
//   그런데 마켓에는 옛 코드로 이미 올라가 있으므로, 그대로 두면 DB와 마켓이 어긋난다.
//   결과 엑셀에는 실제로 올라간 코드가 남아 있으니 그것으로 되돌린다.
//
// 주의: 상품명으로 짝을 짓는다. 이름이 완전히 같은 상품이 둘 이상이면 어느 쪽인지 알 수 없어 건너뛴다.
import { serviceClient, fetchAll, readSheet } from "./_lib.mjs";

const KEY = process.argv[2];
const FILE = process.argv[3];
const APPLY = process.argv.includes("--apply");
if (!KEY || !FILE) { console.log("사용법: node scripts/restore-seller-code.mjs <smartstore|coupang|esm> <결과.xlsx> [--apply]"); process.exit(1); }

const rows = readSheet(FILE);

// 세 가지 파일을 받는다.
//   · 쇼핑몰 작업결과("작업결과") · 플레이오토 업로드 결과("결과") → 성공한 행만
//   · 업로드용 엑셀(결과 컬럼 없음) → 전부 (앞으로 이 코드로 올릴 것이므로 DB를 미리 맞춘다)
const head = rows[0] ?? {};
const resultCol = "작업결과" in head ? "작업결과" : "결과" in head ? "결과" : null;
const done = rows
  .map((r) => ({
    ok: !resultCol || String(r[resultCol]).trim() === "성공",
    name: String(r["온라인 상품명"] ?? "").trim(),
    code: String(r["판매자관리코드"] ?? "").trim(),
  }))
  .filter((r) => r.ok && r.name && r.code);
console.log(`${resultCol ? `결과 ${rows.length}행 / 성공` : `업로드용 ${rows.length}행 / 대상`} ${done.length}건\n`);

// 상품을 한 번에 받아 이름으로 색인한다 (건마다 조회하면 수백 번 왕복한다)
const sb = serviceClient();
const byName = new Map();
for (const p of await fetchAll(sb, "products", "id, product_name, seller_code")) {
  const k = String(p.product_name ?? "").trim();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(p);
}

let same = 0, fixed = 0, missing = 0, ambiguous = 0;
for (const d of done) {
  const found = byName.get(d.name) ?? [];
  if (!found.length) { missing++; console.log(`  ✗ ${d.name} — 상품 없음`); continue; }
  if (found.length > 1) { ambiguous++; console.log(`  ? ${d.name} — 같은 이름이 ${found.length}건이라 어느 쪽인지 알 수 없다`); continue; }
  const p = found[0];
  const cur = String(p.seller_code?.[KEY] ?? "");
  if (cur === d.code) { same++; continue; }
  console.log(`  ✓ ${d.name}\n        ${cur || "(없음)"} → ${d.code}`);
  if (APPLY) {
    const sc = { ...(p.seller_code ?? {}), [KEY]: d.code };
    const { error } = await sb.from("products").update({ seller_code: sc }).eq("id", p.id);
    if (error) { console.error(`[코드복구] 저장 실패 ${d.name}: ${error.message}`); continue; }
    p.seller_code = sc;
  }
  fixed++;
}
console.log(`\n이미 맞음 ${same} / ${APPLY ? "되돌림" : "되돌릴 것"} ${fixed} / 이름 중복 ${ambiguous} / 상품 없음 ${missing}`);
if (ambiguous) console.log("이름 중복은 손대지 않았다. 상품명을 구분한 뒤 다시 돌려라.");
if (!APPLY) console.log("(저장하려면 --apply)");
