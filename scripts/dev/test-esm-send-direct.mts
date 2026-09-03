// generateEsmSendExcelDirect 검증 — 픽스처 5행으로 count/orderIds/헤더/내용을 확인 (DB 접근 없음)
//   npx tsx scripts/dev/test-esm-send-direct.mts
import XLSX from "xlsx-js-style";
import { generateEsmSendExcelDirect } from "@/lib/excel-export";
import type { Order } from "@/types/database";

function fixture(o: Partial<Order> & { id: string }): Order {
  return {
    user_id: "test-user",
    bundle_no: null,
    order_date: "2026-09-03T00:00:00Z",
    marketplace: null,
    marketplace_order_no: null,
    marketplace_product_order_no: null,
    marketplace_orderer_name: null,
    recipient_name: "홍길동",
    product_name: "테스트상품",
    quantity: 1,
    recipient_phone: null,
    orderer_phone: null,
    postal_code: null,
    address: null,
    address_detail: null,
    delivery_memo: null,
    revenue: 0,
    settlement: 0,
    cost: 0,
    margin: 0,
    payment_method: null,
    purchase_id: null,
    purchase_source: null,
    purchase_url: null,
    purchase_order_no: null,
    courier: null,
    tracking_no: null,
    delivery_status: "배송준비",
    purchased_at: null,
    delivered_at: null,
    returned_at: null,
    is_duplicate: false,
    consultation_logs: [],
    order_month: "2026-09",
    memo: null,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    ...o,
  } as Order;
}

const orders: Order[] = [
  fixture({ id: "1", marketplace: "옥션", marketplace_order_no: "AUC-001", courier: "CJ대한통운", tracking_no: "111-1111-1111" }),
  fixture({ id: "2", marketplace: "지마켓", marketplace_order_no: "GM-002", courier: "한진택배", tracking_no: "222-2222-2222" }),
  fixture({ id: "3", marketplace: "지마켓", marketplace_order_no: "GM-003", courier: "한진택배", tracking_no: null }), // 운송장 없음 → 제외
  fixture({ id: "4", marketplace: "옥션", marketplace_order_no: null, courier: "CJ대한통운", tracking_no: "444-4444-4444" }), // 주문번호 없음(구 플레이오토) → 제외
  fixture({ id: "5", marketplace: "쿠팡", marketplace_order_no: "CP-005", courier: "CJ대한통운", tracking_no: "555-5555-5555" }), // 쿠팡 → 제외
];

const { buffer, count, orderIds } = await generateEsmSendExcelDirect(orders);

let fail = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
}

check("count === 2", count === 2);
check("orderIds === ['1','2']", JSON.stringify(orderIds) === JSON.stringify(["1", "2"]));
check("buffer not null", buffer !== null);

if (buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: (string | number)[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  check("헤더 = [계정,주문번호,택배사,운송장번호]", JSON.stringify(rows[0]) === JSON.stringify(["계정", "주문번호", "택배사", "운송장번호"]));
  check("1행 옥션(redgoom00)", rows[1]?.[0] === "옥션(redgoom00)");
  check("1행 주문번호 AUC-001", rows[1]?.[1] === "AUC-001");
  check("1행 택배사 CJ택배", rows[1]?.[2] === "CJ택배");
  check("1행 운송장 11111111111", rows[1]?.[3] === "11111111111");
  check("총 3행 (헤더+2건)", rows.length === 3);
}

if (fail > 0) {
  console.error(`\n[FAIL] ${fail}건 실패`);
  process.exit(1);
} else {
  console.log("\n[PASS] 전부 통과");
}
