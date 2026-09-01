import fs from "fs";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const c = new CoupangOpenApiClient({ vendorId: env.COUPANG_VENDOR_ID, accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY });
const orderId = process.argv[2];
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const to = new Date(), from = new Date(Date.now() - 3 * 86400000);
for (const status of ["RU", "UC", "PR"] as const) {
  const r = await c.listReturnRequests({ createdAtFrom: ymd(from), createdAtTo: ymd(to), status, cancelType: "CANCEL" });
  if (!r.ok) { console.log(`[state] returnRequests ${status} 오류:`, r.status, r.message); continue; }
  const rows = (typeof r.body === "object" && r.body ? r.body.data : []) ?? [];
  console.log(`[state] returnRequests ${status}: ${rows.length}건`, JSON.stringify(rows.filter((x) => String(x.orderId) === orderId)));
}
const r2 = await c.listReturnRequests({ createdAtFrom: ymd(from), createdAtTo: ymd(to), cancelType: "CANCEL" });
const rows2 = ((typeof r2.body === "object" && r2.body ? r2.body.data : []) ?? []); if (!r2.ok) console.log("[state] all cancel 오류:", r2.status, r2.message, JSON.stringify(r2.body).slice(0,300));
console.log(`[state] returnRequests(all cancel): ${rows2.length}건`, JSON.stringify(rows2.filter((x) => String(x.orderId) === orderId)));
const o = await c.request("GET", `/v2/providers/openapi/apis/api/v4/vendors/${env.COUPANG_VENDOR_ID}/${orderId}/ordersheets`);
console.log("[state] ordersheet:", JSON.stringify(o.body).slice(0, 600));
