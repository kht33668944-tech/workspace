import { chromium, type Browser, type BrowserContext } from "playwright";

/**
 * 환경변수 기반 브라우저 런치 팩토리
 * - BROWSER_HEADLESS: "false"면 headless 해제 (기본: true)
 * - BROWSER_CHANNEL: "chrome" 등 지정 시 시스템 브라우저 사용 (기본: Playwright 내장 Chromium)
 */
export async function launchBrowser(): Promise<Browser> {
  const headless = process.env.BROWSER_HEADLESS !== "false";
  const channel = process.env.BROWSER_CHANNEL || undefined;

  return chromium.launch({
    headless,
    ...(channel && { channel }),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
}

/**
 * Stealth 설정이 적용된 BrowserContext 생성
 */
export async function createStealthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  return context;
}
