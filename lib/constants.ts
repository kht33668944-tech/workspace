// 마켓플레이스 정보
export const MARKETPLACES: Record<string, { label: string; color: string }> = {
  쿠팡: { label: "쿠팡", color: "bg-blue-500/20 text-blue-400" },
  스마트스토어: { label: "스마트스토어", color: "bg-green-500/20 text-green-400" },
  지마켓: { label: "지마켓", color: "bg-red-500/20 text-red-400" },
  옥션: { label: "옥션", color: "bg-orange-500/20 text-orange-400" },
  "11번가": { label: "11번가", color: "bg-pink-500/20 text-pink-400" },
};

// 플레이오토 엑셀 한글 헤더 → DB 컬럼 매핑
export const EXCEL_COLUMN_MAP: Record<string, string> = {
  묶음번호: "bundle_no",
  주문일시: "order_date",
  판매처: "marketplace",
  수취인명: "recipient_name",
  상품명: "product_name",
  수량: "quantity",
  수령자번호: "recipient_phone",
  주문자번호: "orderer_phone",
  우편번호: "postal_code",
  주소: "address",
  배송메모: "delivery_memo",
  매출: "revenue",
};

// 기존 발주서(구글 드라이브) 엑셀 헤더 → DB 컬럼 매핑
// 컬럼 순서: 묶음번호, 주문일시, 판매처, 수취인명, 상품명, 수량, 수령자번호, 주문자번호,
//           우편번호, 주소, 배송메모, 매출, 정산예정, 원가, 마진, 결제방식, 구매처, 아이디, 주문번호, 택배사, 운송장
export const LEGACY_EXCEL_COLUMN_MAP: Record<string, string> = {
  묶음번호: "bundle_no",
  주문일시: "order_date",
  판매처: "marketplace",
  수취인명: "recipient_name",
  상품명: "product_name",
  수량: "quantity",
  "수령자 번호": "recipient_phone",
  수령자번호: "recipient_phone",
  "주문자 번호": "orderer_phone",
  주문자번호: "orderer_phone",
  우편번호: "postal_code",
  주소: "address",
  배송메모: "delivery_memo",
  매출: "revenue",
  정산예정: "settlement",
  원가: "cost",
  마진: "margin",
  결제방식: "payment_method",
  구매처: "purchase_source",
  아이디: "purchase_id",
  주문번호: "purchase_order_no",
  택배사: "courier",
  운송장: "tracking_no",
};

// 택배사 목록
export const COURIERS = [
  "CJ대한통운",
  "한진택배",
  "롯데택배",
  "우체국택배",
  "로젠택배",
  "경동택배",
  "대신택배",
  "일양로지스",
  "합동택배",
];

// 배송상태 목록 및 색상
export const DELIVERY_STATUSES = [
  "결제전", "배송준비", "배송완료", "취소준비", "취소완료", "반품준비", "반품완료", "교환준비", "교환완료",
] as const;

export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

export const DELIVERY_STATUS_COLORS: Record<string, string> = {
  결제전: "bg-gray-500/20 text-gray-400",
  배송준비: "bg-blue-500/20 text-blue-400",
  배송완료: "bg-green-500/20 text-green-400",
  취소준비: "bg-red-500/20 text-red-400",
  취소완료: "bg-red-500/20 text-red-400",
  반품준비: "bg-orange-500/20 text-orange-400",
  반품완료: "bg-orange-500/20 text-orange-400",
  교환준비: "bg-purple-500/20 text-purple-400",
  교환완료: "bg-purple-500/20 text-purple-400",
};

// 상품 등록 상태
export const REGISTRATION_STATUSES = ["등록전", "등록완료", "판매중지"] as const;
export type RegistrationStatus = typeof REGISTRATION_STATUSES[number];

export const REGISTRATION_STATUS_COLORS: Record<string, string> = {
  등록전: "bg-gray-800 text-gray-200",
  등록완료: "bg-green-900 text-green-300",
  판매중지: "bg-red-900 text-red-300",
};

// 결제방식 목록
export const PAYMENT_METHODS = [
  "국민",
  "삼성",
  "신한",
  "현대",
  "롯데",
  "우리",
  "하나",
  "BC",
  "농협",
  "카카오페이",
  "네이버페이",
  "토스페이",
  "무통장입금",
];
