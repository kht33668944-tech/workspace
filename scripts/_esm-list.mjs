// 발주서에서 "취소준비 + 판매처=지마켓/옥션" 주문을 뽑는다.
import { serviceClient, fetchAll } from "./_lib.mjs";
import fs from "fs";

const sb = serviceClient();
const rows = await fetchAll(sb, "orders",
  "id,bundle_no,order_date,marketplace,marketplace_orderer_name,recipient_name,product_name,quantity,delivery_status",
  (q) => q.eq("delivery_status", "취소준비").order("order_date", { ascending: false }));

const esm = rows.filter((o) => ["지마켓", "옥션"].includes(o.marketplace));
const out = esm.map((o) => ({
  id: o.id,
  마켓: o.marketplace,
  수령인명: (o.recipient_name || "").trim(),
  구매자명: (o.marketplace_orderer_name || "").trim(),
  상품명: (o.product_name || "").trim(),
  수량: o.quantity,
  bundle_no: o.bundle_no,
  status: "대기",
}));
fs.writeFileSync("scripts/_esm-targets.json", JSON.stringify(out, null, 1), "utf8");
const mk = {}; for (const o of out) mk[o.마켓] = (mk[o.마켓] || 0) + 1;
console.log("[ESM대상]", out.length, "건 |", JSON.stringify(mk), "→ scripts/_esm-targets.json");
for (const o of out.slice(0, 6)) console.log(`   ${o.마켓} | 수령 ${o.수령인명} / 구매 ${o.구매자명} | ${o.상품명} | ${o.수량}개`);
