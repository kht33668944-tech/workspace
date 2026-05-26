import { NextRequest, NextResponse } from "next/server";
import type { BrowserContext } from "playwright";
import { launchPatchedBrowser, createPatchedGmarketContext } from "@/lib/scrapers/browser";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getServiceSupabaseClient, getSupabaseClient } from "@/lib/api-helpers";
import { decrypt } from "@/lib/crypto";
import { loadSession, saveSession } from "@/lib/scrapers/session-manager";

export const maxDuration = 300;

// ── G마켓 로그인 ──────────────────────────────────
const userCookieCache = new Map<string, { cookies: import("playwright").Cookie[]; cachedAt: number }>();
const COOKIE_TTL = 4 * 60 * 60 * 1000;

async function getGmarketCred(userId: string) {
  const sb = getServiceSupabaseClient();
  const { data } = await sb
    .from("purchase_credentials")
    .select("login_id, login_pw_encrypted")
    .eq("platform", "gmarket")
    .eq("user_id", userId)
    .limit(1)
    .single();
  if (!data?.login_id || !data.login_pw_encrypted) return null;
  return { id: data.login_id, pw: decrypt(data.login_pw_encrypted) };
}

async function loginGmarket(ctx: BrowserContext, userId: string): Promise<boolean> {
  const cred = await getGmarketCred(userId);
  if (!cred) return false;
  const page = await ctx.newPage();
  try {
    await page.goto("https://signinssl.gmarket.co.kr/login/login", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.getByPlaceholder("아이디").fill(cred.id);
    await page.locator("#typeMemberInputPassword").fill(cred.pw);
    await Promise.all([
      page.waitForURL((u) => !u.toString().includes("login/login"), { timeout: 30000 }).catch(() => null),
      page.getByRole("button", { name: "로그인", exact: false }).first().click(),
    ]);
    await page.waitForTimeout(1500);
    return !page.url().includes("login/login");
  } catch { return false; }
  finally { await page.close(); }
}

async function verifyLogin(ctx: BrowserContext): Promise<boolean> {
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.gmarket.co.kr", { waitUntil: "domcontentloaded", timeout: 15000 });
    return await page.evaluate(() => !!document.querySelector(".link__logout, .btn-logout, [class*='logout']")).catch(() => false);
  } catch { return false; }
  finally { await page.close(); }
}

async function ensureLogin(ctx: BrowserContext, userId: string) {
  const sb = getServiceSupabaseClient();
  const cred = await getGmarketCred(userId);
  const loginId = cred?.id ?? "";
  const now = Date.now();

  // per-user 쿠키 캐시 확인
  const cached = userCookieCache.get(userId);
  if (cached && now - cached.cachedAt < COOKIE_TTL) {
    await ctx.addCookies(cached.cookies);
    if (await verifyLogin(ctx)) return;
    userCookieCache.delete(userId);
  }
  if (loginId) {
    const dbCookies = await loadSession(sb, "gmarket", loginId);
    if (dbCookies) {
      await ctx.addCookies(dbCookies);
      if (await verifyLogin(ctx)) { userCookieCache.set(userId, { cookies: dbCookies, cachedAt: now }); return; }
    }
  }
  const ok = await loginGmarket(ctx, userId);
  if (ok && await verifyLogin(ctx)) {
    const cookies = await ctx.cookies();
    userCookieCache.set(userId, { cookies, cachedAt: Date.now() });
    if (loginId) saveSession(sb, "gmarket", loginId, cookies).catch(() => {});
  }
}

// ── 가격 추출 ──────────────────────────────────
type FailReason = "bot_blocked" | "timeout" | "sold_out" | "selector_changed" | "network_error" | null;
type PriceResult = { price: number; botBlocked: boolean; failReason: FailReason };

async function extractGmarketPrice(ctx: BrowserContext, url: string): Promise<PriceResult> {
  const page = await ctx.newPage();
  try {
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(t)) route.abort();
      else route.continue();
    });
    await page.goto(url, { waitUntil: "load", timeout: 30000 });

    const title = await page.title().catch(() => "");
    if (title.includes("잠시만 기다리십시오") || title.includes("Just a moment")) {
      return { price: 0, botBlocked: true, failReason: "bot_blocked" };
    }

    // 품절 감지
    const isSoldOut = await page.evaluate(() => {
      const el = document.querySelector(".box__soldout, .item-soldout, [class*='soldout'], [class*='sold_out']");
      if (el) return true;
      const text = document.body.innerText;
      return text.includes("품절") && (text.includes("이 상품은") || text.includes("판매종료"));
    }).catch(() => false);

    if (isSoldOut) {
      return { price: 0, botBlocked: false, failReason: "sold_out" };
    }

    const selectorFound = await page.waitForSelector(".box__price strong.price_real", { timeout: 10000 }).catch(() => null);

    const price = await page.evaluate(() => {
      const coupon = document.querySelector(".price_innerwrap-coupon .price_real");
      if (coupon?.textContent) {
        const n = parseInt(coupon.textContent.replace(/[^0-9]/g, ""), 10);
        if (n > 0) return n;
      }
      const sale = document.querySelector(".box__price strong.price_real");
      if (sale?.textContent) {
        const n = parseInt(sale.textContent.replace(/[^0-9]/g, ""), 10);
        if (n > 0) return n;
      }
      return 0;
    });

    if (price > 0) return { price, botBlocked: false, failReason: null };
    return { price: 0, botBlocked: false, failReason: selectorFound ? "sold_out" : "timeout" };
  } catch {
    return { price: 0, botBlocked: false, failReason: "network_error" };
  } finally { await page.close(); }
}

async function extractOhousePrice(ctx: BrowserContext, url: string): Promise<PriceResult> {
  const page = await ctx.newPage();
  try {
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "media", "font"].includes(t)) route.abort();
      else route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      // 품절 감지
      const soldOutEl = document.querySelector('[class*="sold-out"], [class*="soldout"], [class*="sold_out"]');
      const bodyText = document.body.innerText;
      if (soldOutEl || (bodyText.includes("품절") && bodyText.includes("알림"))) {
        return { price: 0, reason: "sold_out" as const };
      }
      // 1순위: Open Graph meta 태그
      const ogPrice = document.querySelector<HTMLMetaElement>('meta[property="product:price:amount"]')?.content;
      if (ogPrice) {
        const n = parseInt(ogPrice, 10);
        if (n > 0) return { price: n, reason: null };
      }
      // 2순위: JSON-LD
      const jsonLd = document.querySelector('script[type="application/ld+json"]');
      if (jsonLd?.textContent) {
        try {
          const data = JSON.parse(jsonLd.textContent);
          if (data.offers?.price) return { price: parseInt(String(data.offers.price), 10), reason: null };
        } catch {}
      }
      // 3순위: __NEXT_DATA__
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd?.textContent) {
        try {
          const m = nd.textContent.match(/"sellingPrice"\s*:\s*(\d+)/);
          if (m) return { price: parseInt(m[1], 10), reason: null };
        } catch {}
      }
      return { price: 0, reason: "selector_changed" as const };
    });
    return { price: result.price, botBlocked: false, failReason: result.price > 0 ? null : (result.reason as FailReason) };
  } catch {
    return { price: 0, botBlocked: false, failReason: "network_error" };
  } finally { await page.close(); }
}

// ── SSE API ──────────────────────────────────
type SSEEvent =
  | { type: "progress"; id: string; name: string; price: number; previous_price: number; index: number; total: number; bot_blocked?: boolean; fail_reason?: FailReason }
  | { type: "done"; updated: number; failed: number; unchanged: number; bot_blocked: number }
  | { type: "error"; message: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min: number, max: number) => sleep(Math.floor(Math.random() * (max - min)) + min);

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { productIds?: string[] };
  const sb = getServiceSupabaseClient();

  // JWT에서 user_id 추출하여 소유권 검증
  const userSb = getSupabaseClient(token);
  const { data: { user: authUser } } = await userSb.auth.getUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  type ProductRow = { id: string; product_name: string; purchase_url: string; lowest_price: number };
  let products: ProductRow[] = [];

  // productIds가 있으면 .in() URL 길이 한계 회피를 위해 200개씩 청크 조회
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
        console.error(`[scrape-prices] 청크 조회 실패 (${i}~${i + chunk.length}):`, error.message);
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
      console.error("[scrape-prices] 전체 조회 실패:", error.message);
      return NextResponse.json({ error: `상품 조회 실패: ${error.message}` }, { status: 400 });
    }
    if (data) products = data as ProductRow[];
  }

  if (!products.length) {
    return NextResponse.json({ error: "가격 추출할 상품이 없습니다." }, { status: 400 });
  }

  const gmarketProducts = products.filter((p) => p.purchase_url.includes("gmarket.co.kr"));
  const ohouseProducts = products.filter((p) => p.purchase_url.includes("ohou.se") || p.purchase_url.includes("ohouse"));
  const allTargets = [...gmarketProducts, ...ohouseProducts];

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
      const statusHistoryRows: Array<Record<string, unknown>> = []; // 변동없음·실패 이력 (변동은 apply 단계에서 별도 기록)

      await browserPool.acquire();
      const browser = await launchPatchedBrowser();
      let ctx = await createPatchedGmarketContext(browser);

      try {
        // 지마켓 로그인
        const hasGmarket = gmarketProducts.length > 0;
        if (hasGmarket) {
          await ensureLogin(ctx, authUser.id);
        }

        const CONCURRENCY = 2; // 봇 감지 빈도 줄이기 위해 4 → 2
        const CONTEXT_REFRESH_INTERVAL = 30;
        const BOT_BLOCK_RESET_THRESHOLD = 3; // 컨텍스트당 봇 감지 누적 시 즉시 재생성
        let processedCount = 0;
        let ctxBotBlocks = 0;

        for (let i = 0; i < allTargets.length; i += CONCURRENCY) {
          if (request.signal.aborted) break;

          // 일정 개수마다 또는 봇 감지 누적 시 컨텍스트 재생성
          const shouldRefresh =
            (processedCount > 0 && processedCount % CONTEXT_REFRESH_INTERVAL === 0) ||
            ctxBotBlocks >= BOT_BLOCK_RESET_THRESHOLD;
          if (shouldRefresh) {
            console.log(`[scrape-prices] 컨텍스트 재생성 (처리: ${processedCount}, 봇감지: ${ctxBotBlocks})`);
            await ctx.close().catch(() => {});
            ctx = await createPatchedGmarketContext(browser);
            ctxBotBlocks = 0;
            if (hasGmarket) {
              await ensureLogin(ctx, authUser.id);
            }
          }

          const batch = allTargets.slice(i, i + CONCURRENCY);

          const results = await Promise.all(
            batch.map(async (p) => {
              const isGmarket = p.purchase_url.includes("gmarket.co.kr");
              const r = isGmarket
                ? await extractGmarketPrice(ctx, p.purchase_url)
                : await extractOhousePrice(ctx, p.purchase_url);
              return { ...p, price: r.price, botBlocked: r.botBlocked, failReason: r.failReason };
            })
          );

          for (const r of results) {
            const previousPrice = r.lowest_price;

            if (r.botBlocked) {
              botBlocked++;
              ctxBotBlocks++;
            } else if (r.price > 0 && r.price !== previousPrice) {
              updated++;
            } else if (r.price > 0) {
              unchanged++;
              if (previousPrice > 0) {
                statusHistoryRows.push({
                  product_id: r.id,
                  previous_price: previousPrice,
                  new_price: previousPrice,
                  change_amount: 0,
                  change_rate: 0,
                  source: "scrape",
                });
              }
            } else {
              failed++;
              if (previousPrice > 0) {
                statusHistoryRows.push({
                  product_id: r.id,
                  previous_price: previousPrice,
                  new_price: 0,
                  change_amount: 0,
                  change_rate: 0,
                  source: "scrape",
                });
              }
            }

            send({
              type: "progress",
              id: r.id,
              name: r.product_name,
              price: r.price,
              previous_price: previousPrice,
              index: updated + failed + unchanged + botBlocked,
              total: allTargets.length,
              bot_blocked: r.botBlocked,
              fail_reason: r.failReason,
            });
          }

          processedCount += batch.length;

          // 다음 배치 전 랜덤 지연 (봇 행동 패턴 위장)
          if (i + CONCURRENCY < allTargets.length) {
            await randomDelay(800, 2000);
          }
        }

        send({ type: "done", updated, failed, unchanged, bot_blocked: botBlocked });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        // 변동없음·실패 이력 일괄 저장 (전일대비 컬럼에서 상태 표시·필터링용)
        if (statusHistoryRows.length > 0) {
          const { error: histErr } = await sb.from("price_history").insert(statusHistoryRows);
          if (histErr) console.error("[scrape-prices] 상태 이력 저장 실패:", histErr.message);
        }
        await ctx.close().catch(() => {});
        await browser.close().catch(() => {});
        browserPool.release();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
