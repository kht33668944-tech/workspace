import { NextRequest, NextResponse } from "next/server";
import type { BrowserContext, Page } from "playwright";
import { normalizeProductName as llmNormalizeProductName, classifyCategory } from "@/lib/gemini";
import { launchPatchedBrowser, createPatchedGmarketContext } from "@/lib/scrapers/browser";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { ensureLogin } from "@/lib/scrapers/gmarket-session";

export const maxDuration = 300;

interface ScrapeRequest {
  urls: string[];
  categories?: string[]; // 등록된 수수료 카테고리 목록 (자동 분류용)
}

export interface GmarketProductResult {
  url: string;
  product_name: string;
  price: number;
  category: string;       // G마켓 원본 브레드크럼 카테고리
  matched_category: string; // Gemini가 분류한 수수료 카테고리
  thumbnail_url: string | null;
  image_urls: string[];
  error?: string;
}

export type GmarketScrapeSSEEvent =
  | { type: "item_done"; result: GmarketProductResult; index: number; total: number }
  | { type: "done" }
  | { type: "error"; message: string };

/** 지마켓 상품명 정규화: 불필요한 접두사 / 괄호 텍스트 제거 */
function normalizeProductName(raw: string): string {
  let name = raw
    .replace(/^[Gg]마켓[-\s]*/g, "")
    .replace(/^지마켓[-\s]*/g, "")
    .replace(/[（(][^）)]*(?:할인|쿠폰|결제|적립|포인트)[^）)]*[）)]/g, "")
    .replace(/[（(][^）)]*(?:직영|공식|기획|한정)[^）)]*[）)]/g, "")
    .replace(/[（(][^）)]*(?:출고|발송|배송|랜덤|무라벨|유라벨)[^）)]*[）)]/g, "")
    .replace(/[（(][^）)]*\d+[^）)]*[x×][^）)]*\d+[^）)]*[）)]/g, "")
    .replace(/\(\d+박스\)/g, "")
    .replace(/\s*\([A-Z]\d+\)\s*$/g, "")
    .replace(/\s+-\s+\S.*$/, "")
    .replace(/\s+\/\S.*$/, "")
    .replace(/\s+(?![^/]*\d)[^\s/]+\/[^\s/]+$/, "")
    .replace(/G마켓베스트/gi, "");

  name = name.replace(/(\d+)입\s*\+\s*(\d+)입/g, (_, a, b) =>
    `${parseInt(a, 10) + parseInt(b, 10)}개`
  );
  name = name.replace(/(\d+)개\s*\+\s*(\d+)개/g, (_, a, b) =>
    `${parseInt(a, 10) + parseInt(b, 10)}개`
  );
  name = name.replace(/[x×]\s*(\d+(?:입|개|팩|캔|병|봉|개입|CAN|can|SET|set|EA|ea|PCS|pcs))/g, " $1");
  name = name.replace(/(\d+)\s*CAN\b/gi, "$1캔");
  name = name.replace(/(\d+)\s*EA\b/gi, "$1개");
  name = name.replace(/(\d+)\s*PCS?\b/gi, "$1개");
  name = name.replace(/(\d+)\s*SET\b/gi, "$1세트");
  name = name.replace(/(\d+)\s*BOX\b/gi, "$1박스");
  name = name.replace(/(\d+)\s*PACK?\b/gi, "$1팩");
  // 입 → 개 통일 (캔/병/봉/포/매 등 고유 단위는 유지)
  name = name.replace(/(\d+)\s*입\b/g, "$1개");
  name = name.replace(/(\d+)\s*개입\b/g, "$1개");

  if (/\d/.test(name)) {
    name = name.replace(/\s+[가-힣]+$/, "");
  }
  name = name.replace(/[()（）]/g, " ");
  name = name.replace(/[^\uAC00-\uD7A3\u3130-\u318F\uFFA0-\uFFDCa-zA-Z0-9\s]/g, " ");

  return name.replace(/\s{2,}/g, " ").trim();
}

/** 지마켓 이미지 URL을 최대 해상도(1000px)로 변환 */
function toHighResImageUrl(url: string): string {
  // 추가 이미지(moreimg)의 _NN.jpg는 인덱스이지 해상도가 아니므로 변환 금지(_1000.jpg는 404).
  // 고해상도는 이미 exlarge_moreimg 경로로 확보됨.
  if (url.includes("moreimg")) return url;
  if (/\/still\/\d+/.test(url)) {
    return url.replace(/(\/still\/)(\d+)/, "$11000");
  }
  if (/_\d{2,3}\.(jpg|jpeg|png|webp)/i.test(url)) {
    return url.replace(/_(\d{2,3})(\.(jpg|jpeg|png|webp))/i, "_1000$2");
  }
  return url;
}

/** 이미지를 fetch해서 Supabase Storage에 업로드, publicUrl 반환 */
async function uploadImageToStorage(
  imageUrl: string,
  storagePath: string,
  serviceClient: ReturnType<typeof getServiceSupabaseClient>
): Promise<string | null> {
  try {
    const finalUrl = imageUrl.startsWith("//")
      ? `https:${imageUrl}`
      : imageUrl;
    const res = await fetch(finalUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: "https://www.gmarket.co.kr/",
      },
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = await res.arrayBuffer();

    const { error } = await serviceClient.storage
      .from("product-images")
      .upload(storagePath, buffer, { contentType, upsert: true });

    if (error) {
      console.error("[gmarket-product] Storage upload error:", error.message);
      return null;
    }

    const { data } = serviceClient.storage.from("product-images").getPublicUrl(storagePath);
    return data.publicUrl;
  } catch (e) {
    console.error("[gmarket-product] Image upload failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * 봇 확인 인터스티셜("잠시만 기다리십시오")이 사라지고 실제 상품 DOM이 뜰 때까지 대기.
 * waitForFunction은 챌린지 통과 후 리로드(navigation)되어도 자동 재주입되어 견딘다.
 * 챌린지는 통과 시 보통 1.5~7초 내 끝나므로 12초면 충분. 그 이상이면 차단으로 간주(빠른 실패).
 */
async function waitForRealContent(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        !/잠시만 기다리/.test(document.title) &&
        !!document.querySelector('.box__price, .itemtit, meta[property="og:title"]'),
      { timeout: 12000 }
    )
    .catch(() => {});
}

/**
 * 단일 지마켓 상품 페이지 스크래핑.
 * context는 외부에서 주입 (로그인된 세션 재사용).
 */
async function scrapeGmarketProduct(
  url: string,
  userId: string,
  serviceClient: ReturnType<typeof getServiceSupabaseClient>,
  context: BrowserContext,
  categories: string[] = []
): Promise<GmarketProductResult> {
  const page = await context.newPage();

  try {
    // ⚠️ 리소스 차단(page.route abort) 미사용.
    // 실브라우저는 모든 리소스를 로드하므로, image/media/font를 abort하면
    // Cloudflare가 비정상 요청 지문으로 감지해 봇 챌린지를 띄운다(구매자동화는 차단 안 함).
    // 이미지 URL은 HTML 텍스트 정규식으로 추출하므로 차단 불필요.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 인간형 지연: 페이지 진입 후 바로 조작하지 않고 잠시 대기 (구매자동화 패턴)
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 2000));

    // 봇 확인 인터스티셜 리로드까지 견디며 실제 상품 DOM 대기
    await waitForRealContent(page);

    // 대기 후에도 여전히 봇 확인 페이지면 차단된 것 → 상위에서 컨텍스트 갱신 후 재시도
    const pageTitle = await page.title().catch(() => "");
    if (/잠시만 기다리|Just a moment/.test(pageTitle)) {
      await page.close().catch(() => {});
      return {
        url, product_name: "", price: 0, category: "", matched_category: "",
        thumbnail_url: null, image_urls: [], error: "bot_blocked",
      };
    }

    // ── DOM 데이터 한 번에 추출 (evaluate 1회) ─────────
    const extractDom = (): { rawName: string; category: string; rawPrice: number; rawImageUrls: string[] } => {
        // 상품명
        const ogTitle = document.querySelector<HTMLMetaElement>(
          'meta[property="og:title"]'
        )?.content?.trim();
        const docTitle = document.title.trim();
        let rawName = "";
        if (ogTitle && !ogTitle.endsWith("...")) {
          rawName = ogTitle;
        } else {
          const stripped = docTitle.replace(/^[Gg지]?마켓\s*[-–]\s*/i, "").trim();
          rawName = stripped || docTitle;
          for (const sel of [".itemtit", "#itemtit", ".item-tit", ".goods-name"]) {
            const el = document.querySelector(sel);
            if (el?.textContent?.trim()) { rawName = el.textContent.trim(); break; }
          }
        }

        // 카테고리 (브레드크럼)
        let category = "";
        const locationNavi = document.querySelector(".location-navi");
        if (locationNavi) {
          const crumbs = Array.from(locationNavi.querySelectorAll<HTMLAnchorElement>("li > a"))
            .map((a) => a.textContent?.trim() || "")
            .filter((t) => t && t !== "스타배송 홈" && t !== "G마켓 홈" && t !== "홈");
          if (crumbs.length > 0) category = crumbs[crumbs.length - 1];
        }
        if (!category) {
          for (const sel of [".sub_location a", ".item_location a", "#location a", ".location a"]) {
            const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(sel));
            const crumbs = links.map((a) => a.textContent?.trim() || "")
              .filter((t) => t && !t.includes("홈") && t.length < 30);
            if (crumbs.length > 0) { category = crumbs[crumbs.length - 1]; break; }
          }
        }

        // ── 가격 추출 (클럽쿠폰가 > 판매가) ──────────
        // 1순위: 클럽쿠폰가 (.price_innerwrap-coupon .price_real)
        let rawPrice = 0;
        const couponPriceEl = document.querySelector(".price_innerwrap-coupon .price_real");
        if (couponPriceEl?.textContent) {
          const n = parseInt(couponPriceEl.textContent.replace(/[^0-9]/g, ""), 10);
          if (n > 0) rawPrice = n;
        }
        // 2순위: 판매가 (.box__price strong.price_real)
        if (!rawPrice) {
          const salePriceEl = document.querySelector(".box__price strong.price_real");
          if (salePriceEl?.textContent) {
            const n = parseInt(salePriceEl.textContent.replace(/[^0-9]/g, ""), 10);
            if (n > 0) rawPrice = n;
          }
        }

        // 이미지 URL 수집.
        // 메인 대표 이미지(og:image / still)는 프로모션 배지가 이미지에 합성돼 있어 제외.
        // 추가 이미지(moreimg, _NN.jpg)만 수집 — 배지 없는 깨끗한 상품컷.
        // ⚠️ 갤러리 썸네일 <img>는 이미지 차단 시 src가 안 채워지므로 DOM 대신
        //    HTML 텍스트에서 정규식으로 추출 (JSON 이스케이프 \/ 도 복원).
        // URL 예: //gdimg1.gmarket.co.kr/goods_image2/shop_moreimg/462/802/{code}/{code}_00.jpg?ver=...
        // 변형(shop/middle/small/large/exlarge)은 CDN이 on-demand 생성 → 최고해상도 exlarge로 통일.
        const html = document.documentElement.outerHTML.replace(/\\\//g, "/");
        const re = /(?:https?:)?\/\/[^"'\s)\\]*?goods_image2\/[a-z]+_moreimg\/[^"'\s)\\]*?\.(?:jpg|jpeg|png|webp)/gi;
        const seen = new Set<string>();
        const collected: string[] = [];
        for (const m of html.match(re) || []) {
          let u = m.split("?")[0];
          if (u.startsWith("//")) u = "https:" + u; // 프로토콜 상대 URL 보정
          u = u.replace(/\/[a-z]+_moreimg\//i, "/exlarge_moreimg/"); // 고해상도 통일
          if (u.includes("icon") || u.includes("logo") || u.includes("btn") || u.includes("blank")) continue;
          if (!seen.has(u)) { seen.add(u); collected.push(u); }
        }
        collected.sort(); // _00, _01, _02 … 인덱스 순 (썸네일 = _00)
        // 추가 이미지가 하나도 없으면 썸네일이 비지 않도록 og:image(대표)라도 사용
        let rawImageUrls = collected;
        if (rawImageUrls.length === 0) {
          const ogImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
          if (ogImage) rawImageUrls = [ogImage];
        }
        return { rawName, category, rawPrice, rawImageUrls };
    };

    // 챌린지 리로드와 evaluate가 겹쳐 "Execution context was destroyed"가 나면 1회 재시도
    let extracted: { rawName: string; category: string; rawPrice: number; rawImageUrls: string[] };
    try {
      extracted = await page.evaluate(extractDom);
    } catch (e) {
      if (e instanceof Error && e.message.includes("Execution context was destroyed")) {
        await waitForRealContent(page);
        extracted = await page.evaluate(extractDom);
      } else {
        throw e;
      }
    }
    const { rawName, category, rawPrice, rawImageUrls } = extracted;

    await page.close(); // DOM 추출 완료 후 바로 닫기 (업로드 대기 불필요)

    // 상품명이 비면 상품 페이지가 아님(목록/카테고리 URL 등) → Gemini 호출 없이 실패 처리.
    // (빈 이름을 normalizeProductName에 넘기면 모델이 "…함수를 제공합니다" 메타 응답을 뱉어 가짜 상품이 생성됨)
    if (!rawName.trim()) {
      console.warn(`[gmarket-product] 상품명 추출 실패(상품 페이지 아님 추정): ${url.slice(0, 80)}`);
      return {
        url, product_name: "", price: 0, category: "", matched_category: "",
        thumbnail_url: null, image_urls: [], error: "not_a_product",
      };
    }

    const price = typeof rawPrice === "number" && rawPrice > 0 ? rawPrice : 0;
    console.log(`[gmarket-product] 가격추출: price=${price}, url=${url.slice(0, 80)}`);

    // ── LLM 호출 병렬화 + 이미지 업로드 동시 실행 ───────────
    const regexName = normalizeProductName(rawName);
    // 메인 썸네일 + 추가 이미지 3장 = 총 4장만 (순서대로, AI 미사용)
    const limitedImageUrls = rawImageUrls.slice(0, 4).map(toHighResImageUrl);
    const timestamp = Date.now();

    const VALID_IMG_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
    const [product_name, matched_category, uploadResults] = await Promise.all([
      llmNormalizeProductName(regexName, { callSource: "product_name_normalize", userId }).then((n) => n ?? regexName),
      classifyCategory(regexName, category, categories, "가공식품", { callSource: "category_classify", userId }),
      Promise.all(
        limitedImageUrls.map((imgUrl, idx) => {
          const rawExt = imgUrl.split("?")[0].split(".").pop()?.replace(/[^a-z]/gi, "")?.toLowerCase() || "";
          const ext = VALID_IMG_EXTS.has(rawExt) ? rawExt : "jpg";
          const storagePath = `products/${userId}/${timestamp}_${idx}.${ext}`;
          return uploadImageToStorage(imgUrl, storagePath, serviceClient);
        })
      ),
    ]);

    const uploaded = uploadResults.filter((u): u is string => u !== null);

    return {
      url,
      product_name,
      price,
      category,
      matched_category,
      thumbnail_url: uploaded[0] ?? null,
      image_urls: uploaded,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 페이지/컨텍스트가 닫힌 경우(사용자가 탭을 닫거나 컨텍스트 재생성 등)는
    // 빨간 실패 대신 봇차단과 동일하게 취급 → 새 컨텍스트로 조용히 재시도.
    const isClosed = /has been closed|Target (page|closed)|Execution context was destroyed/i.test(msg);
    console.error(`[gmarket-product] 스크래핑 실패 (${url}):`, msg);
    return {
      url,
      product_name: "",
      price: 0,
      category: "",
      matched_category: "",
      thumbnail_url: null,
      image_urls: [],
      error: isClosed ? "bot_blocked" : msg,
    };
  } finally {
    if (!page.isClosed()) await page.close();
  }
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "인증 실패" }, { status: 401 });
  }
  const userId = user.id;

  const body = (await request.json()) as ScrapeRequest;
  if (!body.urls || body.urls.length === 0) {
    return NextResponse.json({ error: "URL이 없습니다." }, { status: 400 });
  }

  const validUrls = body.urls.filter(
    (u) => typeof u === "string" && u.includes("gmarket.co.kr")
  );
  if (validUrls.length === 0) {
    return NextResponse.json({ error: "유효한 지마켓 URL이 없습니다." }, { status: 400 });
  }

  const serviceClient = getServiceSupabaseClient();
  const categories = Array.isArray(body.categories) ? body.categories : [];

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(event: GmarketScrapeSSEEvent) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // 스트림이 이미 닫힌 경우 무시
        }
      }

      await browserPool.acquire();
      const browser = await launchPatchedBrowser();
      let context = await createPatchedGmarketContext(browser);

      // 봇 확인 인터스티셜("잠시만 기다리십시오") 통과 준비:
      // 로그인 + 상품 페이지 워밍업으로 cf_clearance 쿠키를 컨텍스트에 확보.
      // (로그인된 세션이 챌린지 통과율을 크게 높임)
      async function prepareContext(ctx: BrowserContext) {
        await ensureLogin(ctx, userId);
        const warm = await ctx.newPage();
        try {
          await warm.goto("https://item.gmarket.co.kr/Item?goodscode=4628023357", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await warm
            .waitForFunction(() => !/잠시만 기다리/.test(document.title), { timeout: 12000 })
            .catch(() => {});
        } catch (e) {
          console.warn("[gmarket-product] 워밍업 실패(무시):", e instanceof Error ? e.message : String(e));
        } finally {
          await warm.close().catch(() => {});
        }
      }

      try {
        await prepareContext(context);

        // 순차 처리(1) + 인간형 지연으로 Cloudflare rate/behavior 챌린지 회피 (구매자동화 패턴)
        const CONCURRENCY = 1;
        const BOT_BLOCK_RESET_THRESHOLD = 3; // 봇감지 누적 시 컨텍스트 재생성
        let doneCount = 0;
        let ctxBotBlocks = 0;
        const retryUrls: string[] = [];

        // 1차 처리
        for (let i = 0; i < validUrls.length; i += CONCURRENCY) {
          if (request.signal.aborted) break;

          // 봇 감지가 누적되면 컨텍스트 재생성 + 재로그인 (새 세션으로 통과 시도)
          if (ctxBotBlocks >= BOT_BLOCK_RESET_THRESHOLD) {
            console.log(`[gmarket-product] 봇감지 ${ctxBotBlocks}회 → 컨텍스트 재생성`);
            await context.close().catch(() => {});
            context = await createPatchedGmarketContext(browser);
            await prepareContext(context);
            ctxBotBlocks = 0;
          }

          const batch = validUrls.slice(i, i + CONCURRENCY);
          const batchResults = await Promise.all(
            batch.map((url) =>
              scrapeGmarketProduct(url, userId, serviceClient, context, categories)
            )
          );

          batchResults.forEach((result) => {
            if (result.error === "bot_blocked") {
              ctxBotBlocks++;
              retryUrls.push(result.url); // 차단 항목은 새 컨텍스트로 재시도
            } else {
              send({ type: "item_done", result, index: doneCount++, total: validUrls.length });
            }
          });
        }

        // 봇 차단된 항목 재시도 (매 라운드 새 컨텍스트, 최대 2라운드)
        for (let round = 0; round < 2 && retryUrls.length > 0 && !request.signal.aborted; round++) {
          console.log(`[gmarket-product] 봇차단 재시도 라운드 ${round + 1}: ${retryUrls.length}건`);
          // 백오프: 곧바로 재시도하면 요청 폭증으로 차단이 악화되므로 잠시 대기 후 새 세션으로 진입
          await new Promise((r) => setTimeout(r, 8000 + Math.floor(Math.random() * 7000)));
          await context.close().catch(() => {});
          context = await createPatchedGmarketContext(browser);
          await prepareContext(context);

          const pending = retryUrls.splice(0);
          for (let i = 0; i < pending.length; i += CONCURRENCY) {
            if (request.signal.aborted) break;
            const batch = pending.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.all(
              batch.map((url) =>
                scrapeGmarketProduct(url, userId, serviceClient, context, categories)
              )
            );
            batchResults.forEach((result) => {
              if (result.error === "bot_blocked" && round < 1) {
                retryUrls.push(result.url); // 다음 라운드로
              } else {
                // 마지막 라운드까지 차단되면 error 그대로 전송 (UI에 실패 표시)
                send({ type: "item_done", result, index: doneCount++, total: validUrls.length });
              }
            });
          }
        }

        send({ type: "done" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[gmarket-product] 스트림 오류:", msg);
        send({ type: "error", message: msg });
      } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        browserPool.release();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
