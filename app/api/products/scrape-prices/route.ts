import { NextRequest, NextResponse } from "next/server";
import type { BrowserContext } from "playwright";
import { launchBrowser, createGmarketContext } from "@/lib/scrapers/browser";
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
async function extractGmarketPrice(ctx: BrowserContext, url: string): Promise<number> {
  const page = await ctx.newPage();
  try {
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(t)) route.abort();
      else route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(".box__price strong.price_real", { timeout: 5000 }).catch(() => {});

    return await page.evaluate(() => {
      // 1순위: 클럽쿠폰가
      const coupon = document.querySelector(".price_innerwrap-coupon .price_real");
      if (coupon?.textContent) {
        const n = parseInt(coupon.textContent.replace(/[^0-9]/g, ""), 10);
        if (n > 0) return n;
      }
      // 2순위: 판매가
      const sale = document.querySelector(".box__price strong.price_real");
      if (sale?.textContent) {
        const n = parseInt(sale.textContent.replace(/[^0-9]/g, ""), 10);
        if (n > 0) return n;
      }
      return 0;
    });
  } catch { return 0; }
  finally { await page.close(); }
}

async function extractOhousePrice(ctx: BrowserContext, url: string): Promise<number> {
  const page = await ctx.newPage();
  try {
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "media", "font"].includes(t)) route.abort();
      else route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    return await page.evaluate(() => {
      // 1순위: Open Graph meta 태그
      const ogPrice = document.querySelector<HTMLMetaElement>('meta[property="product:price:amount"]')?.content;
      if (ogPrice) {
        const n = parseInt(ogPrice, 10);
        if (n > 0) return n;
      }
      // 2순위: JSON-LD
      const jsonLd = document.querySelector('script[type="application/ld+json"]');
      if (jsonLd?.textContent) {
        try {
          const data = JSON.parse(jsonLd.textContent);
          if (data.offers?.price) return parseInt(String(data.offers.price), 10);
        } catch {}
      }
      // 3순위: __NEXT_DATA__
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd?.textContent) {
        try {
          const m = nd.textContent.match(/"sellingPrice"\s*:\s*(\d+)/);
          if (m) return parseInt(m[1], 10);
        } catch {}
      }
      return 0;
    });
  } catch { return 0; }
  finally { await page.close(); }
}

// ── SSE API ──────────────────────────────────
type SSEEvent =
  | { type: "progress"; id: string; name: string; price: number; previous_price: number; index: number; total: number }
  | { type: "done"; updated: number; failed: number; unchanged: number }
  | { type: "error"; message: string };

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { productIds?: string[] };
  const sb = getServiceSupabaseClient();

  // JWT에서 user_id 추출하여 소유권 검증
  const userSb = getSupabaseClient(token);
  const { data: { user: authUser } } = await userSb.auth.getUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let query = sb
    .from("products")
    .select("id, product_name, purchase_url, lowest_price")
    .eq("user_id", authUser.id)
    .gt("purchase_url", "")
    .order("sort_order", { ascending: true });

  // productIds가 있으면 해당 상품만, 없으면 전체
  if (body.productIds?.length) {
    query = query.in("id", body.productIds);
  }

  const { data: products, error } = await query;

  if (error || !products?.length) {
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

      await browserPool.acquire();
      const browser = await launchBrowser();
      let ctx = await createGmarketContext(browser);

      try {
        // 지마켓 로그인
        const hasGmarket = gmarketProducts.length > 0;
        if (hasGmarket) {
          await ensureLogin(ctx, authUser.id);
        }

        const CONCURRENCY = 4;
        const CONTEXT_REFRESH_INTERVAL = 28; // 28개마다 컨텍스트 재생성 (봇 감지 우회)
        let processedCount = 0;

        for (let i = 0; i < allTargets.length; i += CONCURRENCY) {
          if (request.signal.aborted) break;

          // 일정 개수마다 컨텍스트 재생성 (새 세션으로 봇 감지 리셋)
          if (processedCount > 0 && processedCount % CONTEXT_REFRESH_INTERVAL === 0) {
            console.log(`[scrape-prices] 컨텍스트 재생성 (${processedCount}개 처리 완료)`);
            await ctx.close().catch(() => {});
            ctx = await createGmarketContext(browser);
            if (hasGmarket) {
              await ensureLogin(ctx, authUser.id);
            }
          }

          const batch = allTargets.slice(i, i + CONCURRENCY);

          const results = await Promise.all(
            batch.map(async (p) => {
              const isGmarket = p.purchase_url.includes("gmarket.co.kr");
              const price = isGmarket
                ? await extractGmarketPrice(ctx, p.purchase_url)
                : await extractOhousePrice(ctx, p.purchase_url);
              return { ...p, price };
            })
          );

          for (const r of results) {
            const previousPrice = r.lowest_price;

            if (r.price > 0 && r.price !== previousPrice) {
              updated++;
            } else if (r.price > 0) {
              unchanged++;
            } else {
              failed++;
            }

            send({
              type: "progress",
              id: r.id,
              name: r.product_name,
              price: r.price,
              previous_price: previousPrice,
              index: updated + failed + unchanged,
              total: allTargets.length,
            });
          }

          processedCount += batch.length;
        }

        send({ type: "done", updated, failed, unchanged });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
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
