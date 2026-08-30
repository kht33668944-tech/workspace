import XLSX from "xlsx-js-style"; import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const wb=XLSX.readFile(process.argv[2]);
const res=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
const ok=res.filter(r=>String(r["결과"]).trim()==="성공");
console.log("성공 176건 중 DB 코드가 그대로인지 확인");
let same=0, diff=0, ex=[];
for (const r of ok) {
  const nm=String(r["온라인 상품명"]).trim();
  const {data}=await sb.from("products").select("seller_code").eq("product_name",nm).limit(1);
  const cur=String(data?.[0]?.seller_code?.smartstore ?? "");
  if (cur===String(r["판매자관리코드"]).trim()) same++; else { diff++; if(ex.length<5) ex.push(`${nm}: 엑셀 ${r["판매자관리코드"]} vs DB ${cur}`); }
}
console.log(`같음 ${same} / 달라짐 ${diff}`);
ex.forEach(x=>console.log("  ",x));
