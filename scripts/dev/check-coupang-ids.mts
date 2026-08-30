import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const c = new CoupangOpenApiClient({ vendorId: env.COUPANG_VENDOR_ID, accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const list = await c.request<{ data: Array<{ sellerProductId: number; sellerProductName: string; statusName: string }> }>("GET", "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products", { vendorId: env.COUPANG_VENDOR_ID, maxPerPage: 3, status: "APPROVED" });
const products = typeof list.body === "object" && list.body ? list.body.data : [];
console.log("[chk] 상품 목록:", products.map((p) => `${p.sellerProductId} ${p.sellerProductName.slice(0, 25)} ${p.statusName}`));
for (const p of products) {
  const d = await c.request<{ data: { items: Array<{ vendorItemId: number; itemName: string; salePrice: number }> } }>("GET", `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.sellerProductId}`);
  const items = typeof d.body === "object" && d.body ? d.body.data.items : [];
  const { data: cache } = await sb.from("coupang_price_inventory").select("vendor_item_id,option_id,coupang_product_id,registered_name,sale_price").eq("coupang_product_id", String(p.sellerProductId));
  const { data: cache2 } = await sb.from("coupang_price_inventory").select("vendor_item_id,option_id,coupang_product_id,registered_name,sale_price").in("vendor_item_id", items.map((i) => String(i.vendorItemId)));
  console.log(`[chk] ${p.sellerProductId}: API items=`, items.map((i) => `${i.vendorItemId}@${i.salePrice}`), "| cache by productId=", (cache ?? []).map((r) => `${r.vendor_item_id}/${r.option_id}/${r.coupang_product_id}@${r.sale_price}`), "| cache by vendorItemId=", (cache2 ?? []).length);
}
const { count } = await sb.from("coupang_price_inventory").select("id", { count: "exact", head: true });
console.log("[chk] 캐시 총 행:", count);
