// 발주서에서 "취소준비 + 판매처=쿠팡" 주문을 뽑아 JSON으로 저장한다.
// 쿠팡윙 목록과는 수취인명 + 상품명(+수량)으로 대조한다 (묶음번호는 윙 주문번호와 체계가 다름).
import { serviceClient, fetchAll } from "./_lib.mjs";
import fs from "fs";

const sb = serviceClient();
const rows = await fetchAll(sb, "orders",
  "id,bundle_no,order_date,marketplace,recipient_name,product_name,quantity,delivery_status",
  (q) => q.eq("delivery_status", "취소준비").order("order_date", { ascending: false }));

const coupang = rows.filter((o) => (o.marketplace || "").includes("쿠팡"));
const out = coupang.map((o) => ({
  id: o.id,
  bundle_no: o.bundle_no,
  recipient_name: (o.recipient_name || "").trim(),
  product_name: (o.product_name || "").trim(),
  quantity: o.quantity,
  order_date: o.order_date,
  status: "대기",
}));

fs.writeFileSync("scripts/_cancel-targets.json", JSON.stringify(out, null, 1), "utf8");
console.log("[취소목록] 쿠팡 취소준비:", out.length, "건 → scripts/_cancel-targets.json");
for (const o of out) console.log(`  ${o.recipient_name} | ${o.product_name} | ${o.quantity}개`);
