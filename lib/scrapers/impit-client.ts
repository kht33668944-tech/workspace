import { Impit } from "impit";

export interface ImpitFetchResult {
  html: string | null;
  status: number;
  cfBlocked: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const randomDelay = (min: number, max: number) => Math.floor(Math.random() * (max - min)) + min;

const DELAY_MIN_MS = 300;
const DELAY_MAX_MS = 1200;
const RECREATE_EVERY = 5;
const CF_COOLDOWN_MS = 25000;
const CF_BLOCK_THRESHOLD = 2;

export class GmarketImpitClient {
  private impit: Impit;
  private requestCount = 0;
  private consecutiveBlocks = 0;
  private onCooldown?: (seconds: number) => void;

  constructor(opts?: { onCooldown?: (seconds: number) => void }) {
    this.impit = new Impit({ browser: "chrome" });
    this.onCooldown = opts?.onCooldown;
  }

  private recreate() {
    this.impit = new Impit({ browser: "chrome" });
    this.requestCount = 0;
  }

  async fetchProductPage(url: string): Promise<ImpitFetchResult> {
    // CF 연속 차단 감지 → 쿨다운 후 인스턴스 재생성
    if (this.consecutiveBlocks >= CF_BLOCK_THRESHOLD) {
      const sec = Math.round(CF_COOLDOWN_MS / 1000);
      console.log(`[impit-client] CF 연속 ${this.consecutiveBlocks}회 차단 → ${sec}초 쿨다운`);
      this.onCooldown?.(sec);
      await sleep(CF_COOLDOWN_MS);
      this.recreate();
      this.consecutiveBlocks = 0;
    }

    if (this.requestCount > 0 && this.requestCount % RECREATE_EVERY === 0) {
      this.recreate();
    }

    await sleep(randomDelay(DELAY_MIN_MS, DELAY_MAX_MS));

    try {
      this.requestCount++;
      const res = await this.impit.fetch(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          Referer: "https://www.gmarket.co.kr/",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-site",
          "Upgrade-Insecure-Requests": "1",
        },
        redirect: "follow",
      });

      const status = res.status;
      if (status === 403 || status === 429 || status === 503) {
        this.consecutiveBlocks++;
        return { html: null, status, cfBlocked: true };
      }

      const html = await res.text();

      if (
        html.includes("잠시만 기다리십시오") ||
        html.includes("Just a moment") ||
        (status === 200 && !html.includes("OrderSet") && !html.includes("SellPrice") && html.includes("G마켓"))
      ) {
        this.consecutiveBlocks++;
        return { html, status, cfBlocked: true };
      }

      this.consecutiveBlocks = 0;
      return { html, status, cfBlocked: false };
    } catch (e) {
      console.error("[impit-client] fetch 실패:", e instanceof Error ? e.message : String(e));
      return { html: null, status: 0, cfBlocked: false };
    }
  }

  destroy() {
    // impit has no explicit close — GC handles cleanup
  }
}
