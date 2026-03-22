import { NextRequest } from "next/server";
import type { BrowserContext } from "playwright";
import { launchBrowser, createGmarketContext } from "@/lib/scrapers/browser";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getServiceSupabaseClient } from "@/lib/api-helpers";
import { decrypt } from "@/lib/crypto";
import { loadSession, saveSession } from "@/lib/scrapers/session-manager";

export const maxDuration = 300;

// ── G마켓 로그인 ──────────────────────────────────
let cookieCache: import("playwright").Cookie[] | null = null;
let cookieCachedAt = 0;
const COOKIE_TTL = 4 * 60 * 60 * 1000;

async function getGmarketCred() {
  const sb = getServiceSupabaseClient();
  const { data } = await sb
    .from("purchase_credentials")
    .select("login_id, login_pw_encrypted")
    .eq("platform", "gmarket")
    .limit(1)
    .single();
  if (!data?.login_id || !data.login_pw_encrypted) return null;
  return { id: data.login_id, pw: decrypt(data.login_pw_encrypted) };
}

async function loginGmarket(ctx: BrowserContext): Promise<boolean> {
  const cred = await getGmarketCred();
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

async function ensureLogin(ctx: BrowserContext) {
  const sb = getServiceSupabaseClient();
  const cred = await getGmarketCred();
  const loginId = cred?.id ?? "";
  const now = Date.now();

  if (cookieCache && now - cookieCachedAt < COOKIE_TTL) {
    await ctx.addCookies(cookieCache);
    if (await verifyLogin(ctx)) return;
    cookieCache = null;
  }
  if (loginId) {
    const dbCookies = await loadSession(sb, "gmarket", loginId);
    if (dbCookies) {
      await ctx.addCookies(dbCookies);
      if (await verifyLogin(ctx)) { cookieCache = dbCookies; cookieCachedAt = now; return; }
    }
  }
  const ok = await loginGmarket(ctx);
  if (ok && await verifyLogin(ctx)) {
    const cookies = await ctx.cookies();
    cookieCache = cookies;
    cookieCachedAt = Date.now();
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
  | { type: "progress"; id: string; name: string; price: number; index: number; total: number }
  | { type: "done"; updated: number; failed: number }
  | { type: "error"; message: string };

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const sb = getServiceSupabaseClient();

  // 가격이 0인 상품 중 URL이 있는 것만 조회
  const { data: products, error } = await sb
    .from("products")
    .select("id, product_name, purchase_url, lowest_price")
    .gt("purchase_url", "")
    .eq("lowest_price", 0)
    .order("sort_order", { ascending: true });

  if (error || !products?.length) {
    return new Response(JSON.stringify({ error: "가격 추출할 상품이 없습니다." }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
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

      await browserPool.acquire();
      const browser = await launchBrowser();
      const ctx = await createGmarketContext(browser);

      try {
        // 지마켓 로그인
        if (gmarketProducts.length > 0) {
          await ensureLogin(ctx);
        }

        const CONCURRENCY = 4;

        for (let i = 0; i < allTargets.length; i += CONCURRENCY) {
          if (request.signal.aborted) break;
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
            if (r.price > 0) {
              await sb.from("products").update({ lowest_price: r.price }).eq("id", r.id);
              updated++;
            } else {
              failed++;
            }
            send({
              type: "progress",
              id: r.id,
              name: r.product_name,
              price: r.price,
              index: updated + failed,
              total: allTargets.length,
            });
          }
        }

        send({ type: "done", updated, failed });
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
