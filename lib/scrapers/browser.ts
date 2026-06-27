import { chromium, type Browser, type BrowserContext } from "playwright";
import { chromium as patchedChromium } from "patchright";
import { execFile, execFileSync } from "child_process";

/**
 * G마켓 전용 BrowserContext 생성.
 * gmarket-purchase.ts와 동일한 방식 — extraHTTPHeaders 없이 브라우저 자체 헤더 사용.
 * Cloudflare가 커스텀 헤더와 실제 브라우저 헤더 불일치를 감지하는 것을 방지.
 */
export async function createGmarketContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1920, height: 1080 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  return context;
}

const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 환경변수 기반 브라우저 런치 팩토리
 * - BROWSER_HEADLESS: "false"면 headless 해제 (기본: true)
 * - BROWSER_CHANNEL: "chrome" 등 지정 시 시스템 브라우저 사용 (기본: Playwright 내장 Chromium)
 * - BROWSER_START_MINIMIZED: "false"면 headed 브라우저를 일반 창으로 시작 (기본: 최소화)
 */
function getHeadedWindowArgs(headless: boolean): string[] {
  if (headless) return [];
  if (process.env.BROWSER_START_MINIMIZED === "false") return [];
  return ["--start-minimized", "--window-position=-32000,-32000"];
}

function shouldStartMinimized(headless: boolean): boolean {
  return !headless && process.platform === "win32" && process.env.BROWSER_START_MINIMIZED !== "false";
}

function getBrowserProcessSnapshot(): Set<number> {
  if (process.platform !== "win32") return new Set();

  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name chrome,msedge,chromium -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
      ],
      { encoding: "utf8", windowsHide: true }
    );

    return new Set(
      output
        .split(/\s+/)
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v))
    );
  } catch {
    return new Set();
  }
}

function minimizeNewBrowserWindows(previousPids: Set<number>): void {
  if (process.platform !== "win32") return;

  const before = [...previousPids].join(",");
  const beforeArray = before ? `@(${before})` : "@()";
  const script = `
$before = ${beforeArray}
$targets = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @("chrome.exe", "msedge.exe", "chromium.exe") -and
  $before -notcontains $_.ProcessId -and
  $_.CommandLine -match "playwright_|remote-debugging-pipe|ms-playwright"
} | Select-Object -ExpandProperty ProcessId)
if ($targets.Count -eq 0) { exit 0 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WindowTools {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
  [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
[WindowTools]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ([WindowTools]::IsWindowVisible($hWnd)) {
    [uint32]$windowPid = 0
    [void][WindowTools]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
    if ($targets -contains [int]$windowPid) {
      $placement = New-Object WindowTools+WINDOWPLACEMENT
      $placement.length = [Runtime.InteropServices.Marshal]::SizeOf([type][WindowTools+WINDOWPLACEMENT])
      [void][WindowTools]::GetWindowPlacement($hWnd, [ref]$placement)
      $placement.showCmd = 2
      $placement.rcNormalPosition.left = 80
      $placement.rcNormalPosition.top = 60
      $placement.rcNormalPosition.right = 1600
      $placement.rcNormalPosition.bottom = 980
      [void][WindowTools]::SetWindowPlacement($hWnd, [ref]$placement)
      [void][WindowTools]::ShowWindowAsync($hWnd, 6)
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
`;

  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true },
    () => {}
  );
}

function scheduleMinimizeNewBrowserWindows(previousPids: Set<number>, headless: boolean): void {
  if (!shouldStartMinimized(headless)) return;
  for (const delay of [150, 500, 1200, 2500, 5000]) {
    setTimeout(() => minimizeNewBrowserWindows(previousPids), delay).unref();
  }
}

export async function launchBrowser(): Promise<Browser> {
  const headless = process.env.BROWSER_HEADLESS !== "false";
  const channel = process.env.BROWSER_CHANNEL || undefined;
  const previousPids = shouldStartMinimized(headless) ? getBrowserProcessSnapshot() : new Set<number>();

  const browser = await chromium.launch({
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
      ...getHeadedWindowArgs(headless),
    ],
  });
  scheduleMinimizeNewBrowserWindows(previousPids, headless);
  return browser;
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
    const win = window as unknown as Record<string, unknown>;
    win.chrome = {
      runtime: {},
      loadTimes: () => ({}),
      csi: () => ({}),
      app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" } },
    };

    // permissions 위장
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    Object.defineProperty(window.navigator.permissions, "query", {
      value: (parameters: PermissionDescriptor) =>
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

    // WebGL vendor 위장 (WebGL1 + WebGL2)
    function patchWebGL(proto: { getParameter: (p: number) => unknown }) {
      const orig = proto.getParameter;
      proto.getParameter = function (parameter: number) {
        if (parameter === 37445) return "Google Inc. (NVIDIA)";
        if (parameter === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650)";
        return orig.call(this, parameter);
      };
    }
    patchWebGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== "undefined") {
      patchWebGL(WebGL2RenderingContext.prototype);
    }
  });

  return context;
}

/**
 * Patchright 기반 브라우저 런치 (Cloudflare/봇 감지 우회 강화)
 * - patchright는 CDP Runtime.Enable 등 자동화 시그널을 패치한 playwright 호환 fork
 * - launchBrowser와 달리 --disable-blink-features=AutomationControlled 등은 빼야 함
 *   (오히려 봇 감지 트리거 가능 - rebrowser/patchright 권장사항)
 */
export async function launchPatchedBrowser(): Promise<Browser> {
  const headless = process.env.BROWSER_HEADLESS !== "false";
  const channel = process.env.BROWSER_CHANNEL || undefined;
  const previousPids = shouldStartMinimized(headless) ? getBrowserProcessSnapshot() : new Set<number>();

  const browser = await patchedChromium.launch({
    headless,
    ...(channel && { channel }),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1920,1080",
      ...getHeadedWindowArgs(headless),
    ],
  }) as unknown as Browser;
  scheduleMinimizeNewBrowserWindows(previousPids, headless);
  return browser;
}

/**
 * Patchright + Stealth 적용 G마켓 전용 BrowserContext
 * patchright가 자체적으로 webdriver/plugins/languages 등 stealth 처리.
 * extraHTTPHeaders는 cloudflare가 실제 브라우저 헤더와의 불일치를 감지하므로 제외.
 */
export async function createPatchedGmarketContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1920, height: 1080 },
  });

  return context;
}
