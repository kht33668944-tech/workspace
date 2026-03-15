import { chromium, type Browser, type BrowserContext } from "playwright";

const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
      "--disable-infobars",
      "--window-size=1920,1080",
      "--disable-extensions",
      "--disable-gpu",
    ],
  });
}

/**
 * Stealth 설정이 적용된 BrowserContext 생성
 * 봇 감지 우회를 위한 실제 브라우저 fingerprint 설정
 */
export async function createStealthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: CHROME_USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    extraHTTPHeaders: {
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  });

  await context.addInitScript(() => {
    // navigator.webdriver 제거
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // Chrome runtime 위장
    const win = window as Record<string, unknown>;
    win.chrome = {
      runtime: {},
      loadTimes: () => ({}),
      csi: () => ({}),
      app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" } },
    };

    // permissions 위장
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    Object.defineProperty(window.navigator.permissions, "query", {
      value: (parameters: { name: string }) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters),
    });

    // plugins 위장 (빈 배열이면 headless로 감지됨)
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    // languages 위장
    Object.defineProperty(navigator, "languages", {
      get: () => ["ko-KR", "ko", "en-US", "en"],
    });

    // WebGL vendor 위장
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
      if (parameter === 37445) return "Google Inc. (NVIDIA)";
      if (parameter === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650)";
      return getParameter.call(this, parameter);
    };
  });

  return context;
}
