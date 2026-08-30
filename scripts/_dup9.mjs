import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const ps=[]; for(let o=0;;o+=500){const {data}=await sb.from("products").select("product_name,lowest_price,registration_status,rebuild_status,seller_code").range(o,o+499); if(!data?.length)break; ps.push(...data); if(data.length<500)break;}
const t=ps.filter(p=>p.rebuild_status==="조사완료"&&p.registration_status!=="판매중지");
const m=new Map(); t.forEach(p=>{const k=p.product_name.trim().normalize("NFC"); if(!m.has(k))m.set(k,[]); m.get(k).push(p);});
[...m].filter(([,v])=>v.length>1).forEach(([k,v])=>console.log(`${k}\n     ${v.map(p=>`${p.lowest_price}원(${p.seller_code?.smartstore??"-"})`).join("  |  ")}`));
