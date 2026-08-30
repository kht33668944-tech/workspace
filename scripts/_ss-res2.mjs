import XLSX from "xlsx-js-style";
const wb = XLSX.readFile(process.argv[2]);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
const m = new Map();
for (const r of rows) { const v = String(r["결과"] ?? "").trim(); m.set(v, (m.get(v)??0)+1); }
console.log(`총 ${rows.length}행`);
for (const [k,v] of [...m].sort((a,b)=>b[1]-a[1])) console.log(`  [${v}] ${k.slice(0,200)}`);
console.log("\n--- 실패 예시 ---");
rows.filter(r=>String(r["결과"]).trim()!=="성공").slice(0,8).forEach(r=>console.log(`${r["온라인 상품명"]}\n   분류${r["상품분류코드"]} 카테고리${r["카테고리코드"]} → ${r["결과"]}`));
