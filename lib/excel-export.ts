import * as XLSX from "xlsx";
import type { Order } from "@/types/database";

/** 발주서 양식 엑셀 생성 (현재 발주서 테이블과 동일한 양식) */
export function generateOrderExcel(orders: Order[]): { buffer: ArrayBuffer; filename: string } {
  const today = new Date().toISOString().slice(0, 10);
  const data = orders.map((o) => ({
    묶음번호: o.bundle_no,
    주문일시: o.order_date ? o.order_date.slice(0, 16).replace("T", " ") : null,
    판매처: o.marketplace,
    수취인명: o.recipient_name,
    상품명: o.product_name,
    수량: o.quantity,
    수령자번호: o.recipient_phone,
    주문자번호: o.orderer_phone,
    우편번호: o.postal_code,
    기본주소: o.address,
    상세주소: o.address_detail,
    배송메모: o.delivery_memo,
    매출: o.revenue,
    정산예정: o.settlement,
    원가: o.cost,
    마진: o.margin,
    결제방식: o.payment_method,
    구매아이디: o.purchase_id,
    구매처: o.purchase_source,
    주문번호: o.purchase_order_no,
    택배사: o.courier,
    운송장: o.tracking_no,
    배송상태: o.delivery_status,
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "배송조회수집");
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const filename = `배송조회수집_${today}.xlsx`;

  return { buffer, filename };
}

/**
 * 플레이오토 대량 운송장 전송 양식 엑셀 생성
 * 양식: 묶음번호 | 택배사(코드숫자) | 운송장번호
 * @param courierCodeMap 택배사명 → 코드 매핑 (사용자 설정 or 기본값)
 */
export function generatePlayAutoTrackingExcel(
  orders: Order[],
  courierCodeMap: Record<string, number> = {}
): { buffer: ArrayBuffer; filename: string } {
  const today = new Date().toISOString().slice(0, 10);

  // 운송장이 있는 주문만 필터링
  const trackingOrders = orders.filter((o) => o.tracking_no && o.tracking_no.trim() !== "");

  const data = trackingOrders.map((o) => ({
    묶음번호: o.bundle_no || "",
    택배사: courierCodeMap[o.courier || ""] ?? o.courier ?? "",
    운송장번호: o.tracking_no || "",
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "운송장전송");
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const filename = `플레이오토_운송장_${today}.xlsx`;

  return { buffer, filename };
}

/** ArrayBuffer를 base64 문자열로 변환 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** base64 문자열을 ArrayBuffer로 변환 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** 엑셀 다운로드 트리거 */
export function downloadExcel(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** base64 데이터로부터 엑셀 다운로드 */
export function downloadExcelFromBase64(base64: string, filename: string) {
  const buffer = base64ToArrayBuffer(base64);
  downloadExcel(buffer, filename);
}
