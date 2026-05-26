import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getServiceSupabaseClient, getSupabaseClient } from "@/lib/api-helpers";
import { GmarketBrowserFetchClient } from "@/lib/scrapers/browser-fetch-client";
import { parseGmarketPrice, toGmarketPriceResult } from "@/lib/gmarket-price-parser";
import type { GmarketPriceResult } from "@/lib/gmarket-price-parser";

export const maxDuration = 300;

type FailReason = GmarketPriceResult["failReason"] | "network_error" | null;

type SSEEvent =
  | { type: "progress"; id: string; name: string; price: number; previous_price: number; index: number; total: number; bot_blocked: boolean; fail_reason: FailReason }
  | { type: "init"; message: string }
  | { type: "done"; updated: number; failed: number; unchanged: number; bot_blocked: number; sold_out: number; skipped: number }
  | { type: "error"; message: string };

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { productIds?: string[] };
  const sb = getServiceSupabaseClient();

  const userSb = getSupabaseClient(token);
  const { data: { user: authUser } } = await userSb.auth.getUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  type ProductRow = { id: string; product_name: string; purchase_url: string; lowest_price: number };
  let products: ProductRow[] = [];

  if (body.productIds?.length) {
    const CHUNK = 200;
    for (let i = 0; i < body.productIds.length; i += CHUNK) {
      const chunk = body.productIds.slice(i, i + CHUNK);
      const { data, error } = await sb
        .from("products")
        .select("id, product_name, purchase_url, lowest_price")
        .eq("user_id", authUser.id)
        .gt("purchase_url", "")
        .in("id", chunk)
        .order("sort_order", { ascending: true });
      if (error) {
        console.error(`[scrape-prices-v2] 청크 조회 실패 (${i}~${i + chunk.length}):`, error.message);
        return NextResponse.json({ error: `상품 조회 실패: ${error.message}` }, { status: 400 });
      }
      if (data) products.push(...(data as ProductRow[]));
    }
  } else {
    const { data, error } = await sb
      .from("products")
      .select("id, product_name, purchase_url, lowest_price")
      .eq("user_id", authUser.id)
      .gt("purchase_url", "")
      .order("sort_order", { ascending: true });
    if (error) {
      console.error("[scrape-prices-v2] 전체 조회 실패:", error.message);
      return NextResponse.json({ error: `상품 조회 실패: ${error.message}` }, { status: 400 });
    }
    if (data) products = data as ProductRow[];
  }

  if (!products.length) {
    return NextResponse.json({ error: "가격 추출할 상품이 없습니다." }, { status: 400 });
  }

  const gmarketProducts = products.filter((p) => p.purchase_url.includes("gmarket.co.kr"));
  const skippedCount = products.length - gmarketProducts.length;

  if (!gmarketProducts.length) {
    return NextResponse.json({ error: "지마켓 상품이 없습니다. (v2는 지마켓만 지원)" }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: SSEEvent) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {}
      };

      let updated = 0;
      let failed = 0;
      let unchanged = 0;
      let botBlocked = 0;
      let soldOut = 0;
      const statusHistoryRows: Array<Record<string, unknown>> = [];

      const client = new GmarketBrowserFetchClient();

      try {
        send({ type: "init", message: "브라우저 준비 중 (로그인 + CF 통과)..." });
        await client.init(authUser.id);
        send({ type: "init", message: "브라우저 준비 완료 — 가격 수집 시작" });
        for (let i = 0; i < gmarketProducts.length; i++) {
          if (request.signal.aborted) break;

          const p = gmarketProducts[i];
          const previousPrice = p.lowest_price;
          let result: GmarketPriceResult;

          const fetchResult = await client.fetchProductPage(p.purchase_url);

          if (fetchResult.cfBlocked) {
            result = { price: 0, botBlocked: true, failReason: "bot_blocked" };
            botBlocked++;
          } else if (!fetchResult.html) {
            result = { price: 0, botBlocked: false, failReason: "network_error" };
            failed++;
            if (previousPrice > 0) {
              statusHistoryRows.push({
                product_id: p.id, previous_price: previousPrice,
                new_price: 0, change_amount: 0, change_rate: 0, source: "impit_scrape",
              });
            }
          } else {
            const parsed = parseGmarketPrice(fetchResult.html);
            result = toGmarketPriceResult(parsed);

            if (result.price > 0 && result.price !== previousPrice) {
              updated++;
            } else if (result.price > 0) {
              unchanged++;
              if (previousPrice > 0) {
                statusHistoryRows.push({
                  product_id: p.id, previous_price: previousPrice,
                  new_price: previousPrice, change_amount: 0, change_rate: 0, source: "impit_scrape",
                });
              }
            } else if (result.failReason === "sold_out") {
              soldOut++;
              statusHistoryRows.push({
                product_id: p.id, previous_price: previousPrice,
                new_price: 0, change_amount: 0, change_rate: 0, source: "soldout",
              });
            } else {
              failed++;
              if (previousPrice > 0) {
                statusHistoryRows.push({
                  product_id: p.id, previous_price: previousPrice,
                  new_price: 0, change_amount: 0, change_rate: 0, source: "impit_scrape",
                });
              }
            }
          }

          send({
            type: "progress",
            id: p.id,
            name: p.product_name,
            price: result.price,
            previous_price: previousPrice,
            index: i + 1,
            total: gmarketProducts.length,
            bot_blocked: result.botBlocked,
            fail_reason: result.failReason,
          });
        }

        send({ type: "done", updated, failed, unchanged, bot_blocked: botBlocked, sold_out: soldOut, skipped: skippedCount });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        if (statusHistoryRows.length > 0) {
          const { error: histErr } = await sb.from("price_history").insert(statusHistoryRows);
          if (histErr) console.error("[scrape-prices-v2] 상태 이력 저장 실패:", histErr.message);
        }
        await client.destroy();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
