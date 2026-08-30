import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const RE=/(\d+(?:\.\d+)?)\s*(ml|l|g|kg)(?=\s|$|\d)/i;
const ps=[]; for(let o=0;;o+=500){const {data}=await sb.from("products").select("product_name,item_info,category").eq("rebuild_status","조사완료").neq("registration_status","판매중지").order("sort_order").range(o,o+499); if(!data?.length)break; ps.push(...data); if(data.length<500)break;}
const left=ps.filter(p=>!RE.test(p.product_name) && !RE.test(String(p.item_info?.개당용량??"")) && !RE.test(String(p.item_info?.개당중량??"")));
// 매·롤·P·매수 단위는 단위가격 대상이 아니다
const NOTVOL=/\d+\s*(매|롤|P|p)(?=\s|$)|화장지|키친타올|티슈|생리대|팬티라이너|탐폰|건조기시트|드라이시트|지퍼백|숙면팬티|순면커버/;
const food=left.filter(p=>!NOTVOL.test(p.product_name));
console.log(`미확보 ${left.length} / 그중 용량 단위가 맞는 것 ${food.length}`);
food.forEach(p=>console.log("  -",p.product_name));
