import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env=fs.readFileSync(".env.local","utf8"); const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
const { data, error, count } = await sb.from("esm_price_inventory").select("*", { count: "exact" }).limit(3);
if (error) { console.log("조회 실패:", error.message); process.exit(0); }
console.log(`esm_price_inventory ${count}행`);
console.log("컬럼:", Object.keys(data[0]??{}).join(", "));
data.slice(0,2).forEach(r=>console.log(JSON.stringify(r).slice(0,400)));
