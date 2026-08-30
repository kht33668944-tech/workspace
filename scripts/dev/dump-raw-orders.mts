import fs from "fs";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient, toKstIso } from "@/lib/naver-commerce-api";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const c = new CoupangOpenApiClient({ vendorId: env.COUPANG_VENDOR_ID, accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY });
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const r = await c.listOrderSheets({ createdAtFrom: ymd(new Date(Date.now() - 2 * 86400000)), createdAtTo: ymd(new Date()), status: "INSTRUCT", maxPerPage: 1 });
console.log("[coupang]", JSON.stringify(typeof r.body === "object" && r.body ? r.body.data?.[0] : r.message, null, 1));
const n = new NaverCommerceApiClient({ clientId: env.NAVER_COMMERCE_CLIENT_ID, clientSecret: env.NAVER_COMMERCE_CLIENT_SECRET });
const lc = await n.getLastChangedOrders({ lastChangedFrom: toKstIso(new Date(Date.now() - 86400000 * 1.5)), lastChangedTo: toKstIso(new Date(Date.now() - 86400000 * 0.5)), lastChangedType: "PAYED" });
const ids = (typeof lc.body === "object" && lc.body ? lc.body.data?.lastChangeStatuses ?? [] : []).slice(0, 1).map((s) => s.productOrderId);
console.log("[naver lastChanged sample]", JSON.stringify(typeof lc.body === "object" && lc.body ? lc.body.data?.lastChangeStatuses?.[0] : lc.message));
if (ids.length) { const q = await n.queryProductOrders(ids); console.log("[naver]", JSON.stringify(typeof q.body === "object" && q.body ? q.body.data?.[0] : q.message, null, 1)); }
