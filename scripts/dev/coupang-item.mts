import fs from "fs";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const c = new CoupangOpenApiClient({ vendorId: env.COUPANG_VENDOR_ID, accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY });
const d = await c.request<{ data: { items: Array<{ vendorItemId: number; salePrice: number; maximumBuyCount: number }> } }>("GET", `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${process.argv[2]}`);
console.log("[item]", JSON.stringify(typeof d.body === "object" && d.body ? d.body.data.items.map((i) => ({ vendorItemId: i.vendorItemId, salePrice: i.salePrice, stock: i.maximumBuyCount })) : d.message));
