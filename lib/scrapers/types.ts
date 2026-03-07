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
  platform: "gmarket" | "auction";
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
