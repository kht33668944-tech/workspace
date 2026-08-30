// 특정 상품이 지금까지 어떤 코드로 어떤 결과를 받았는지 이력을 보여준다.
import XLSX from "xlsx-js-style";
import fs from "fs";
import os from "os";
import path from "path";
const rd = (f) => { const wb = XLSX.readFile(f); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }); };
const dl = path.join(os.homedir(), "Downloads"), desk = path.join(os.homedir(), "Desktop", "상품등록");
const files = [];
for (const d of [dl, desk]) for (const f of fs.readdirSync(d))
  if (f.endsWith(".xlsx") && /엑셀일괄등록_결과|상품등록_작업결과|플레이오토_쿠팡/.test(f)) files.push([d, f]);
files.sort((a, b) => a[1].localeCompare(b[1]));
const nameByCode = new Map(), hist = new Map();
for (const [d, f] of files) {
  let rows; try { rows = rd(path.join(d, f)); } catch { continue; }
  for (const r of rows) {
    const code = String(r["판매자관리코드"] ?? "").trim(); if (!code) continue;
    if (r["온라인 상품명"]) nameByCode.set(code, String(r["온라인 상품명"]).trim());
    const res = "작업결과" in r ? `쿠팡 ${r["작업결과"]}: ${String(r["결과메세지"] ?? "").replace(/\s+/g, " ").slice(0, 90)}`
      : "결과" in r ? `플토 ${String(r["결과"]).replace(/\s+/g, " ").slice(0, 60)}` : null;
    if (!res) continue;
    if (!hist.has(code)) hist.set(code, []);
    hist.get(code).push([f.slice(0, 22), res]);
  }
}
const q = process.argv.slice(2);
for (const [code, h] of hist) {
  const nm = nameByCode.get(code) ?? "";
  if (q.length && !q.some((x) => nm.includes(x))) continue;
  if (!q.length) continue;
  console.log(`\n■ ${nm}   (코드 ${code})`);
  h.forEach(([f, r]) => console.log(`   ${f}  ${r}`));
}
