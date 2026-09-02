// 20260903_purchase_orders_claim_contact.sql 적용 여부 확인 (service_role 로 컬럼 select 시도)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const env = Object.fromEntries(readFileSync(resolve(process.cwd(), ".env.local"), "utf-8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
for (const col of ["purchase_orders", "claim_quantity", "claim_contact_updated_at"]) {
  const { error } = await sb.from("orders").select(col).limit(1);
  console.log(error ? `❌ ${col}: 미적용 (${error.message})` : `✅ ${col}: 적용됨`);
}
