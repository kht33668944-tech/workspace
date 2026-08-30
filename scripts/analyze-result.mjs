// 업로드 결과 엑셀을 읽어 반려 사유별로 묶어 보여준다.
//   node scripts/analyze-result.mjs <파일...>
// 파일 종류를 컬럼으로 알아서 가린다:
//   · 플레이오토 등록결과 : "결과" + 상품 데이터 전체
//   · 쿠팡 작업결과       : "작업결과" + "결과메세지"
//   · 우리가 만든 업로드본 : "판매자관리코드" + 상품 데이터
import XLSX from "xlsx-js-style";
const rd = (f) => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }); };
const src = [], job = [], pa = [];
for (const f of process.argv.slice(2)) {
  const rows = rd(f); if (!rows.length) continue;
  const k = Object.keys(rows[0]);
  if (k.includes("작업결과")) job.push(...rows);
  else if (k.includes("결과") && k.includes("온라인 상품명")) { pa.push(...rows); src.push(...rows); }
  else if (k.includes("판매자관리코드")) src.push(...rows);
}
const by = new Map(src.map((r) => [String(r["판매자관리코드"]).trim(), r]));
console.log(`플레이오토 ${pa.length} / 쿠팡 작업결과 ${job.length} / 원본 ${src.length}`);

if (pa.length) {
  const bad = pa.filter((r) => String(r["결과"]).trim() !== "성공");
  console.log(`\n== 플레이오토 등록: 성공 ${pa.length - bad.length} / 실패 ${bad.length} ==`);
  const g = new Map();
  for (const r of bad) { const k = String(r["결과"]).trim(); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  for (const [k, v] of [...g].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n[${v.length}건] ${k}`);
    for (const r of v) console.log(`   · ${r["온라인 상품명"]}  |  옵션=${r["옵션"]}`);
  }
}
if (job.length) {
  const bad = job.filter((r) => String(r["작업결과"]).trim() !== "성공");
  console.log(`\n== 쿠팡 등록: 성공 ${job.length - bad.length} / 실패 ${bad.length} ==`);
  const norm = (s) => String(s).replace(/\[[^\]]*\]/g, "[]").replace(/'[^']*'/g, "''").replace(/\d+/g, "N").slice(0, 150);
  const g = new Map();
  for (const r of bad) { const k = norm(r["결과메세지"]); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  for (const [k, v] of [...g].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n[${v.length}건] ${k}`);
    for (const r of v.slice(0, 6)) {
      const s = by.get(String(r["판매자관리코드"]).trim());
      console.log(`   · ${s?.["온라인 상품명"] ?? r["판매자관리코드"]}  |  바코드=${s?.["옵션바코드"] || "-"}`);
    }
    if (v.length > 6) console.log(`   ... 외 ${v.length - 6}건`);
  }
}
