import crypto from "crypto";

export const COUPANG_API_BASE_URL = "https://api-gateway.coupang.com";

export interface CoupangApiCredentials {
  vendorId: string;
  accessKey: string;
  secretKey: string;
}

export interface CoupangApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T | string | null;
  message: string;
}

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

function extractMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const obj = body as Record<string, unknown>;
  const message = obj.message ?? obj.msg ?? obj.errorMessage ?? obj.error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export class CoupangOpenApiClient {
  private readonly vendorId: string;
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
    const signature = crypto
      .createHmac("sha256", this.secretKey)
      .update(message)
      .digest("hex");

    return `CEA algorithm=HmacSHA256, access-key=${this.accessKey}, signed-date=${signedDate}, signature=${signature}`;
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    queryParams?: Record<string, string | number | boolean | undefined | null>,
    body?: unknown,
  ): Promise<CoupangApiResponse<T>> {
    const query = buildQuery(queryParams);
    const url = `${COUPANG_API_BASE_URL}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      Authorization: this.authorization(method, path, query),
      "Content-Type": "application/json;charset=UTF-8",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    const bodyCode = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).code : null;
    const codeFailed = typeof bodyCode === "string" && bodyCode !== "SUCCESS" && bodyCode !== "200";
    const ok = res.ok && !codeFailed;
    const message = ok ? "성공" : extractMessage(parsed, `쿠팡 API 오류 (${res.status})`);

    return {
      ok,
      status: res.status,
      body: parsed as T | string | null,
      message,
    };
  }

  testConnection() {
    return this.request("GET", "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products", {
      vendorId: this.vendorId,
      maxPerPage: 1,
    });
  }

  changePrice(vendorItemId: string, price: number) {
    return this.request(
      "PUT",
      `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(vendorItemId)}/prices/${price}`,
      { forceSalePriceUpdate: true },
    );
  }

  changeQuantity(vendorItemId: string, quantity: number) {
    return this.request(
      "PUT",
      `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(vendorItemId)}/quantities/${quantity}`,
    );
  }

  stopSale(vendorItemId: string) {
    return this.request(
      "PUT",
      `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(vendorItemId)}/sales/stop`,
    );
  }

  resumeSale(vendorItemId: string) {
    return this.request(
      "PUT",
      `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(vendorItemId)}/sales/resume`,
    );
  }
}

export function roundCoupangPrice(price: number) {
  return Math.ceil(price / 10) * 10;
}
