import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getServiceSupabaseClient, getSupabaseClient } from "@/lib/api-helpers";
import { GmarketBrowserFetchClient } from "@/lib/scrapers/browser-fetch-client";
import { harvestGmarketCookies, type CookieCache } from "@/lib/scrapers/gmarket-session";
import { parseGmarketPrice, toGmarketPriceResult } from "@/lib/gmarket-price-parser";

export const maxDuration = 300;

type FailReason = "bot_blocked" | "sold_out" | "parse_failed" | "network_error" | "service_error" | "unsupported" | null;

type ProductRow = {
  id: string;
  product_name: string;
  purchase_url: string;
  lowest_price: number;
};

type ScraperResult = {
  id: string;
  url?: string;
  price: number;
  bot_blocked: boolean;
  fail_reason: FailReason;
  status_code?: number | null;
};

type ScraperResponse = {
  results?: ScraperResult[];
};

type SSEEvent =
  | { type: "progress"; id: string; name: string; price: number; previous_price: number; index: number; total: number; bot_blocked: boolean; fail_reason: FailReason }
  | { type: "init"; message: string }
  | { type: "done"; updated: number; failed: number; unchanged: number; bot_blocked: number; sold_out: number; skipped: number }
  | { type: "error"; message: string };

const SCRAPER_BATCH_SIZE = 10;

async function loadProducts(productIds: string[] | undefined, userId: string): Promise<ProductRow[]> {
  const sb = getServiceSupabaseClient();
  const products: ProductRow[] = [];

  if (productIds?.length) {
    const CHUNK = 200;
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const chunk = productIds.slice(i, i + CHUNK);
      const { data, error } = await sb
        .from("products")
        .select("id, product_name, purchase_url, lowest_price")
        .eq("user_id", userId)
        .gt("purchase_url", "")
        .in("id", chunk)
        .order("sort_order", { ascending: true });
      if (error) throw new Error(`상품 조회 실패: ${error.message}`);
      if (data) products.push(...(data as ProductRow[]));
    }
    return products;
  }

  const { data, error } = await sb
    .from("products")
    .select("id, product_name, purchase_url, lowest_price")
    .eq("user_id", userId)
    .gt("purchase_url", "")
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`상품 조회 실패: ${error.message}`);
  return (data ?? []) as ProductRow[];
}

function isLocalScraperUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(baseUrl);
}

function shouldSendGmarketSession(baseUrl: string): boolean {
  return process.env.SCRAPER_V3_SEND_COOKIES === "true" || isLocalScraperUrl(baseUrl);
}

function shouldUseLocalBrowserFallback(baseUrl: string): boolean {
  return process.env.SCRAPER_V3_BROWSER_FALLBACK !== "false" && isLocalScraperUrl(baseUrl);
}

function toScraperCookies(session: CookieCache | null): Array<Record<string, unknown>> {
  return (session?.cookies ?? []).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  }));
}

async function callScraperService(
  products: ProductRow[],
  signal: AbortSignal,
  session: CookieCache | null,
): Promise<ScraperResult[]> {
  const baseUrl = process.env.SCRAPER_V3_URL?.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("SCRAPER_V3_URL 환경변수가 없습니다. v3 수집 서비스 배포 후 다시 시도하세요.");
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.SCRAPER_V3_API_KEY) {
    headers["x-api-key"] = process.env.SCRAPER_V3_API_KEY;
  }

  const res = await fetch(`${baseUrl}/scrape/gmarket`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: process.env.SCRAPER_V3_MODE || "fetcher",
      cookies: toScraperCookies(session),
      user_agent: session?.userAgent ?? null,
      items: products.map((p) => ({
        id: p.id,
        name: p.product_name,
        url: p.purchase_url,
        previous_price: p.lowest_price,
      })),
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`v3 수집 서비스 오류 (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as ScraperResponse;
  return Array.isArray(json.results) ? json.results : [];
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({})) as { productIds?: string[] };
    const userSb = getSupabaseClient(token);
    const { data: { user: authUser } } = await userSb.auth.getUser();
    if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const products = await loadProducts(body.productIds, authUser.id);
    if (!products.length) {
      return NextResponse.json({ error: "가격 추출할 상품이 없습니다." }, { status: 400 });
    }

    const gmarketProducts = products.filter((p) => p.purchase_url.includes("gmarket.co.kr"));
    const skippedCount = products.length - gmarketProducts.length;
    if (!gmarketProducts.length) {
      return NextResponse.json({ error: "지마켓 상품이 없습니다. (v3는 지마켓부터 실험)" }, { status: 400 });
    }

    const stream = new ReadableStream({
      async start(controller) {
        const sb = getServiceSupabaseClient();
        const enc = new TextEncoder();
        const send = (e: SSEEvent) => {
          try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {}
        };

        let updated = 0;
        let failed = 0;
        let unchanged = 0;
        let botBlocked = 0;
        let soldOut = 0;
        let processed = 0;
        const statusHistoryRows: Array<Record<string, unknown>> = [];
        const abortController = new AbortController();
        const onAbort = () => abortController.abort();
        request.signal.addEventListener("abort", onAbort);
        let browserFallback: GmarketBrowserFetchClient | null = null;

        try {
          send({ type: "init", message: "[v3] Scrapling 수집 서비스 연결 중..." });
          const scraperBaseUrl = process.env.SCRAPER_V3_URL ?? "";
          const useBrowserFallback = shouldUseLocalBrowserFallback(scraperBaseUrl);
          const session = shouldSendGmarketSession(scraperBaseUrl)
            ? await harvestGmarketCookies(authUser.id)
            : null;
          if (session) {
            send({ type: "init", message: "[v3] 로컬 지마켓 세션 연결 완료" });
          }

          for (let i = 0; i < gmarketProducts.length; i += SCRAPER_BATCH_SIZE) {
            if (request.signal.aborted) break;

            const batch = gmarketProducts.slice(i, i + SCRAPER_BATCH_SIZE);
            const results = await callScraperService(batch, abortController.signal, session);
            const resultMap = new Map(results.map((r) => [r.id, r]));

            for (const p of batch) {
              const previousPrice = p.lowest_price;
              const result: ScraperResult = resultMap.get(p.id) ?? {
                id: p.id,
                price: 0,
                bot_blocked: false,
                fail_reason: "service_error" as const,
              };

              if (result.bot_blocked && useBrowserFallback) {
                if (!browserFallback) {
                  send({ type: "init", message: "[v3] Scrapling 차단 감지 — 로컬 브라우저 방식으로 전환 중..." });
                  browserFallback = new GmarketBrowserFetchClient();
                  await browserFallback.init(authUser.id);
                  send({ type: "init", message: "[v3] 로컬 브라우저 전환 완료 — 수집 재시도" });
                }

                const fetchResult = await browserFallback.fetchProductPage(p.purchase_url);
                if (fetchResult.cfBlocked) {
                  result.price = 0;
                  result.bot_blocked = true;
                  result.fail_reason = "bot_blocked";
                  result.status_code = fetchResult.status;
                } else if (!fetchResult.html) {
                  result.price = 0;
                  result.bot_blocked = false;
                  result.fail_reason = "network_error";
                  result.status_code = fetchResult.status;
                } else {
                  const parsed = toGmarketPriceResult(parseGmarketPrice(fetchResult.html));
                  result.price = parsed.price;
                  result.bot_blocked = parsed.botBlocked;
                  result.fail_reason = parsed.failReason;
                  result.status_code = fetchResult.status;
                }
              }

              processed++;
              const price = typeof result.price === "number" && Number.isFinite(result.price) ? result.price : 0;
              const failReason = result.fail_reason ?? null;

              if (result.bot_blocked) {
                botBlocked++;
              } else if (price > 0 && price !== previousPrice) {
                updated++;
              } else if (price > 0) {
                unchanged++;
                if (previousPrice > 0) {
                  statusHistoryRows.push({
                    product_id: p.id,
                    previous_price: previousPrice,
                    new_price: previousPrice,
                    change_amount: 0,
                    change_rate: 0,
                    source: "scrapling_scrape",
                  });
                }
              } else if (failReason === "sold_out") {
                soldOut++;
                statusHistoryRows.push({
                  product_id: p.id,
                  previous_price: previousPrice,
                  new_price: 0,
                  change_amount: 0,
                  change_rate: 0,
                  source: "soldout",
                });
              } else {
                failed++;
                if (previousPrice > 0) {
                  statusHistoryRows.push({
                    product_id: p.id,
                    previous_price: previousPrice,
                    new_price: 0,
                    change_amount: 0,
                    change_rate: 0,
                    source: "scrapling_scrape",
                  });
                }
              }

              send({
                type: "progress",
                id: p.id,
                name: p.product_name,
                price,
                previous_price: previousPrice,
                index: processed,
                total: gmarketProducts.length,
                bot_blocked: Boolean(result.bot_blocked),
                fail_reason: failReason,
              });
            }
          }

          send({ type: "done", updated, failed, unchanged, bot_blocked: botBlocked, sold_out: soldOut, skipped: skippedCount });
        } catch (e) {
          console.error("[scrape-prices-v3] 오류:", e instanceof Error ? e.message : String(e));
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          request.signal.removeEventListener("abort", onAbort);
          await browserFallback?.destroy();
          if (statusHistoryRows.length > 0) {
            const { error: histErr } = await sb.from("price_history").insert(statusHistoryRows);
            if (histErr) console.error("[scrape-prices-v3] 상태 이력 저장 실패:", histErr.message);
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  } catch (err) {
    console.error("[scrape-prices-v3] 요청 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: err instanceof Error ? err.message : "v3 최저가 수집 실패" }, { status: 500 });
  }
}
