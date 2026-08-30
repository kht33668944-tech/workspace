import fs from "fs";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const c = new CoupangOpenApiClient({ vendorId: env.COUPANG_VENDOR_ID, accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY });
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const to = new Date(), from = new Date(Date.now() - 2 * 86400000);
for (const status of [undefined, "RU", "UC"] as const) {
  const r = await c.listReturnRequests({ createdAtFrom: ymd(from), createdAtTo: ymd(to), status, cancelType: "RETURN" });
  const rows = ((typeof r.body === "object" && r.body ? r.body.data : []) ?? []) as unknown as Array<Record<string, unknown>>;
  console.log(`[list] status=${status ?? "all"} ${r.status} ${rows.length}건`);
  for (const x of rows) console.log("  ", JSON.stringify({ receiptId: x.receiptId, orderId: x.orderId, receiptStatus: x.receiptStatus, createdAt: x.createdAt, reason: x.cancelReason, items: (x.returnItems as Array<Record<string, unknown>> ?? []).map((i) => `${i.vendorItemId}:${i.cancelCount}:${i.releaseStatus}`) }));
}
