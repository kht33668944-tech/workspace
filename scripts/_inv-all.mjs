import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
for (const t of ["smartstore_price_inventory","coupang_price_inventory","esm_price_inventory"]) {
  const rows=[]; for(let o=0;;o+=1000){const {data,error}=await sb.from(t).select("*").range(o,o+999); if(error){console.log(t,"→",error.message);break;} if(!data?.length)break; rows.push(...data); if(data.length<1000)break;}
  if(!rows.length){console.log(`${t}  0행`);continue;}
  const up=new Map(); rows.forEach(r=>{const d=String(r.updated_at??r.created_at??"").slice(0,10); up.set(d,(up.get(d)??0)+1);});
  console.log(`${t}  ${rows.length}행  갱신일 ${JSON.stringify([...up].sort((a,b)=>b[1]-a[1]).slice(0,3))}`);
}
