import XLSX from "xlsx-js-style"; import { createClient } from "@supabase/supabase-js";
import fs from "fs"; import os from "os"; import path from "path";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const stop=new Set(); for(let f=0;;f+=500){const {data}=await sb.from("products").select("product_name").eq("registration_status","판매중지").range(f,f+499); if(!data?.length)break; data.forEach(r=>stop.add(r.product_name.trim())); if(data.length<500)break;}
const dir=path.join(os.homedir(),"Desktop","상품등록"); const names=new Set();
for(const f of fs.readdirSync(dir).filter(x=>x.includes("스마트스토어_260824")&&x.endsWith(".xlsx"))){const wb=XLSX.readFile(path.join(dir,f)); XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""}).forEach(r=>names.add(String(r["온라인 상품명"]).trim()));}
const hit=[...names].filter(n=>stop.has(n));
console.log(`판매중지 ${stop.size}건 / 엑셀 ${names.size}건 / 엑셀에 섞인 판매중지 ${hit.length}건`);
hit.slice(0,10).forEach(n=>console.log("  ⚠",n));
