import XLSX from "xlsx-js-style"; import fs from "fs"; import os from "os"; import path from "path";
const dir=path.join(os.homedir(),"Desktop","상품등록");
const rt=XLSX.utils.sheet_to_json(XLSX.readFile(path.join(dir,"플레이오토_스마트스토어_260824_재시도.xlsx")).Sheets["Sheet1"]??XLSX.readFile(path.join(dir,"플레이오토_스마트스토어_260824_재시도.xlsx")).Sheets[XLSX.readFile(path.join(dir,"플레이오토_스마트스토어_260824_재시도.xlsx")).SheetNames[0]],{defval:""});
const res=XLSX.utils.sheet_to_json(XLSX.readFile(process.argv[2]).Sheets[XLSX.readFile(process.argv[2]).SheetNames[0]],{defval:""});
const ng=res.filter(r=>String(r["결과"]).trim()!=="성공").map(r=>String(r["온라인 상품명"]).trim());
const have=new Set(rt.map(r=>String(r["온라인 상품명"]).trim()));
console.log(`실패 ${ng.length} / 재시도 파일 ${rt.length}`);
console.log("빠진 것:", ng.filter(n=>!have.has(n)).join(" | ")||"없음");
const d=(k)=>{const m=new Map();for(const r of rt){const v=String(r[k]??"").trim()||"(빈칸)";m.set(v,(m.get(v)??0)+1);}return JSON.stringify([...m].sort((a,b)=>b[1]-a[1]).slice(0,6));};
for(const k of ["단위 가격 표시 여부","표시 용량","표시 단위","개당 용량"]) console.log(k.padEnd(14), d(k));
// 옛 코드 유지 확인
const byName=new Map(res.map(r=>[String(r["온라인 상품명"]).trim(),String(r["판매자관리코드"]).trim()]));
let keep=0,chg=0; for(const r of rt){const o=byName.get(String(r["온라인 상품명"]).trim()); if(o===String(r["판매자관리코드"]).trim())keep++;else chg++;}
console.log(`판매자관리코드 유지 ${keep} / 바뀜 ${chg}`);
