import XLSX from "xlsx-js-style"; import { createClient } from "@supabase/supabase-js";
import fs from "fs"; import os from "os"; import path from "path";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const rd=(f)=>{const wb=XLSX.readFile(f);return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});};
const src=rd("C:/Users/kht33/Downloads/260824225037_214999_3708185_쇼핑몰상품_일반_엑셀일괄등록_결과.xlsx");
const out=rd(path.join(os.homedir(),"Desktop","상품등록","플레이오토_스마트스토어_260824_재시도.xlsx"));
const have=new Set(out.map(r=>String(r["온라인 상품명"]).trim()));
const seen=new Set(); const miss=[];
for(const r of src){const n=String(r["온라인 상품명"]).trim(); if(seen.has(n)){miss.push([n,"엑셀에 중복된 행"]);continue;} seen.add(n); if(!have.has(n))miss.push([n,"?"]);}
for(const m of miss){ if(m[1]!=="?")continue;
  const {data}=await sb.from("products").select("registration_status,rebuild_status").eq("product_name",m[0]).limit(1);
  m[1]= data?.[0] ? `등록상태=${data[0].registration_status} / 재정비=${data[0].rebuild_status}` : "DB에 상품 없음";
}
console.log(`원본 ${src.length} / 생성 ${out.length} / 빠짐 ${miss.length}`);
miss.forEach(([n,w])=>console.log(`  ✗ ${n}\n        ${w}`));
