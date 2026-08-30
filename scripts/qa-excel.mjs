// 생성된 플레이오토 엑셀을 실제 파일 기준으로 검수한다.
//   node scripts/qa-excel.mjs
import fs from "fs";
import path from "path";
import os from "os";
import XLSX from "xlsx-js-style";

const dir = path.join(os.homedir(), "Desktop", "상품등록");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".xlsx"));
const PHONE = "010-6564-4459";

const byLabel = new Map();
for (const f of files) {
  const label = f.replace(/^플레이오토_/, "").replace(/_\d{6}.*$/, "");
  const wb = XLSX.readFile(path.join(dir, f));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  if (!byLabel.has(label)) byLabel.set(label, { rows: [], files: 0 });
  const e = byLabel.get(label);
  e.rows.push(...rows); e.files++;
}

let bad = 0;
for (const [label, { rows, files: n }] of byLabel) {
  console.log(`\n══ ${label}  ${rows.length}행 / 파일 ${n}개`);
  const cols = Object.keys(rows[0] ?? {});
  const has = (c) => cols.includes(c);

  const chk = (name, list, sample = 3) => {
    console.log(`  ${list.length ? "❌" : "✅"} ${name}: ${list.length}건`);
    list.slice(0, sample).forEach((s) => console.log(`       · ${s}`));
    bad += list.length;
  };

  // 판매자관리코드는 "쇼핑몰 하나 안에서" 유일해야 한다.
  // 지마켓옥션 파일은 한 상품이 옥션 행·지마켓 행으로 나뉘므로 코드가 두 번 나오는 게 정상이다.
  const shopCol = cols.find((c) => /쇼핑몰/.test(c));
  const dup = [];
  const groups = new Map();
  for (const r of rows) {
    const shop = shopCol ? String(r[shopCol] ?? "") : "";
    if (!groups.has(shop)) groups.set(shop, new Set());
    const set = groups.get(shop);
    const code = String(r["판매자관리코드"] ?? "").trim();
    if (code && set.has(code)) dup.push(`${shop} ${code}`);
    set.add(code);
  }
  chk("판매자관리코드 중복(같은 쇼핑몰 안)", dup);
  chk("판매자관리코드 없음", rows.filter((r) => !String(r["판매자관리코드"] ?? "").trim()).map((r) => r["온라인 상품명"]));

  chk("상품명 없음", rows.filter((r) => !String(r["온라인 상품명"] ?? "").trim()).map((_, i) => `${i + 1}행`));
  chk("상품명 특수문자", rows.filter((r) => /[^가-힣a-zA-Z0-9\s%.]/.test(String(r["온라인 상품명"] ?? "")))
    .map((r) => r["온라인 상품명"]));

  if (has("기본이미지")) chk("기본이미지 없음", rows.filter((r) => !String(r["기본이미지"] ?? "").trim()).map((r) => r["온라인 상품명"]));
  if (has("기본이미지")) chk("기본이미지가 외부주소", rows.filter((r) => /gmarket|auction|ohou|coupang|amazonaws/.test(String(r["기본이미지"] ?? ""))).map((r) => r["온라인 상품명"]));

  if (has("카테고리코드")) chk("카테고리코드 없음", rows.filter((r) => !String(r["카테고리코드"] ?? "").trim()).map((r) => r["온라인 상품명"]));

  const priceCol = cols.find((c) => /판매가/.test(c));
  if (priceCol) chk(`${priceCol} 0원 이하`, rows.filter((r) => !(Number(r[priceCol]) > 0)).map((r) => `${r["온라인 상품명"]} = ${r[priceCol]}`));

  // 고시 항목에 우리 전화번호가 들어갔는지
  const noticeCols = cols.filter((c) => /상품정보제공고시/.test(c));
  if (noticeCols.length) {
    const noPhone = rows.filter((r) => !noticeCols.some((c) => String(r[c] ?? "").includes(PHONE)));
    chk("고시에 소비자상담번호 없음", noPhone.map((r) => r["온라인 상품명"]));
    const emptyNotice = rows.filter((r) => noticeCols.every((c) => !String(r[c] ?? "").trim()));
    chk("고시 전체 비어있음", emptyNotice.map((r) => r["온라인 상품명"]));
  }
  // 상세설명에 판매처 이미지가 남았는지
  const descCol = cols.find((c) => /상세설명|상품상세/.test(c));
  if (descCol) chk("상세설명에 외부 이미지", rows.filter((r) => /gmarket|auction|ohou\.se|coupang|amazonaws/.test(String(r[descCol] ?? ""))).map((r) => r["온라인 상품명"]));

  if (label === "쿠팡" && has("옵션조합")) {
    const noOpt = rows.filter((r) => String(r["옵션조합"] ?? "") === "옵션없음");
    console.log(`  ⚠ 옵션 미산출: ${noOpt.length}건 (쿠팡 필수옵션 규칙 없는 카테고리 — 수동 등록 대상)`);
  }
}
console.log(`\n${bad === 0 ? "✅ 엑셀 검수 통과 — 등록을 막는 문제 없음" : `❌ 문제 ${bad}건`}`);
