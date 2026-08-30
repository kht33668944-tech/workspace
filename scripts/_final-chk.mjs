import XLSX from "xlsx-js-style"; import { createClient } from "@supabase/supabase-js";
import fs from "fs"; import os from "os"; import path from "path";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const dir=path.join(os.homedir(),"Desktop","상품등록");
const rows=[];
for(const f of fs.readdirSync(dir).filter(x=>x.includes("스마트스토어_260824")&&x.endsWith(".xlsx")).sort()){
  const wb=XLSX.readFile(path.join(dir,f)); rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""}));
}
// DB 코드와 파일 코드가 일치하는가 (어긋나면 주문 매칭이 깨진다)
const ps=[]; for(let o=0;;o+=500){const {data}=await sb.from("products").select("product_name,seller_code").eq("rebuild_status","조사완료").neq("registration_status","판매중지").range(o,o+499); if(!data?.length)break; ps.push(...data); if(data.length<500)break;}
const dbCodes=new Set(ps.map(p=>String(p.seller_code?.smartstore??"")).filter(Boolean));
const fileCodes=rows.map(r=>String(r["판매자관리코드"]).trim());
const notInDb=fileCodes.filter(c=>!dbCodes.has(c));
console.log(`파일 ${rows.length}행 / 코드 고유 ${new Set(fileCodes).size} / DB에 없는 코드 ${notInDb.length}`);
// 단위가격
const d=(k)=>{const m=new Map();for(const r of rows){const v=String(r[k]??"").trim()||"(빈칸)";m.set(v,(m.get(v)??0)+1);}return JSON.stringify([...m].sort((a,b)=>b[1]-a[1]).slice(0,5));};
console.log("표시 여부", d("단위 가격 표시 여부"), "\n표시 용량", d("표시 용량"), "\n표시 단위", d("표시 단위"));
