import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const ps=[]; for(let o=0;;o+=500){const {data}=await sb.from("products").select("product_name,registration_status,rebuild_status,platform_codes,seller_code").range(o,o+499); if(!data?.length)break; ps.push(...data); if(data.length<500)break;}
const c=(k)=>{const m=new Map();for(const p of ps){const v=String(p[k]??"(빈칸)");m.set(v,(m.get(v)??0)+1);}return [...m].sort((a,b)=>b[1]-a[1]);};
console.log("전체", ps.length);
console.log("registration_status", JSON.stringify(c("registration_status")));
console.log("rebuild_status", JSON.stringify(c("rebuild_status")));
const pc=(key)=>ps.filter(p=>Object.keys(p.platform_codes??{}).some(k=>k.includes(key))).length;
console.log("\nplatform_codes 보유: 스마트스토어", pc("스마트스토어"), "/ 지마켓", pc("지마켓"), "/ 옥션", pc("옥션"), "/ 쿠팡", pc("쿠팡"));
const keys=new Set(); ps.forEach(p=>Object.keys(p.platform_codes??{}).forEach(k=>keys.add(k)));
console.log("platform_codes 키 종류:", [...keys].join(" | ")||"(없음)");
// 이름 중복 (임포트가 상품명으로 매칭하므로 꼬인다)
const norm=(s)=>s.replace(/\s+/g,"").toLowerCase();
const m=new Map(); ps.filter(p=>p.rebuild_status==="조사완료"&&p.registration_status!=="판매중지").forEach(p=>{const k=norm(p.product_name); m.set(k,(m.get(k)??0)+1);});
const dup=[...m].filter(([,c])=>c>1);
console.log(`\n등록대상 중 이름 중복 ${dup.length}쌍 (임포트가 상품명으로 매칭하므로 한쪽만 연결됨)`);
