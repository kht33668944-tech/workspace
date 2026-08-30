// 쿠팡 셀러센터 "엑셀 일괄변경" 양식 (가격/재고/판매상태) 정의 — 가격수정 v2 전용
// 양식 구조: 1행 안내문 / 2행 그룹헤더 / 3행 컬럼명 / 4행~ 실제 데이터
// 컬럼 매칭은 부분일치(.includes)로 양식 마이너 변경 흡수

export const HEADER_ROW_INDEX = 2; // 0-based, 3번째 행이 컬럼명
export const DATA_START_ROW_INDEX = 3; // 0-based, 4번째 행부터 데이터

// 0-based 컬럼 인덱스 (양식 A~S = 0~18)
export const COL = {
  vendor_item_id: 0,       // A: 업체상품 ID (= sellerProductId. API 의 vendorItemId 가 아님)
  coupang_product_id: 1,   // B: Product ID
  option_id: 2,            // C: 옵션 ID (= OpenAPI vendorItemId — 가격/재고 API 키)
  product_status: 3,       // D: 상품상태
  barcode: 4,              // E: 바코드
  vendor_item_code: 5,     // F: 업체상품코드
  coupang_display_name: 6, // G: 쿠팡 노출 상품명
  registered_name: 7,      // H: 업체 등록 상품명
  option_name: 8,          // I: 등록 옵션명
  sale_price: 9,           // J: 판매가격
  discount_base_price: 10, // K: 할인율기준가
  sale_status: 11,         // L: 판매상태
  stock: 12,               // M: 잔여수량(재고)
  sales_count: 13,         // N: 판매수량
  approval_status: 14,     // O: 승인상태
  // 변경/수정 요청 영역 (P~S)
  new_sale_price: 15,      // P: 판매가격(변경) — 우리가 채울 컬럼
  new_discount_base: 16,   // Q: 할인율기준가(변경)
  new_sale_status: 17,     // R: 판매상태(변경)
  new_stock: 18,           // S: 잔여수량(변경)
} as const;

// 헤더 매칭에 쓰는 부분일치 키워드 (3행 셀 값에 포함돼야 함)
export const HEADER_KEYWORDS: Record<keyof typeof COL, string> = {
  vendor_item_id: "업체상품 ID",
  coupang_product_id: "Product ID",
  option_id: "옵션 ID",
  product_status: "상품상태",
  barcode: "바코드",
  vendor_item_code: "업체상품코드",
  coupang_display_name: "쿠팡 노출 상품명",
  registered_name: "업체 등록 상품명",
  option_name: "등록 옵션명",
  sale_price: "판매가격",
  discount_base_price: "할인율기준가",
  sale_status: "판매상태",
  stock: "잔여수량",
  sales_count: "판매수량",
  approval_status: "승인상태",
  new_sale_price: "판매가격",
  new_discount_base: "할인율기준가",
  new_sale_status: "판매상태",
  new_stock: "잔여수량",
};

/** trim + NFC 정규화 — 상품명 매칭의 안정성 확보 */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? "").trim().normalize("NFC");
}

/** 셀 값을 문자열로 안전 추출 */
export function cellString(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/** 셀 값을 정수로 안전 추출 (빈값/NaN → null) */
export function cellInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
