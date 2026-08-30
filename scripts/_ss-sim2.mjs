import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const ps=[]; for(let o=0;;o+=500){const {data}=await sb.from("products").select("product_name,item_info").eq("rebuild_status","조사완료").neq("registration_status","판매중지").order("sort_order").range(o,o+499); if(!data?.length)break; ps.push(...data); if(data.length<500)break;}
const NAMES=["오뚜기 진라면 매운맛 40개","삼양 불닭볶음면 20개","신라면 큰사발 16개","피죤 건조기용 드라이시트 미스틱 플라워 240매","쏘피 바디피트 한결 중형 16P 6개","깨끗한나라 순수시그니처 화장지 브라운 30 60롤"];
for (const n of NAMES) { const p=ps.find(x=>x.product_name===n); if(!p){console.log("없음",n);continue;}
  const i=p.item_info??{};
  console.log(`\n■ ${n}`);
  for (const k of ["포장단위별용량","중량용량","개당용량","개당중량","제품명","용량출처"]) if(i[k]) console.log(`   ${k} = ${String(i[k]).slice(0,120)}`);
}
