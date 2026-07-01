import type { Browser, BrowserContext, Page } from "playwright";
import { launchPatchedBrowser, createPatchedGmarketContext } from "./browser";
import { browserPool } from "./browser-pool";
import { ensureLogin } from "./gmarket-session";

export interface BrowserFetchResult {
  html: string | null;
  status: number;
  cfBlocked: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const randomDelay = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min)) + min;

const DELAY_MIN_MS = 150;
const DELAY_MAX_MS = 500;

/**
 * Playwright 브라우저 내부 fetch() API를 사용하는 가격 수집 클라이언트.
 * 실제 Chrome TLS 지문 + 로그인 세션 쿠키로 CF 우회.
 * 페이지 렌더링 없이 HTML만 가져오므로 상품당 ~200-500ms.
 */
export class GmarketBrowserFetchClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private poolAcquired = false;

  async init(userId: string): Promise<void> {
    await browserPool.acquire();
    this.poolAcquired = true;
    try {
      this.browser = await launchPatchedBrowser();
      await this.prepareContext(userId);
    } catch (e) {
      await this.destroy();
      throw e;
    }
  }

  async resetSession(userId: string): Promise<void> {
    if (!this.browser) throw new Error("Client not initialized");
    await this.closeContext();
    await sleep(8000 + randomDelay(0, 7000));
    await this.prepareContext(userId);
  }

  private async prepareContext(userId: string): Promise<void> {
    if (!this.browser) throw new Error("Browser not initialized");
    this.context = await createPatchedGmarketContext(this.browser);
    await ensureLogin(this.context, userId);
    this.page = await this.context.newPage();
    await this.page.goto(
      "https://item.gmarket.co.kr/Item?goodscode=1752706460",
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    await this.page
      .waitForFunction(() => !/잠시만 기다리|Just a moment/i.test(document.title), { timeout: 12000 })
      .catch(() => {});
    await this.page.waitForTimeout(2000);
  }

  async fetchProductPage(url: string): Promise<BrowserFetchResult> {
    if (!this.page) throw new Error("Client not initialized");

    await sleep(randomDelay(DELAY_MIN_MS, DELAY_MAX_MS));

    try {
      const result = await this.page.evaluate(async (fetchUrl: string) => {
        try {
          // 외부 API 무응답 시 무한 대기 방지 (15초 상한)
          const res = await fetch(fetchUrl, { credentials: "include", signal: AbortSignal.timeout(15000) });
          const html = await res.text();
          return { html, status: res.status, error: null };
        } catch (e) {
          return { html: null, status: 0, error: String(e) };
        }
      }, url);

      if (result.error || !result.html) {
        return { html: null, status: result.status, cfBlocked: false };
      }

      if (result.status === 403 || result.status === 429 || result.status === 503) {
        return { html: null, status: result.status, cfBlocked: true };
      }

      const html = result.html;
      if (
        html.includes("잠시만 기다리십시오") ||
        html.includes("Just a moment") ||
        (result.status === 200 &&
          !html.includes("OrderSet") &&
          !html.includes("SellPrice") &&
          html.includes("G마켓"))
      ) {
        return { html, status: result.status, cfBlocked: true };
      }

      return { html, status: result.status, cfBlocked: false };
    } catch (e) {
      console.error(
        "[browser-fetch] fetch 실패:",
        e instanceof Error ? e.message : String(e),
      );
      return { html: null, status: 0, cfBlocked: false };
    }
  }

  private async closeContext(): Promise<void> {
    try {
      await this.page?.close();
    } catch {}
    try {
      await this.context?.close();
    } catch {}
    this.page = null;
    this.context = null;
  }

  async destroy(): Promise<void> {
    await this.closeContext();
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
    if (this.poolAcquired) {
      browserPool.release();
      this.poolAcquired = false;
    }
  }
}
