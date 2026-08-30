import XLSX from "xlsx-js-style";
import fs from "fs"; import os from "os"; import path from "path";
const dir = path.join(os.homedir(), "Desktop", "상품등록");
const files = fs.readdirSync(dir).filter((f) => f.includes("스마트스토어_260824") && f.endsWith(".xlsx")).sort();
const rows = [];
for (const f of files) { const wb = XLSX.readFile(path.join(dir, f)); rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" })); }
console.log(`파일 ${files.length} / 행 ${rows.length}`);
const cnt = (k) => { const m = new Map(); for (const r of rows) { const v = String(r[k] ?? "").trim(); m.set(v, (m.get(v) ?? 0) + 1); } return [...m].sort((a,b)=>b[1]-a[1]).slice(0,8); };
for (const k of ["쇼핑몰(계정)","템플릿코드","상품분류코드","원산지"]) console.log(k, JSON.stringify(cnt(k)));
console.log("\n컬럼수", Object.keys(rows[0]).length);
console.log(Object.keys(rows[0]).join(" | "));
