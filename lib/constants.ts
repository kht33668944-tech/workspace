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
