import { createClient } from "@supabase/supabase-js"; import fs from "fs";
const env = fs.readFileSync(".env.local","utf8");
const g=(k)=>(env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]?.trim();
const sb=createClient("https://ygunjfbtyowsumtxkukr.supabase.co", g("SUPABASE_SERVICE_ROLE_KEY"));
for (const t of ["smartstore_category_codes","smartstore_categories","category_codes"]) {
  const { data, error, count } = await sb.from(t).select("*", { count: "exact" }).limit(2);
  console.log(t, "→", error ? error.message : `${count}행 / 컬럼: ${Object.keys(data[0]??{}).join(",")}`);
  if (data?.[0]) console.log("   예:", JSON.stringify(data[0]).slice(0,220));
}
