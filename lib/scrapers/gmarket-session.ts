import type { BrowserContext, Cookie } from "playwright";
import { launchPatchedBrowser, createPatchedGmarketContext } from "@/lib/scrapers/browser";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getServiceSupabaseClient } from "@/lib/api-helpers";
import { decrypt } from "@/lib/crypto";
import { loadSession, saveSession } from "@/lib/scrapers/session-manager";

const COOKIE_TTL = 4 * 60 * 60 * 1000;

export interface CookieCache {
  cookies: Cookie[];
  userAgent: string;
  cachedAt: number;
}

export const userCookieCache = new Map<string, CookieCache>();

export async function getGmarketCred(userId: string) {
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

export async function loginGmarket(ctx: BrowserContext, userId: string): Promise<boolean> {
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

export async function verifyLogin(ctx: BrowserContext): Promise<boolean> {
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.gmarket.co.kr", { waitUntil: "domcontentloaded", timeout: 15000 });
    return await page.evaluate(() => !!document.querySelector(".link__logout, .btn-logout, [class*='logout']")).catch(() => false);
  } catch { return false; }
  finally { await page.close(); }
}

export async function ensureLogin(ctx: BrowserContext, userId: string) {
  const sb = getServiceSupabaseClient();
  const cred = await getGmarketCred(userId);
  const loginId = cred?.id ?? "";
  const now = Date.now();

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
      if (await verifyLogin(ctx)) {
        const ua = await ctx.newPage().then(async (p) => {
          const ua = await p.evaluate(() => navigator.userAgent);
          await p.close();
          return ua;
        });
        userCookieCache.set(userId, { cookies: dbCookies, userAgent: ua, cachedAt: now });
        return;
      }
    }
  }
  const ok = await loginGmarket(ctx, userId);
  if (ok && await verifyLogin(ctx)) {
    const cookies = await ctx.cookies();
    const ua = await ctx.newPage().then(async (p) => {
      const ua = await p.evaluate(() => navigator.userAgent);
      await p.close();
      return ua;
    });
    userCookieCache.set(userId, { cookies, userAgent: ua, cachedAt: Date.now() });
    if (loginId) saveSession(sb, "gmarket", loginId, cookies).catch(() => {});
  }
}

export async function harvestGmarketCookies(userId: string): Promise<CookieCache | null> {
  const now = Date.now();
  const cached = userCookieCache.get(userId);
  if (cached && now - cached.cachedAt < COOKIE_TTL) {
    return cached;
  }

  await browserPool.acquire();
  const browser = await launchPatchedBrowser();
  try {
    const ctx = await createPatchedGmarketContext(browser);
    try {
      await ensureLogin(ctx, userId);

      // cf_clearance를 얻기 위해 상품 페이지 1회 방문
      const cfPage = await ctx.newPage();
      try {
        await cfPage.goto("https://item.gmarket.co.kr/Item?goodscode=1752706460", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await cfPage.waitForTimeout(2000);
      } catch { /* cf 쿠키만 필요하므로 에러 무시 */ }
      finally { await cfPage.close(); }

      const cookies = await ctx.cookies();
      const uaPage = await ctx.newPage();
      const userAgent = await uaPage.evaluate(() => navigator.userAgent);
      await uaPage.close();

      const entry: CookieCache = { cookies, userAgent, cachedAt: Date.now() };
      userCookieCache.set(userId, entry);

      const cred = await getGmarketCred(userId);
      if (cred?.id) {
        const sb = getServiceSupabaseClient();
        saveSession(sb, "gmarket", cred.id, cookies).catch(() => {});
      }

      return entry;
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    browserPool.release();
  }
}
