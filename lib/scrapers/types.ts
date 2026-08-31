// 스크래퍼 공통 타입 (지마켓, 옥션 등 확장 가능)

export interface TrackingInfo {
  orderNo: string;
  courier: string;
  trackingNo: string;
  status: string;
  itemName?: string;
}

export interface ScrapeResult {
  success: TrackingInfo[];
  failed: { orderNo: string; reason: string }[];
  notFound: string[];
}

export interface CollectTrackingRequest {
  platform: "gmarket" | "auction" | "ohouse";
  loginId: string;
  loginPw: string;
  orderNos: string[];
}

export interface BulkUpdateTrackingRequest {
  updates: {
    purchase_order_no: string;
    courier: string;
    tracking_no: string;
  }[];
}

// 구매처 주문상세 페이지 URL — 자동구매 완료 시 발주서에 저장해 반품/문의 때 바로 진입한다.
// 새 구매처(옥션, 11번가 등) 자동구매를 붙일 때 여기에 패턴만 추가하면 된다.
// 지마켓 상세페이지는 주문번호(orderNo)가 아니라 결제번호(payNo) 기준 — orderNo로 만들면 에러 페이지로 이동한다
export function purchaseDetailUrl(platform: string, orderNo: string, payNo?: string): string | null {
  switch (platform) {
    case "gmarket": return payNo ? `https://my.gmarket.co.kr/ko/pc/detail/basic/${payNo}` : null;
    case "ohouse": return orderNo ? `https://ohou.se/orders/${orderNo}` : null;
    default: return null;
  }
}

// 상세주소 특수문자 정리: 한글/영문/숫자/공백/하이픈만 남기고 나머지(·, /, 괄호 등)는 공백 치환
// 일부 마켓 배송지 폼이 특수문자가 포함된 상세주소 저장을 거부한다
export function sanitizeAddressDetail(detail: string): string {
  return detail
    .replace(/[^가-힣a-zA-Z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 자동구매 관련 타입
export interface PurchaseOrderInfo {
  orderId: string;        // DB id
  productUrl: string;     // 최저가링크 (purchase_url)
  recipientName: string;  // 수취인명
  postalCode: string;     // 우편번호
  address: string;        // 기본주소
  addressDetail: string;  // 상세주소
  recipientPhone: string; // 수취인 연락처
  deliveryMemo: string;   // 배송메모
  quantity: number;       // 수량
  productName?: string;   // 상품명 (구매 로그 기록용)
  optionName?: string;    // 옵션명 (옵션선택 드롭다운이 있는 상품용; 미지정 시 첫 번째 옵션 선택)
  maxPaymentPerUnit?: number; // 회당 결제 한도(원) = 정산예정÷수량 + 허용적자. 미지정 시 최종 결제금액 검사 생략
}

export interface PurchaseResult {
  success: { orderId: string; purchaseOrderNo: string; cost?: number; paymentMethod?: string; payNo?: string }[];
  failed: { orderId: string; reason: string; purchaseOrderNo?: string; cost?: number; paymentMethod?: string; payNo?: string }[];
}

export interface AutoPurchaseRequest {
  platform: "gmarket" | "auction" | "ohouse";
  loginId: string;
  loginPw: string;
  paymentPin?: string;    // 결제 비밀번호 (6자리, 지마켓용)
  orders: PurchaseOrderInfo[];
}

// 지마켓 API 응답 타입
export interface GmarketOrderResponse {
  code: string;
  data: {
    pageNo: number;
    pageSize: number;
    totalCount: number;
    payBundleList: GmarketPayBundle[];
  };
}

export interface GmarketPayBundle {
  payNo: number;
  payDate: string;
  orderList: GmarketOrder[];
}

export interface GmarketOrder {
  orderNo: number;
  displayOrderStatusName: string;
  orderQuantity: number;
  orderDelivery: {
    hasDelivery: boolean;
    invoiceNo: string;
    deliveryCompleteDate: string | null;
  };
  orderItem: {
    itemNo: string;
    itemName: string;
  };
}

export interface GmarketTrackingData {
  shippingInfo: {
    invoiceNo: string;
    shippingStatus: string;
    receiverName: string;
    shippingAddress: string;
    isShippingFinished: boolean;
  };
  shippingCompanyInfo: {
    deliveryCompCode: number;
    deliveryCompName: string;
  };
}
