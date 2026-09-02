import crypto from "crypto";
import {
  dryRunResult,
  extractMessage,
  fetchWithRetry,
  isDryRun,
  parseBody,
  type MarketplaceResult,
} from "@/lib/marketplace/common";

export const COUPANG_API_BASE_URL = "https://api-gateway.coupang.com";

export interface CoupangApiCredentials {
  vendorId: string;
  accessKey: string;
  secretKey: string;
}

export type CoupangApiResponse<T = unknown> = MarketplaceResult<T>;

/** 발주서 상태 (v5 ordersheets) */
export type CoupangOrderStatus = "ACCEPT" | "INSTRUCT" | "DEPARTURE" | "DELIVERING" | "FINAL_DELIVERY" | "NONE_TRACKING";

export interface CoupangOrderItem {
  vendorItemId: number;
  vendorItemName: string;
  shippingCount: number;
  sequenceNo?: number;
  cancelCount?: number;
  holdCountForCancel?: number;
  salesPrice?: number;
  orderPrice?: number;
  discountPrice?: number;
  sellerProductId?: number;
  sellerProductName?: string;
  sellerProductItemName?: string;
  externalVendorSkuCode?: string;
  confirmDate?: string | null;
  estimatedShippingDate?: string;
  canceled?: boolean;
}

export interface CoupangOrderSheet {
  orderId: number;
  shipmentBoxId: number;
  status: CoupangOrderStatus | string;
  orderedAt: string;
  paidAt?: string;
  orderer: { name: string; email?: string; safeNumber?: string; ordererNumber?: string | null };
  receiver: { name: string; safeNumber?: string; receiverNumber?: string | null; addr1?: string; addr2?: string; postCode?: string };
  orderItems: CoupangOrderItem[];
  shippingPrice?: number;
  remotePrice?: number;
  parcelPrintMessage?: string;
  deliveryCompanyName?: string;
  invoiceNumber?: string;
}

export interface CoupangListResponse<T> {
  code: string | number;
  message: string;
  data: T[];
  nextToken?: string;
}

export interface CoupangReturnRequest {
  receiptId: number;
  orderId: number;
  receiptType: string;
  receiptStatus: string;
  cancelCountSum: number;
  returnItems: Array<{ vendorItemId: number; cancelCount: number; releaseStatus: string; sellerProductName?: string; vendorItemName?: string }>;
  createdAt?: string;
  cancelReason?: string;
  cancelReasonCategory1?: string;
  cancelReasonCategory2?: string;
  reasonCode?: string;
  reasonCodeText?: string;
  // 반품 신청인 — 반품 접수 시 쿠팡이 새로 발급한 안심번호(requesterPhoneNumber). 실번호는 보통 null (공식 문서)
  requesterName?: string;
  requesterPhoneNumber?: string;
  requesterRealPhoneNumber?: string | null;
  requesterAddress?: string;
  requesterAddressDetail?: string;
  requesterZipCode?: string;
}

export interface CoupangInvoiceDto {
  shipmentBoxId: number;
  orderId: number;
  vendorItemId: number;
  deliveryCompanyCode: string;
  invoiceNumber: string;
  splitShipping?: boolean;
  preSplitShipped?: boolean;
  estimatedShippingDate?: string;
}

export interface CoupangInvoiceResponse {
  code: string | number;
  message: string;
  data?: {
    responseCode?: number;
    responseMessage?: string;
    responseList?: Array<{ shipmentBoxId: number; succeed: boolean; resultCode?: string; resultMessage?: string; retryRequired?: boolean }>;
  };
}

export type CoupangExchangeStatus = "RECEIPT" | "PROGRESS" | "SUCCESS" | "REJECT" | "CANCEL";

export interface CoupangExchangeRequest {
  exchangeId: number;
  orderId: number;
  exchangeStatus: CoupangExchangeStatus | string;
  receiptStatus?: string;
  createdAt?: string;
  reasonCode?: string;
  reasonCodeText?: string;
  reason?: string;
  exchangeItemDtoV1s?: Array<{ vendorItemId: number; quantity: number; originalShipmentBoxId?: number; targetShipmentBoxId?: number; vendorItemName?: string }>;
  returnDeliveryDtos?: Array<{ deliveryCompanyCode?: string; deliveryInvoiceNo?: string }>;
  deliveryInvoiceGroupDtos?: Array<{ shipmentBoxId?: number; deliveryCompanyCode?: string; invoiceNumber?: string }>;
  // 교환 재배송지 — deliveryMobile 은 2024-09-02부터 안심번호 (쿠팡 공지 "교환요청 목록 조회 API의 안심번호 제공 안내")
  exchangeAddressDtoV1?: {
    deliveryName?: string;
    deliveryPhone?: string;
    deliveryMobile?: string;
    deliveryZipCode?: string;
    deliveryAddress?: string;
    deliveryAddressDetail?: string;
    [key: string]: unknown;
  };
}

/** 쿠팡 판매자 취소 중분류 코드 (대분류는 항상 CANERR) */
export type CoupangMiddleCancelCode = "CCTTER" | "CCPNER" | "CCPRER";

function getSignedDate() {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${yy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function buildQuery(params?: Record<string, string | number | boolean | undefined | null>) {
  if (!params) return "";
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  return new URLSearchParams(entries).toString();
}

const ORDER_API = "/v2/providers/openapi/apis/api";

/** yyyy-MM-dd → yyyy-MM-ddTHH:mm (이미 시각이 있으면 그대로) */
function toMinuteFormat(date: string, time: string) {
  return date.includes("T") ? date : `${date}T${time}`;
}
const ITEM_API = "/v2/providers/seller_api/apis/api/v1/marketplace";

export class CoupangOpenApiClient {
  readonly vendorId: string;
  private readonly accessKey: string;
  private readonly secretKey: string;

  constructor(credentials: CoupangApiCredentials) {
    this.vendorId = credentials.vendorId;
    this.accessKey = credentials.accessKey;
    this.secretKey = credentials.secretKey;
  }

  private authorization(method: string, path: string, query: string) {
    const signedDate = getSignedDate();
    const message = signedDate + method.toUpperCase() + path + query;
    const signature = crypto.createHmac("sha256", this.secretKey).update(message).digest("hex");
    return `CEA algorithm=HmacSHA256, access-key=${this.accessKey}, signed-date=${signedDate}, signature=${signature}`;
  }

  /**
   * 공통 요청. 쓰기(PUT/POST/PATCH/DELETE)는 DRY_RUN 이면 전송하지 않는다.
   * 429/5xx 는 지수 백오프로 최대 3회 재시도.
   */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    queryParams?: Record<string, string | number | boolean | undefined | null>,
    body?: unknown,
  ): Promise<CoupangApiResponse<T>> {
    if (method !== "GET" && isDryRun()) {
      console.log(`[coupang-api] DRY RUN ${method} ${path}`, body ? JSON.stringify(body).slice(0, 300) : "");
      return dryRunResult<T>();
    }

    const query = buildQuery(queryParams);
    const url = `${COUPANG_API_BASE_URL}${path}${query ? `?${query}` : ""}`;

    let res: Response;
    try {
      res = await fetchWithRetry(
        url,
        {
          method,
          headers: {
            // 서명은 재시도마다 새로 계산해야 하므로 fetchWithRetry 밖에서 만들면 안 되지만,
            // 쿠팡 signed-date 허용 오차가 수분 단위라 동일 서명 재사용으로 충분하다.
            Authorization: this.authorization(method, path, query),
            "Content-Type": "application/json;charset=UTF-8",
            "X-Requested-By": this.vendorId,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { label: `coupang ${method} ${path.split("/").slice(-2).join("/")}` },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, body: null, message: `쿠팡 API 네트워크 오류: ${message}` };
    }

    const parsed = parseBody(await res.text());
    const bodyCode = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).code : null;
    const codeFailed =
      (typeof bodyCode === "string" && bodyCode !== "SUCCESS" && bodyCode !== "200") ||
      (typeof bodyCode === "number" && bodyCode !== 200);
    const ok = res.ok && !codeFailed;
    const message = ok ? "성공" : extractMessage(parsed, `쿠팡 API 오류 (${res.status})`);

    return { ok, status: res.status, body: parsed as T | string | null, message };
  }

  // ───────── 상품 ─────────

  testConnection() {
    return this.request("GET", `${ITEM_API}/seller-products`, { vendorId: this.vendorId, maxPerPage: 1 });
  }

  changePrice(vendorItemId: string, price: number) {
    return this.request("PUT", `${ITEM_API}/vendor-items/${encodeURIComponent(vendorItemId)}/prices/${price}`, {
      forceSalePriceUpdate: true,
    });
  }

  changeQuantity(vendorItemId: string, quantity: number) {
    return this.request("PUT", `${ITEM_API}/vendor-items/${encodeURIComponent(vendorItemId)}/quantities/${quantity}`);
  }

  stopSale(vendorItemId: string) {
    return this.request("PUT", `${ITEM_API}/vendor-items/${encodeURIComponent(vendorItemId)}/sales/stop`);
  }

  resumeSale(vendorItemId: string) {
    return this.request("PUT", `${ITEM_API}/vendor-items/${encodeURIComponent(vendorItemId)}/sales/resume`);
  }

  // ───────── 주문 ─────────

  /** 발주서 목록 (v4, 일 단위 yyyy-MM-dd, 최대 31일). v5는 날짜 형식이 달라(yyyy-MM-dd+0X:00) v4 유지. */
  listOrderSheets(params: {
    createdAtFrom: string; // yyyy-MM-dd
    createdAtTo: string;
    status: CoupangOrderStatus;
    nextToken?: string;
    maxPerPage?: number;
  }) {
    return this.request<CoupangListResponse<CoupangOrderSheet>>(
      "GET",
      `${ORDER_API}/v4/vendors/${this.vendorId}/ordersheets`,
      {
        createdAtFrom: params.createdAtFrom,
        createdAtTo: params.createdAtTo,
        status: params.status,
        nextToken: params.nextToken || undefined,
        maxPerPage: params.maxPerPage ?? 50,
      },
    );
  }

  /** 상태별 발주서를 전 페이지 수집 */
  async listAllOrderSheets(params: { createdAtFrom: string; createdAtTo: string; status: CoupangOrderStatus }) {
    const all: CoupangOrderSheet[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < 200; page++) {
      const res = await this.listOrderSheets({ ...params, nextToken });
      if (!res.ok || !res.body || typeof res.body === "string") {
        throw new Error(`쿠팡 발주서 조회 실패(${params.status}): ${res.message}`);
      }
      all.push(...(res.body.data ?? []));
      nextToken = res.body.nextToken || undefined;
      if (!nextToken) break;
    }
    return all;
  }

  /** 발주확인(상품준비중 처리) — 결제완료(ACCEPT) 박스만 가능 */
  acknowledgeOrderSheets(shipmentBoxIds: number[]) {
    return this.request<{ code: string | number; message: string; data?: { responseCode?: number; responseMessage?: string; responseList?: Array<{ shipmentBoxId: number; succeed: boolean; resultCode?: string; resultMessage?: string }> } }>(
      "PATCH",
      `${ORDER_API}/v4/vendors/${this.vendorId}/ordersheets/acknowledgement`,
      undefined,
      { vendorId: this.vendorId, shipmentBoxIds },
    );
  }

  /**
   * 판매자 주문 취소. 결제완료(ACCEPT)는 즉시 취소, 상품준비중(INSTRUCT)은 출고중지요청 생성.
   * 판매자 귀책으로 기록되어 배송준수율에 반영된다.
   */
  cancelOrder(params: {
    orderId: number;
    vendorItemIds: number[];
    receiptCounts: number[];
    middleCancelCode?: CoupangMiddleCancelCode;
    userId: string; // WING 로그인 ID
  }) {
    return this.request<{ code: string; message: string; data: { receiptMap?: Record<string, unknown>; failedVendorItemIds?: number[] } }>(
      "POST",
      `${ORDER_API}/v5/vendors/${this.vendorId}/orders/${params.orderId}/cancel`,
      undefined,
      {
        orderId: params.orderId,
        vendorItemIds: params.vendorItemIds,
        receiptCounts: params.receiptCounts,
        bigCancelCode: "CANERR",
        middleCancelCode: params.middleCancelCode ?? "CCTTER",
        userId: params.userId,
        vendorId: this.vendorId,
      },
    );
  }

  /** 출고중지요청(RU) 목록 — 취소 접수건. timeFrame 검색은 yyyy-MM-ddTHH:mm 형식 필수 */
  listReturnRequests(params: {
    createdAtFrom: string; // yyyy-MM-dd
    createdAtTo: string;
    status?: "RU" | "UC" | "CC" | "PR";
    cancelType?: "RETURN" | "CANCEL";
    nextToken?: string;
    maxPerPage?: number;
  }) {
    return this.request<CoupangListResponse<CoupangReturnRequest>>(
      "GET",
      `${ORDER_API}/v6/vendors/${this.vendorId}/returnRequests`,
      {
        searchType: "timeFrame",
        createdAtFrom: toMinuteFormat(params.createdAtFrom, "00:00"),
        createdAtTo: toMinuteFormat(params.createdAtTo, "23:59"),
        status: params.status,
        cancelType: params.cancelType,
        nextToken: params.nextToken || undefined,
        maxPerPage: params.maxPerPage ?? 50,
      },
    );
  }

  /** 출고중지완료 처리 — 상품준비중 취소건의 환불 확정 단계 */
  stopShipment(receiptId: number, cancelCount: number) {
    return this.request(
      "PUT",
      `${ORDER_API}/v4/vendors/${this.vendorId}/returnRequests/${receiptId}/stoppedShipment`,
      undefined,
      { vendorId: this.vendorId, receiptId, cancelCount },
    );
  }

  // ───────── 송장 (발송처리) ─────────

  /** 송장 업로드 — 상품준비중(INSTRUCT) 박스만 가능. 응답 responseList 로 박스별 성공 여부 확인 */
  uploadInvoices(dtos: CoupangInvoiceDto[]) {
    return this.request<CoupangInvoiceResponse>(
      "POST",
      `${ORDER_API}/v4/vendors/${this.vendorId}/orders/invoices`,
      undefined,
      { vendorId: this.vendorId, orderSheetInvoiceApplyDtos: dtos.map((d) => ({ splitShipping: false, preSplitShipped: false, ...d })) },
    );
  }

  /** 송장 수정 — 이미 업로드한 송장을 다른 택배사/번호로 교체 */
  updateInvoices(dtos: CoupangInvoiceDto[]) {
    return this.request<CoupangInvoiceResponse>(
      "POST",
      `${ORDER_API}/v4/vendors/${this.vendorId}/orders/updateInvoices`,
      undefined,
      { vendorId: this.vendorId, orderSheetInvoiceApplyDtos: dtos.map((d) => ({ splitShipping: false, preSplitShipped: false, ...d })) },
    );
  }

  /** 이미출고 처리 — 출고중지요청(RELEASE_STOP_UNCHECKED)을 거절하고 송장을 등록 (= 취소요청 거절) */
  completeShipment(receiptId: number, deliveryCompanyCode: string, invoiceNumber: string) {
    return this.request<{ data?: { resultCode?: string; resultMessage?: string } }>(
      "PATCH",
      `${ORDER_API}/v4/vendors/${this.vendorId}/returnRequests/${receiptId}/completedShipment`,
      undefined,
      { vendorId: this.vendorId, receiptId, deliveryCompanyCode, invoiceNumber },
    );
  }

  // ───────── 반품 ─────────

  /** 반품상품 입고 확인 — receiptStatus RETURNS_UNCHECKED 건 */
  confirmReturnReceipt(receiptId: number) {
    return this.request(
      "PATCH",
      `${ORDER_API}/v4/vendors/${this.vendorId}/returnRequests/${receiptId}/receiveConfirmation`,
      undefined,
      { vendorId: this.vendorId, receiptId },
    );
  }

  /** 반품요청 승인(환불) — 입고확인(VENDOR_WAREHOUSE_CONFIRM) 후. cancelCount 는 접수 수량과 같아야 함 */
  approveReturn(receiptId: number, cancelCount: number) {
    return this.request(
      "PATCH",
      `${ORDER_API}/v4/vendors/${this.vendorId}/returnRequests/${receiptId}/approval`,
      undefined,
      { vendorId: this.vendorId, receiptId, cancelCount },
    );
  }

  // ───────── 교환 ─────────

  /** 교환요청 목록 — createdAt yyyy-MM-ddTHH:mm:ss, 최대 7일 */
  listExchangeRequests(params: { createdAtFrom: string; createdAtTo: string; status?: CoupangExchangeStatus; orderId?: number; nextToken?: string; maxPerPage?: number }) {
    return this.request<CoupangListResponse<CoupangExchangeRequest>>(
      "GET",
      `${ORDER_API}/v4/vendors/${this.vendorId}/exchangeRequests`,
      {
        createdAtFrom: params.createdAtFrom.length === 10 ? `${params.createdAtFrom}T00:00:00` : params.createdAtFrom,
        createdAtTo: params.createdAtTo.length === 10 ? `${params.createdAtTo}T23:59:59` : params.createdAtTo,
        status: params.status,
        orderId: params.orderId,
        nextToken: params.nextToken || undefined,
        maxPerPage: params.maxPerPage ?? 50,
      },
    );
  }

  /** 교환요청 상품 입고 확인 */
  confirmExchangeReceipt(exchangeId: number) {
    return this.request(
      "PATCH",
      `${ORDER_API}/v4/vendors/${this.vendorId}/exchangeRequests/${exchangeId}/receiveConfirmation`,
      undefined,
      { vendorId: this.vendorId, exchangeId },
    );
  }

  /** 교환요청 거부 — SOLDOUT(품절) | WITHDRAW(고객 철회) */
  rejectExchange(exchangeId: number, exchangeRejectCode: "SOLDOUT" | "WITHDRAW") {
    return this.request<{ data?: { resultCode?: string; resultMessage?: string } }>(
      "PATCH",
      `${ORDER_API}/v4/vendors/${this.vendorId}/exchangeRequests/${exchangeId}/rejection`,
      undefined,
      { vendorId: this.vendorId, exchangeId, exchangeRejectCode },
    );
  }

  /** 교환상품(재배송) 송장 업로드 */
  uploadExchangeInvoice(exchangeId: number, params: { shipmentBoxId: number; goodsDeliveryCode: string; invoiceNumber: string }) {
    return this.request<{ data?: { resultCode?: string; resultMessage?: string } }>(
      "POST",
      `${ORDER_API}/v4/vendors/${this.vendorId}/exchangeRequests/${exchangeId}/invoices`,
      undefined,
      { vendorId: this.vendorId, exchangeId, ...params },
    );
  }

  // ───────── 정산 ─────────

  /** 매출내역(구매확정 기준 매출 인식) — 최대 31일, 페이지 50건 */
  listRevenueHistory(params: { recognitionDateFrom: string; recognitionDateTo: string; token?: string; maxPerPage?: number }) {
    return this.request<CoupangRevenueHistoryResponse>(
      "GET",
      `${ORDER_API}/v1/revenue-history`,
      {
        vendorId: this.vendorId,
        recognitionDateFrom: params.recognitionDateFrom,
        recognitionDateTo: params.recognitionDateTo,
        token: params.token ?? "",
        maxPerPage: params.maxPerPage ?? 50,
      },
    );
  }

  // ───────── 고객 문의(CS) ─────────

  /** 상품문의(고객문의) 조회 — 최대 7일, pageSize≤50 */
  listOnlineInquiries(params: {
    inquiryStartAt: string; // yyyy-MM-dd
    inquiryEndAt: string;
    answeredType?: "ALL" | "ANSWERED" | "NOANSWER";
    pageNum?: number;
    pageSize?: number;
  }) {
    return this.request<CoupangInquiryPagedResponse<CoupangOnlineInquiry>>(
      "GET",
      `${ORDER_API}/v5/vendors/${this.vendorId}/onlineInquiries`,
      {
        vendorId: this.vendorId,
        answeredType: params.answeredType ?? "ALL",
        inquiryStartAt: params.inquiryStartAt,
        inquiryEndAt: params.inquiryEndAt,
        pageNum: params.pageNum ?? 1,
        pageSize: params.pageSize ?? 50,
      },
    );
  }

  /** 상품문의 답변 — replyBy 는 쿠팡윙 로그인 ID. 이미 답변된 문의에 다시 보내면 400 */
  replyOnlineInquiry(params: { inquiryId: number | string; content: string; replyBy: string }) {
    return this.request<{ code: string | number; message: string }>(
      "POST",
      `${ORDER_API}/v4/vendors/${this.vendorId}/onlineInquiries/${params.inquiryId}/replies`,
      undefined,
      { content: params.content, vendorId: this.vendorId, replyBy: params.replyBy },
    );
  }

  /** 고객센터문의 조회 — 최대 7일, pageSize≤30 */
  listCallCenterInquiries(params: {
    inquiryStartAt: string; // yyyy-MM-dd
    inquiryEndAt: string;
    partnerCounselingStatus?: "NONE" | "ANSWER" | "NO_ANSWER" | "TRANSFER";
    pageNum?: number;
    pageSize?: number;
  }) {
    return this.request<CoupangInquiryPagedResponse<CoupangCallCenterInquiry>>(
      "GET",
      `${ORDER_API}/v5/vendors/${this.vendorId}/callCenterInquiries`,
      {
        vendorId: this.vendorId,
        partnerCounselingStatus: params.partnerCounselingStatus ?? "NONE",
        inquiryStartAt: params.inquiryStartAt,
        inquiryEndAt: params.inquiryEndAt,
        pageNum: params.pageNum ?? 1,
        pageSize: params.pageSize ?? 30,
      },
    );
  }

  /** 고객센터문의 답변 — content 2~1000자, 미답변(progress + requestAnswer) 상태에서만 가능 */
  replyCallCenterInquiry(params: { inquiryId: number | string; content: string; replyBy: string; parentAnswerId: number }) {
    return this.request<{ code: string | number; message: string }>(
      "POST",
      `${ORDER_API}/v4/vendors/${this.vendorId}/callCenterInquiries/${params.inquiryId}/replies`,
      undefined,
      {
        inquiryId: String(params.inquiryId),
        content: params.content,
        vendorId: this.vendorId,
        replyBy: params.replyBy,
        parentAnswerId: params.parentAnswerId,
      },
    );
  }

  /** 고객센터문의 확인 처리 — 답변 없이 확인만 남길 때 */
  confirmCallCenterInquiry(inquiryId: number | string) {
    return this.request<{ code: string | number; message: string }>(
      "POST",
      `${ORDER_API}/v4/vendors/${this.vendorId}/callCenterInquiries/${inquiryId}/confirms`,
      undefined,
      { vendorId: this.vendorId, inquiryId: String(inquiryId) },
    );
  }
}

// ─── 고객 문의(CS) 타입 ───

export interface CoupangInquiryComment {
  inquiryCommentId: number;
  content: string;
  inquiryCommentAt?: string;
  [key: string]: unknown;
}

export interface CoupangOnlineInquiry {
  inquiryId: number;
  productId?: number;
  sellerProductId?: number;
  sellerItemId?: number;
  vendorItemId?: number;
  content: string;
  inquiryAt: string;
  orderIds?: Array<number | string>;
  buyerEmail?: string;
  commentDtoList?: CoupangInquiryComment[];
  [key: string]: unknown;
}

/** 고객센터문의 답변/이관글 1건 (실측: replies[]) — needAnswer=true 인 행의 answerId 가 답변 시 parentAnswerId */
export interface CoupangCallCenterReply {
  answerId?: number;
  parentAnswerId?: number | null;
  content?: string;
  replyAt?: string;
  receptionistName?: string;
  receptionist?: string | null;
  partnerTransferStatus?: string; // requestAnswer | answered
  answerType?: string; // csAgent | vendor
  needAnswer?: boolean;
  [key: string]: unknown;
}

/** 고객센터문의 — 답변 조건(inquiryStatus/partnerTransferStatus) 판정용 필드는 raw 보존 후 방어적으로 추출 */
export interface CoupangCallCenterInquiry {
  inquiryId: number;
  inquiryStatus?: string; // progress | complete
  csPartnerCounselingStatus?: string; // requestAnswer | answered
  vendorItemId?: number | number[];
  itemName?: string;
  content?: string;
  inquiryAt?: string;
  answeredAt?: string;
  orderId?: number;
  buyerPhone?: string;
  replies?: CoupangCallCenterReply[];
  [key: string]: unknown;
}

export interface CoupangInquiryPagedResponse<T> {
  code: string | number;
  message: string;
  data?: {
    content?: T[];
    pagination?: { currentPage?: number; totalPages?: number; totalElements?: number; countPerPage?: number };
  };
}

export interface CoupangRevenueItem {
  productId?: number;
  productName?: string;
  vendorItemId: number;
  vendorItemName?: string;
  salePrice?: number;
  quantity: number;
  saleAmount?: number;
  serviceFee?: number;
  serviceFeeVat?: number;
  serviceFeeRatio?: number;
  settlementAmount: number;
  coupangDiscountCoupon?: number;
  sellerDiscountCoupon?: number;
  externalSellerSkuCode?: string;
}

/** 매출내역 1행 = 주문 1건(saleType별), items 에 옵션별 정산액 */
export interface CoupangRevenueOrder {
  orderId: number;
  saleType: "SALE" | "REFUND" | string;
  saleDate?: string;
  recognitionDate?: string;
  settlementDate?: string;
  finalSettlementDate?: string;
  deliveryFee?: { amount?: number; settlementAmount?: number };
  items: CoupangRevenueItem[];
}

export interface CoupangRevenueHistoryResponse {
  code: string | number;
  message: string;
  data?: CoupangRevenueOrder[];
  nextToken?: string;
  hasNext?: boolean;
}

export function roundCoupangPrice(price: number) {
  return Math.ceil(price / 10) * 10;
}
