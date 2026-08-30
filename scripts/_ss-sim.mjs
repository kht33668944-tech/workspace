import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const ps=[]; for(let o=0;;o+=500){const {data}=await sb.from("products").select("product_name,item_info").eq("rebuild_status","조사완료").neq("registration_status","판매중지").order("sort_order").range(o,o+499); if(!data?.length)break; ps.push(...data); if(data.length<500)break;}

// 이름에서 개당 용량/중량을 뽑는다. ml·L은 ml로, g·kg은 g으로.
function unitOf(name, info) {
  const m = name.match(/(\d+(?:\.\d+)?)\s*(ml|mL|ML|L|l|g|G|kg|Kg|KG)(?=\s|$|\d)/);
  if (m) {
    const n = parseFloat(m[1]); const u = m[2].toLowerCase();
    if (u === "ml") return { v: n, u: "ml" };
    if (u === "l") return { v: n * 1000, u: "ml" };
    if (u === "g") return { v: n, u: "g" };
    if (u === "kg") return { v: n * 1000, u: "g" };
  }
  // 이름에 없으면 조사해 둔 값을 쓴다
  for (const k of ["개당용량", "개당중량"]) {
    const s = String(info?.[k] ?? "").trim();
    const mm = s.match(/(\d+(?:\.\d+)?)\s*(ml|mL|ML|L|l|g|G|kg|Kg|KG)/);
    if (mm) { const n=parseFloat(mm[1]); const u=mm[2].toLowerCase();
      if(u==="ml")return{v:n,u:"ml"}; if(u==="l")return{v:n*1000,u:"ml"}; if(u==="g")return{v:n,u:"g"}; if(u==="kg")return{v:n*1000,u:"g"}; }
  }
  return null;
}
let ok=0, no=[];
for (const p of ps) { const u=unitOf(p.product_name,p.item_info); if(u) ok++; else no.push(p.product_name); }
console.log(`전체 ${ps.length} / 용량 확보 ${ok} / 못 뽑음 ${no.length}`);
no.slice(0,200).forEach(n=>console.log("  ✗",n));
