// 마켓 공식 API 연동 공용 유틸 (쿠팡·스마트스토어 클라이언트가 함께 사용)

export interface MarketplaceResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | string | null;
  message: string;
  /** MARKETPLACE_API_DRY_RUN=true 로 실제 호출을 생략한 결과 */
  dryRun?: boolean;
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 마켓 쓰기 작업(가격/재고/취소 등)을 실제로 보내지 않고 성공으로 간주한다. */
export function isDryRun() {
  return process.env.MARKETPLACE_API_DRY_RUN === "true";
}

export function dryRunResult<T = unknown>(message = "DRY RUN — 실제 전송하지 않음"): MarketplaceResult<T> {
  return { ok: true, status: 200, body: null, message, dryRun: true };
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  /** true를 반환하면 재시도 */
  shouldRetry?: (res: Response | null, err: unknown) => boolean;
  label?: string;
}

/**
 * fetch 재시도 — 429/5xx/네트워크 오류에 지수 백오프.
 * 최종 시도까지 실패하면 마지막 Response 또는 예외를 그대로 넘긴다.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
  timeoutMs = 20000,
): Promise<Response> {
  const retries = options.retries ?? 3;
  const baseMs = options.baseMs ?? 1000;
  const shouldRetry =
    options.shouldRetry ??
    ((res: Response | null, err: unknown) => {
      if (err) return true;
      if (!res) return false;
      return res.status === 429 || res.status >= 500;
    });

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      if (attempt < retries && shouldRetry(res, null)) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseMs * 2 ** attempt;
        console.warn(`[marketplace-api] ${options.label ?? url} ${res.status} → ${wait}ms 후 재시도 (${attempt + 1}/${retries})`);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(null, err)) throw err;
      const wait = baseMs * 2 ** attempt;
      console.warn(`[marketplace-api] ${options.label ?? url} 네트워크 오류 → ${wait}ms 후 재시도 (${attempt + 1}/${retries}):`, err instanceof Error ? err.message : String(err));
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const obj = body as Record<string, unknown>;
  const message = obj.message ?? obj.msg ?? obj.errorMessage ?? obj.error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/**
 * 상품명 매칭 키 — NFC 정규화 후 한글·영숫자·'.'만 남기고 소문자화.
 * (import-platform-codes 의 normalizeProductKey 와 동일 규칙)
 */
export function normalizeProductKey(name: string) {
  return name
    .normalize("NFC")
    .replace(/[^가-힣㄰-㆏a-zA-Z0-9.]+/g, "")
    .toLowerCase();
}

/** 수취인명 매칭 키 — 공백·괄호 제거 */
export function normalizeNameKey(name: string | null | undefined) {
  return (name ?? "").normalize("NFC").replace(/\s+/g, "").replace(/[()（）]/g, "").toLowerCase();
}
