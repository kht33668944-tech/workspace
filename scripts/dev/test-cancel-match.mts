// 발주서를 건드리지 않고 마켓 주문 수집 + 대조 로직을 검증하는 개발용 스크립트
//   npx tsx scripts/dev/test-cancel-match.ts [coupang|smartstore] [days]
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { collectCoupangOrders, collectSmartstoreOrders, matchOrders, type CancelOrderRow, type CancelPlatform } from "@/lib/marketplace/order-cancel";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
);
const platform = (process.argv[2] ?? "coupang") as CancelPlatform;
const days = Number(process.argv[3] ?? 7);
const label = platform === "coupang" ? "쿠팡" : "스마트스토어";

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const { data } = await sb
  .from("orders")
  .select("id,bundle_no,order_date,marketplace,recipient_name,marketplace_orderer_name,product_name,quantity,marketplace_order_no,marketplace_product_order_no,delivery_status")
  .ilike("marketplace", `%${label}%`)
  .gte("order_date", since)
  .order("order_date", { ascending: false })
  .limit(60);
const orders = (data ?? []) as (CancelOrderRow & { delivery_status: string })[];
console.log(`[test] 발주서 ${label} 최근 ${days}일: ${orders.length}건`);

const t0 = Date.now();
const remote =
  platform === "coupang"
    ? await collectCoupangOrders(new CoupangOpenApiClient({ vendorId: env.COUPANG_VENDOR_ID, accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY }), days)
    : await collectSmartstoreOrders(new NaverCommerceApiClient({ clientId: env.NAVER_COMMERCE_CLIENT_ID, clientSecret: env.NAVER_COMMERCE_CLIENT_SECRET }), days);
console.log(`[test] 마켓 주문 ${remote.length}건 수집 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
for (const r of remote.slice(0, 3)) console.log("   remote:", r.status, r.recipientName, "|", r.productName.slice(0, 40), "x", r.quantity);

const preview = matchOrders(platform, orders, remote);
console.log(`[test] 매칭 ${preview.matched.length} / 제외 ${preview.skipped.length}`);
for (const m of preview.matched.slice(0, 5)) console.log("  ✔", m.order.delivery_status, m.order.recipient_name, "|", m.order.product_name?.slice(0, 30), "→", m.remote.status, m.remote.orderId);
const reasons = new Map<string, number>();
for (const s of preview.skipped) reasons.set(s.reason.replace(/\(.*\)/, ""), (reasons.get(s.reason.replace(/\(.*\)/, "")) ?? 0) + 1);
console.log("  제외 사유:", Object.fromEntries(reasons));
for (const s of preview.skipped.slice(0, 4)) console.log("  ✖", s.order.delivery_status, s.order.recipient_name, "|", s.order.product_name?.slice(0, 30), "|", s.reason);
