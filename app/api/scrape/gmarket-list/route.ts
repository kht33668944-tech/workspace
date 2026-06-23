import { NextRequest, NextResponse } from "next/server";
import type { BrowserContext, Page } from "playwright";
import { launchPatchedBrowser, createPatchedGmarketContext } from "@/lib/scrapers/browser";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { ensureLogin } from "@/lib/scrapers/gmarket-session";

export const maxDuration = 120;

interface ListRequest {
  url: string;
}

export interface GmarketListItem {
  goodscode: string;
  url: string;        // 정규화된 item URL (추적 파라미터 제거)
  name: string;       // 원본 목록 상품명 (정규화는 상세 단계에서)
  thumbnail: string;
  price: number;      // 목록 표시가 (참고용)
}

/** 목록 페이지에서 상품 카드 추출 (광고 제외, goodscode 기준 중복 제거) */
async function extractListItems(page: Page): Promise<GmarketListItem[]> {
  // lazy 로딩 대비: 카드가 보일 때까지 대기 후 몇 번 스크롤
  await page
    .waitForSelector(".box__component-itemcard", { timeout: 15000 })
    .catch(() => {});
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(500);
  }

  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".box__component-itemcard"));
    const seen = new Set<string>();
    const items: {
      goodscode: string;
      url: string;
      name: string;
      thumbnail: string;
      price: number;
    }[] = [];

    for (const card of cards) {
      const a = card.querySelector<HTMLAnchorElement>('a.link__item[href*="goodscode"]');
      if (!a) continue;
      const href = a.href;
      if (/buyboxtype=ad/.test(href)) continue; // 광고 제외

      const gc = (href.match(/goodscode=(\d+)/) || [])[1];
      if (!gc || seen.has(gc)) continue;
      seen.add(gc);

      // 상품명: 목록 텍스트 영역 우선, 없으면 링크 텍스트
      const nameEl = card.querySelector(
        '[class*="text__item"], .text__item, [class*="itemcard-title"]'
      );
      const name = (nameEl?.textContent || a.textContent || "").trim();

      // 썸네일: img src (프로토콜 상대 URL 보정)
      const img = card.querySelector<HTMLImageElement>("img");
      let thumbnail = img?.getAttribute("src") || img?.getAttribute("data-original") || "";
      if (thumbnail.startsWith("//")) thumbnail = "https:" + thumbnail;

      // 목록 표시가
      const priceEl = card.querySelector(
        '[class*="text__value"], .text__value, [class*="box__price"] strong'
      );
      const price = priceEl?.textContent
        ? parseInt(priceEl.textContent.replace(/[^0-9]/g, ""), 10) || 0
        : 0;

      items.push({
        goodscode: gc,
        url: `https://item.gmarket.co.kr/Item?goodscode=${gc}`,
        name,
        thumbnail,
        price,
      });
    }
    return items;
  });
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  const supabase = getSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "인증 실패" }, { status: 401 });
  }
  const userId = user.id;

  const body = (await request.json()) as ListRequest;
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url || !url.includes("gmarket.co.kr")) {
    return NextResponse.json({ error: "유효한 지마켓 목록 URL이 없습니다." }, { status: 400 });
  }

  await browserPool.acquire();
  const browser = await launchPatchedBrowser();
  const context: BrowserContext = await createPatchedGmarketContext(browser);

  try {
    // 로그인된 세션이 클럽쿠폰가 노출 + 봇 챌린지 통과율을 높임
    await ensureLogin(context, userId);

    const page = await context.newPage();
    // 이미지·폰트·미디어 차단 → 로드 속도 개선 (img src 속성은 차단돼도 DOM에 남음)
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) route.abort();
      else route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 봇 확인 인터스티셜 통과 대기
    await page
      .waitForFunction(() => !/잠시만 기다리|Just a moment/.test(document.title), { timeout: 12000 })
      .catch(() => {});

    const pageTitle = await page.title().catch(() => "");
    if (/잠시만 기다리|Just a moment/.test(pageTitle)) {
      await page.close().catch(() => {});
      return NextResponse.json(
        { error: "지마켓 봇 차단으로 목록을 불러오지 못했습니다. 잠시 후 다시 시도하세요." },
        { status: 502 }
      );
    }

    const items = await extractListItems(page);
    await page.close().catch(() => {});

    console.log(`[gmarket-list] ${items.length}개 상품 추출 (url=${url.slice(0, 80)})`);
    return NextResponse.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[gmarket-list] 목록 스크랩 실패:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    browserPool.release();
  }
}
