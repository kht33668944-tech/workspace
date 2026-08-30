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
}

export interface CoupangOrderSheet {
  orderId: number;
  shipmentBoxId: number;
  status: CoupangOrderStatus | string;
  orderedAt: string;
  paidAt?: string;
  orderer: { name: string; email?: string; safeNumber?: string };
  receiver: { name: string; safeNumber?: string; addr1?: string; addr2?: string; postCode?: string };
  orderItems: CoupangOrderItem[];
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
  returnItems: Array<{ vendorItemId: number; cancelCount: number; releaseStatus: string }>;
  createdAt?: string;
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
}

export function roundCoupangPrice(price: number) {
  return Math.ceil(price / 10) * 10;
}
