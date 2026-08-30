// 이미 API로 등록된 발주서(source='api') 중 최저가 링크/원가가 빈 행을 상품 목록으로 채운다
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { enrichOrdersWithProducts } from "@/lib/marketplace/order-sync";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data } = await sb.from("orders").select("id,product_name,quantity,purchase_url,cost").eq("user_id", env.SYNC_USER_ID).eq("source", "api").or("purchase_url.is.null,cost.eq.0");
const rows = (data ?? []) as Array<{ id: string; product_name: string | null; quantity: number; purchase_url: string | null; cost: number }>;
const before = rows.map((r) => ({ ...r }));
const res = await enrichOrdersWithProducts(sb, env.SYNC_USER_ID, rows);
let updated = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i], b = before[i];
  if (r.purchase_url === b.purchase_url && r.cost === b.cost) continue;
  const { error } = await sb.from("orders").update({ purchase_url: r.purchase_url, cost: r.cost }).eq("id", r.id);
  if (!error) updated++;
}
console.log(`[backfill] 대상 ${rows.length} / 링크 ${res.urlMatched} / 원가 ${res.costMatched} / 갱신 ${updated}`);
for (const r of rows.filter((r) => !r.purchase_url)) console.log("  미매칭:", r.product_name);
