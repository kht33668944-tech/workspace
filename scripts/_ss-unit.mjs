import XLSX from "xlsx-js-style"; import fs from "fs"; import os from "os"; import path from "path";
const dir = path.join(os.homedir(), "Desktop", "상품등록");
const rows = [];
for (const f of fs.readdirSync(dir).filter((f)=>f.includes("스마트스토어_260824")&&f.endsWith(".xlsx")).sort()) {
  const wb = XLSX.readFile(path.join(dir,f)); rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""}));
}
const KS=["단위 가격 표시 여부","표시 용량","표시 단위","구성 방식","팩 수량","팩당 수량","팩당 수량 단위","개당 용량"];
for (const k of KS) { const m=new Map(); for(const r of rows){const v=String(r[k]??"").trim()||"(빈칸)"; m.set(v,(m.get(v)??0)+1);} console.log(k.padEnd(16), JSON.stringify([...m].sort((a,b)=>b[1]-a[1]).slice(0,5))); }
const y = rows.filter(r=>String(r["단위 가격 표시 여부"]).trim().toUpperCase()==="Y");
console.log("\nY인 행", y.length);
if(y[0]) console.log("예:", y[0]["온라인 상품명"], "|", KS.map(k=>`${k}=${y[0][k]}`).join(" "));
