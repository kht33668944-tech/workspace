import bcrypt from "bcryptjs";
import {
  dryRunResult,
  extractMessage,
  fetchWithRetry,
  isDryRun,
  parseBody,
  sleep,
  type MarketplaceResult,
} from "@/lib/marketplace/common";

export const NAVER_COMMERCE_API_BASE_URL = "https://api.commerce.naver.com/external";

export interface NaverCommerceApiCredentials {
  clientId: string;
  clientSecret: string;
}

export type NaverApiResponse<T = unknown> = MarketplaceResult<T>;

// ───────── 응답 타입 (커머스API 문서·공식 디스커션 기준, 필요한 필드만) ─────────

export interface NaverChannel {
  channelNo: number;
  channelType: string;
  name: string;
  url?: string;
}

export interface NaverChannelProduct {
  originProductNo: number;
  channelProductNo: number;
  channelServiceType: string;
  name: string;
  sellerManagementCode?: string;
  statusType: string;
  salePrice: number;
  discountedPrice?: number;
  stockQuantity: number;
  regDate?: string;
  modifiedDate?: string;
}

export interface NaverProductSearchResponse {
  contents: Array<{ originProductNo: number; channelProducts: NaverChannelProduct[] }>;
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface NaverOptionCombination {
  id: number;
  optionName1?: string;
  optionName2?: string;
  optionName3?: string;
  optionName4?: string;
  stockQuantity: number;
  price: number;
  usable: boolean;
  sellerManagerCode?: string;
}

export interface NaverOriginProduct {
  statusType: string;
  saleType?: string;
  salePrice: number;
  stockQuantity: number;
  detailAttribute?: {
    optionInfo?: {
      optionCombinations?: NaverOptionCombination[];
      useStockManagement?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NaverOriginProductResponse {
  originProduct: NaverOriginProduct;
  smartstoreChannelProduct?: Record<string, unknown>;
  [key: string]: unknown;
}

export type NaverLastChangedType =
  | "PAYED"
  | "DISPATCHED"
  | "CLAIM_REQUESTED"
  | "CLAIM_COMPLETED"
  | "COLLECT_DONE"
  | "PURCHASE_DECIDED"
  | "DELIVERY_ADDRESS_CHANGED";

export interface NaverLastChangedStatus {
  productOrderId: string;
  orderId: string;
  productOrderStatus: string;
  lastChangedType: string;
  lastChangedDate: string;
  claimType?: string;
  claimStatus?: string;
}

export interface NaverProductOrderDetail {
  productOrder: {
    productOrderId: string;
    productOrderStatus: string;
    productName: string;
    productOption?: string;
    quantity: number;
    unitPrice?: number;
    totalPaymentAmount?: number;
    placeOrderStatus?: string;
    claimType?: string;
    claimStatus?: string;
    shippingAddress?: { name?: string; tel1?: string; baseAddress?: string; detailedAddress?: string };
    productId?: string;
    channelProductNo?: number;
    optionCode?: string;
    sellerProductCode?: string;
  };
  order: { orderId: string; ordererName?: string; orderDate?: string; paymentDate?: string };
  currentClaim?: { claimType?: string; claimStatus?: string; cancelReason?: string; requestQuantity?: number };
}

/** 판매자 취소 사유 코드 (판매자 귀책) */
export type NaverCancelReason = "SOLD_OUT" | "PRODUCT_UNSATISFIED" | "DELAYED_DELIVERY" | "MISTAKE_ORDER";

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCache>();

export class NaverCommerceApiClient {
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(credentials: NaverCommerceApiCredentials) {
    this.clientId = credentials.clientId;
    this.clientSecret = credentials.clientSecret;
  }

  /** OAuth2 client_credentials 토큰 — 프로세스 내 캐시, 만료 5분 전 재발급 */
  async getAccessToken(force = false): Promise<string> {
    const cached = tokenCache.get(this.clientId);
    if (!force && cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;

    const timestamp = Date.now();
    const hashed = bcrypt.hashSync(`${this.clientId}_${timestamp}`, this.clientSecret);
    const sign = Buffer.from(hashed).toString("base64");
    const body = new URLSearchParams({
      client_id: this.clientId,
      timestamp: String(timestamp),
      client_secret_sign: sign,
      grant_type: "client_credentials",
      type: "SELF",
    });

    const res = await fetchWithRetry(
      `${NAVER_COMMERCE_API_BASE_URL}/v1/oauth2/token`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
      { label: "naver token" },
    );
    const parsed = parseBody(await res.text()) as { access_token?: string; expires_in?: number; message?: string } | string | null;
    if (!res.ok || !parsed || typeof parsed === "string" || !parsed.access_token) {
      throw new Error(`네이버 커머스API 토큰 발급 실패 (${res.status}): ${extractMessage(parsed, "알 수 없는 오류")}`);
    }
    tokenCache.set(this.clientId, {
      token: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    });
    return parsed.access_token;
  }

  /**
   * 공통 요청. 쓰기(POST/PUT/PATCH/DELETE)는 DRY_RUN 이면 전송하지 않는다.
   * 401 은 토큰 재발급 후 1회 재시도, 429/5xx 는 fetchWithRetry 백오프.
   */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { query?: Record<string, string | number | undefined | null>; body?: unknown; write?: boolean } = {},
  ): Promise<NaverApiResponse<T>> {
    const isWrite = options.write ?? method !== "GET";
    if (isWrite && isDryRun()) {
      console.log(`[naver-api] DRY RUN ${method} ${path}`, options.body ? JSON.stringify(options.body).slice(0, 300) : "");
      return dryRunResult<T>();
    }

    const qs = options.query
      ? new URLSearchParams(
          Object.entries(options.query)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    const url = `${NAVER_COMMERCE_API_BASE_URL}${path}${qs ? `?${qs}` : ""}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getAccessToken(attempt > 0);
      let res: Response;
      try {
        res = await fetchWithRetry(
          url,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
          },
          { label: `naver ${method} ${path.split("/").slice(-2).join("/")}`, baseMs: 3000 },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, body: null, message: `네이버 API 네트워크 오류: ${message}` };
      }

      if (res.status === 401 && attempt === 0) {
        await sleep(500);
        continue;
      }

      const parsed = parseBody(await res.text());
      const ok = res.ok;
      const message = ok ? "성공" : extractMessage(parsed, `네이버 API 오류 (${res.status})`);
      return { ok, status: res.status, body: parsed as T | string | null, message };
    }
    return { ok: false, status: 401, body: null, message: "네이버 API 인증 실패" };
  }

  // ───────── 판매자/채널 ─────────

  getChannels() {
    return this.request<NaverChannel[]>("GET", "/v1/seller/channels");
  }

  // ───────── 상품 ─────────

  searchProducts(params: { page?: number; size?: number; productStatusTypes?: string[]; channelProductNos?: number[] } = {}) {
    return this.request<NaverProductSearchResponse>("POST", "/v1/products/search", {
      write: false,
      body: {
        page: params.page ?? 1,
        size: params.size ?? 100,
        productStatusTypes: params.productStatusTypes,
        channelProductNos: params.channelProductNos,
      },
    });
  }

  /** 전 페이지 순회 */
  async searchAllProducts(params: { productStatusTypes?: string[] } = {}) {
    const all: NaverChannelProduct[] = [];
    for (let page = 1; page <= 500; page++) {
      const res = await this.searchProducts({ ...params, page, size: 100 });
      if (!res.ok || !res.body || typeof res.body === "string") throw new Error(`네이버 상품 조회 실패: ${res.message}`);
      for (const c of res.body.contents ?? []) {
        for (const cp of c.channelProducts ?? []) all.push({ ...cp, originProductNo: cp.originProductNo ?? c.originProductNo });
      }
      if (page >= (res.body.totalPages ?? 1)) break;
      await sleep(600);
    }
    return all;
  }

  getOriginProduct(originProductNo: number | string) {
    return this.request<NaverOriginProductResponse>("GET", `/v2/products/origin-products/${originProductNo}`);
  }

  /** 원상품 전체 수정 — 부분 수정 불가하므로 GET → mutate → PUT 전체 바디 */
  async patchOriginProduct(
    originProductNo: number | string,
    mutate: (product: NaverOriginProductResponse) => NaverOriginProductResponse | void,
  ): Promise<NaverApiResponse> {
    const current = await this.getOriginProduct(originProductNo);
    if (!current.ok || !current.body || typeof current.body === "string") {
      return { ok: false, status: current.status, body: current.body, message: `원상품 조회 실패: ${current.message}` };
    }
    const draft = JSON.parse(JSON.stringify(current.body)) as NaverOriginProductResponse;
    const next = mutate(draft) ?? draft;
    return this.request("PUT", `/v2/products/origin-products/${originProductNo}`, { body: next });
  }

  changeProductStatus(originProductNo: number | string, statusType: "SALE" | "SUSPENSION" | "OUTOFSTOCK") {
    return this.request("PUT", `/v1/products/origin-products/${originProductNo}/change-status`, {
      body: { statusType },
    });
  }

  // ───────── 주문 ─────────

  /** 변경 상품주문 조회 — 24시간 구간, 최대 300건 */
  getLastChangedOrders(params: { lastChangedFrom: string; lastChangedTo?: string; lastChangedType?: NaverLastChangedType; moreSequence?: string }) {
    return this.request<{ data?: { lastChangeStatuses?: NaverLastChangedStatus[]; more?: { moreSequence?: string; moreFrom?: string } } }>(
      "GET",
      "/v1/pay-order/seller/product-orders/last-changed-statuses",
      {
        query: {
          lastChangedFrom: params.lastChangedFrom,
          lastChangedTo: params.lastChangedTo,
          lastChangedType: params.lastChangedType,
          moreSequence: params.moreSequence,
          limitCount: 300,
        },
      },
    );
  }

  queryProductOrders(productOrderIds: string[]) {
    return this.request<{ data?: NaverProductOrderDetail[] }>("POST", "/v1/pay-order/seller/product-orders/query", {
      write: false,
      body: { productOrderIds },
    });
  }

  /** 판매자 취소 요청 — 발주확인 여부와 무관하게 즉시 환불 진행(approve 불필요) */
  requestCancel(productOrderId: string, params: { cancelReason: NaverCancelReason; cancelDetailedReason?: string }) {
    return this.request("POST", `/v1/pay-order/seller/product-orders/${productOrderId}/claim/cancel/request`, {
      body: { cancelReason: params.cancelReason, cancelDetailedReason: params.cancelDetailedReason },
    });
  }

  /** 구매자 취소요청 승인 (발주확인 후 구매자가 요청한 건) */
  approveCancel(productOrderId: string) {
    return this.request("POST", `/v1/pay-order/seller/product-orders/${productOrderId}/claim/cancel/approve`);
  }
}

/** KST ISO 문자열 (네이버 lastChangedFrom 형식) */
export function toKstIso(date: Date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("Z", "+09:00");
}
