// UID 필수 반려 상품이 어떤 브랜드/상품인지, 바코드가 정말 없는지 본다.
import XLSX from "xlsx-js-style";
const rd=(f)=>{const wb=XLSX.readFile(f);return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});};
const up=rd(process.argv[2]), job=rd(process.argv[3]);
const by=new Map(up.map(r=>[String(r["판매자관리코드"]).trim(),r]));
const fails=job.filter(j=>String(j["작업결과"]).trim()!=="성공");
let noBar=0, hasBar=0;
const rows=[];
for(const f of fails){
  const s=by.get(String(f["판매자관리코드"]).trim());
  const bar=String(s?.["옵션바코드"]||"").trim();
  const mpnOk=/GTIN, MPN/.test(f["결과메세지"]);
  rows.push({name:String(s?.["온라인 상품명"]||"?"),bar,mpnOk,brand:String(s?.["브랜드"]||"")});
  bar?hasBar++:noBar++;
}
console.log(`실패 ${fails.length} / 바코드있음 ${hasBar} / 바코드없음 ${noBar}`);
console.log(`\n== MPN 허용 (${rows.filter(r=>r.mpnOk).length}건) ==`);
for(const r of rows.filter(r=>r.mpnOk)) console.log(` [${r.brand}] ${r.name}  bar=${r.bar||"-"}`);
console.log(`\n== GTIN만 (${rows.filter(r=>!r.mpnOk).length}건) ==`);
for(const r of rows.filter(r=>!r.mpnOk)) console.log(` [${r.brand}] ${r.name}  bar=${r.bar||"-"}`);
