// 송장 전송 기준선: 이미 마켓에서 배송중/완료인 주문은 "전송됨"으로, 기존 ESM 운송장은 "엑셀로 내보냄"으로 표시 (1회)
//   npx tsx scripts/dev/baseline-shipped.mts
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/).filter((l)=>/^[A-Z_]+=/.test(l)).map((l)=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).trim()];}));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = env.SYNC_USER_ID;
const now = new Date().toISOString();
type R = { id: string; marketplace: string | null; marketplace_status: string | null; delivery_status: string; tracking_no: string | null; shipped_to_marketplace_at: string | null; tracking_exported_at: string | null; order_date: string | null; delivered_at: string | null };
const rows: R[] = [];
for (let off = 0; ; off += 1000) {
  const { data, error } = await sb.from("orders").select("id,marketplace,marketplace_status,delivery_status,tracking_no,shipped_to_marketplace_at,tracking_exported_at,order_date,delivered_at").eq("user_id", userId).not("tracking_no","is",null).neq("tracking_no","").order("order_date",{ascending:false}).range(off, off+999);
  if (error) throw new Error(error.message);
  rows.push(...((data ?? []) as R[]));
  if (!data || data.length < 1000) break;
}
console.log("tracking rows:", rows.length);
const NOT_SHIPPED = new Set(["ACCEPT","INSTRUCT","PAYED","PAYMENT_WAITING"]);
const shipIds: string[] = []; const pendingMarket: string[] = []; const esmIds: string[] = [];
for (const r of rows ?? []) {
  const m = r.marketplace ?? "";
  if ((m.includes("쿠팡") || m.includes("스마트스토어")) && !r.shipped_to_marketplace_at) {
    // 마켓 상태가 발송 후이거나, 운송장이 오늘(KST) 이전에 잡힌 건은 플토로 이미 전송된 것으로 본다
    const deliveredKst = r.delivered_at ? new Date(new Date(r.delivered_at).getTime() + 9 * 3600000).toISOString().slice(0, 10) : null;
    const todayKst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    if ((r.marketplace_status && !NOT_SHIPPED.has(r.marketplace_status)) || !deliveredKst || deliveredKst < todayKst) shipIds.push(r.id);
    else pendingMarket.push(`${m} ${r.order_date?.slice(0,10)} ${r.marketplace_status ?? "-"} ${r.delivery_status}`);
  }
  if (["지마켓","옥션","11번가"].some((x) => m.includes(x)) && !r.tracking_exported_at) esmIds.push(r.id);
}
for (let i = 0; i < shipIds.length; i += 200) await sb.from("orders").update({ shipped_to_marketplace_at: now }).in("id", shipIds.slice(i, i+200));
for (let i = 0; i < esmIds.length; i += 200) await sb.from("orders").update({ tracking_exported_at: now }).in("id", esmIds.slice(i, i+200));
console.log(`shipped baseline: ${shipIds.length}건 표시 / 아직 미발송 상태로 남은 건: ${pendingMarket.length}`);
for (const p of pendingMarket.slice(0, 15)) console.log("  ", p);
console.log(`ESM exported baseline: ${esmIds.length}건 표시`);
process.exit(0);
