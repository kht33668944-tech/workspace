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
}

export interface PurchaseResult {
  success: { orderId: string; purchaseOrderNo: string; cost?: number; paymentMethod?: string }[];
  failed: { orderId: string; reason: string }[];
}

export interface AutoPurchaseRequest {
  platform: "gmarket" | "auction";
  loginId: string;
  loginPw: string;
  paymentPin: string;     // 결제 비밀번호 (6자리)
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
