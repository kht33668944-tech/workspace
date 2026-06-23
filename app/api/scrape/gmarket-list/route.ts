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
    .waitForSelector(".box__itemcard, .box__component-itemcard", { timeout: 15000 })
    .catch(() => {});
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(500);
  }

  return page.evaluate(() => {
    const seen = new Set<string>();
    const items: {
      goodscode: string;
      url: string;
      name: string;
      thumbnail: string;
      price: number;
    }[] = [];

    const cleanText = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();

    // 광고 카드 제외: box__category-ad / link__category-ad / 앵커의 data-montelena-acode
    // (실제 상품 카드 .box__itemcard는 data-montelena-acode가 div에만 있고 앵커엔 없음)
    const isAd = (a: HTMLAnchorElement, card: Element | null | undefined) =>
      /buyboxtype=ad/.test(a.href) ||
      a.className.includes("category-ad") ||
      a.hasAttribute("data-montelena-acode") ||
      !!(card && card.className.includes("category-ad"));

    // 상품명: .item_name에서 브랜드 배지(.box__brand)·접근성 텍스트를 제거한 순수 상품명.
    // (스타배송 카드는 img alt가 비어 있어 alt는 보조로만 사용)
    const pickName = (
      card: Element | null | undefined,
      a: HTMLAnchorElement,
      img: HTMLImageElement | null | undefined
    ): string => {
      const nameEl = card?.querySelector(
        '.item_name, [id^="itemCard_title"], [class*="itemcard-title"], [class*="text__item-title"]'
      );
      if (nameEl) {
        const clone = nameEl.cloneNode(true) as Element;
        clone.querySelectorAll(".box__brand, .for-a11y, .text__official").forEach((e) => e.remove());
        const t = cleanText(clone.textContent);
        if (t) return t;
      }
      const alt = cleanText(img?.getAttribute("alt"));
      if (alt && alt !== "광고") return alt;
      return cleanText(a.getAttribute("title") || a.getAttribute("aria-label"));
    };

    const pickThumb = (img: HTMLImageElement | null | undefined): string => {
      let t = img?.getAttribute("src") || img?.getAttribute("data-original") || img?.getAttribute("data-src") || "";
      if (t.startsWith("//")) t = "https:" + t;
      return t;
    };

    // 가격: 쿠폰적용가(할인 후)는 .box__price strong(=15,900). 원가는 box__price-original의 span이라 제외.
    // strong이 없는 구형 레이아웃은 .text__value로 보조.
    const pickPrice = (card: Element | null | undefined): number => {
      const el =
        card?.querySelector('.box__price strong, [class*="box__price"] strong') ||
        card?.querySelector('.text__value, [class*="text__value"]');
      return el?.textContent ? parseInt(el.textContent.replace(/[^0-9]/g, ""), 10) || 0 : 0;
    };

    const pushFromAnchor = (a: HTMLAnchorElement, card: Element | null | undefined) => {
      if (isAd(a, card)) return;
      const gc = (a.href.match(/goodscode=(\d+)/) || [])[1];
      if (!gc || seen.has(gc)) return;
      seen.add(gc);
      const img = card?.querySelector<HTMLImageElement>("img") ?? null;
      items.push({
        goodscode: gc,
        url: `https://item.gmarket.co.kr/Item?goodscode=${gc}`,
        name: pickName(card, a, img),
        thumbnail: pickThumb(img),
        price: pickPrice(card),
      });
    };

    // 1차: 상품 카드 컨테이너 (.box__itemcard = 스타배송/신규, .box__component-itemcard = 구형)
    for (const card of Array.from(document.querySelectorAll(".box__itemcard, .box__component-itemcard"))) {
      const a = card.querySelector<HTMLAnchorElement>('a[href*="goodscode="]');
      if (a) pushFromAnchor(a, card);
    }

    // 폴백: 0개면 페이지 전역 goodscode 링크 스캔
    if (items.length === 0) {
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="goodscode="]'))) {
        pushFromAnchor(a, a.closest(".box__itemcard, .box__component-itemcard, li, div") || a.parentElement);
      }
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
