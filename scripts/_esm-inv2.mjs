import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const rows=[]; for(let o=0;;o+=1000){const {data}=await sb.from("esm_price_inventory").select("seller_code,site,updated_at,product_id").range(o,o+999); if(!data?.length)break; rows.push(...data); if(data.length<1000)break;}
const era=new Map();
for(const r of rows){ const c=String(r.seller_code??""); const k = /^2608/.test(c)&&c.length>=10 ? "이번 재등록(2608…)" : c ? `옛 코드 ${c.slice(0,4)}…` : "(빈칸)"; era.set(k,(era.get(k)??0)+1); }
console.log("ESM 캐시 2590행의 판매자관리코드 시기");
[...era].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${String(v).padStart(5)}  ${k}`));
const up=new Map(); rows.forEach(r=>{const d=String(r.updated_at??"").slice(0,10); up.set(d,(up.get(d)??0)+1);});
console.log("\n갱신일:", JSON.stringify([...up].sort((a,b)=>b[1]-a[1]).slice(0,5)));
console.log("연결된 상품 수:", new Set(rows.map(r=>r.product_id).filter(Boolean)).size);
