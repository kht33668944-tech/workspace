// 발주서에서 "취소준비 + 판매처=스마트스토어" 주문을 뽑는다.
import { serviceClient, fetchAll } from "./_lib.mjs";
import fs from "fs";
const sb = serviceClient();
const rows = await fetchAll(sb, "orders",
  "id,bundle_no,order_date,marketplace,marketplace_order_no,marketplace_product_order_no,marketplace_orderer_name,recipient_name,product_name,quantity,delivery_status",
  (q) => q.eq("delivery_status", "취소준비").eq("marketplace", "스마트스토어").order("order_date", { ascending: false }));
const out = rows.map((o) => ({
  id: o.id,
  수취인명: (o.recipient_name || "").trim(),
  구매자명: (o.marketplace_orderer_name || "").trim(),
  상품명: (o.product_name || "").trim(),
  수량: o.quantity,
  주문번호: o.marketplace_order_no,
  상품주문번호: o.marketplace_product_order_no,
  bundle_no: o.bundle_no,
  주문일: o.order_date,
}));
fs.writeFileSync("scripts/_ss-targets.json", JSON.stringify(out, null, 1), "utf8");
console.log("[스토어대상]", out.length, "건 → scripts/_ss-targets.json");
for (const o of out) console.log(`   ${o.수취인명}/${o.구매자명} | ${o.상품명} | ${o.수량}개 | 주문일 ${String(o.주문일).slice(0,10)} | 주문번호 ${o.주문번호} | 상품주문번호 ${o.상품주문번호}`);
