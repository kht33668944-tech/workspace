import { NextRequest, NextResponse } from "next/server";
import { launchBrowser, createStealthContext } from "@/lib/scrapers/browser";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";

export const maxDuration = 300;

interface ScrapeRequest {
  urls: string[];
}

export interface GmarketProductResult {
  url: string;
  product_name: string;
  price: number;
  category: string;
  thumbnail_url: string | null;
  image_urls: string[];
  error?: string;
}

/** 지마켓 상품명 정규화: 불필요한 접두사 / 괄호 텍스트 제거 */
function normalizeProductName(raw: string): string {
  let name = raw
    // "G마켓-", "지마켓-" 접두사 제거
    .replace(/^[Gg]마켓[-\s]*/g, "")
    .replace(/^지마켓[-\s]*/g, "")
    // 할인/결제 관련 괄호 — ASCII `()` + 전각 `（）` 모두 대응
    .replace(/[（(][^）)]*(?:할인|쿠폰|결제|적립|포인트)[^）)]*[）)]/g, "")
    // 직영/공식/기획 괄호
    .replace(/[（(][^）)]*(?:직영|공식|기획|한정)[^）)]*[）)]/g, "")
    // 출고/배송/랜덤/무라벨 관련 괄호: (유라벨/무라벨 랜덤출고), (무료배송) 등
    .replace(/[（(][^）)]*(?:출고|발송|배송|랜덤|무라벨|유라벨)[^）)]*[）)]/g, "")
    // (N박스) 묶음 수량 괄호 제거
    .replace(/\(\d+박스\)/g, "")
    // Gmarket 내부 태그 제거: (N4), (A1) 등 말미의 대문자+숫자 괄호
    .replace(/\s*\([A-Z]\d+\)\s*$/g, "")
    // " - [추가 설명]" 후미 제거
    .replace(/\s+-\s+\S.*$/, "")
    // 판매자 배송/카테고리 주석: " /생수전문배송", " /이온음료" 등 공백+슬래시로 시작하는 후미
    .replace(/\s+\/\S.*$/, "")
    // 판매자 브랜드-카테고리 경로: 말미 "단어/단어" 형식 제거 (예: "포카리스웨트/이온음료")
    // 단, 크기 범위 "300ml/500ml" 같은 숫자 포함 패턴은 제외
    .replace(/\s+(?![^/]*\d)[^\s/]+\/[^\s/]+$/, "")
    // "G마켓베스트" 텍스트
    .replace(/G마켓베스트/gi, "");

  // "N입+M입" → 합산: 24입+24입 → 48입
  name = name.replace(/(\d+)입\s*\+\s*(\d+)입/g, (_, a, b) =>
    `${parseInt(a, 10) + parseInt(b, 10)}입`
  );
  // "N개+M개" → 합산
  name = name.replace(/(\d+)개\s*\+\s*(\d+)개/g, (_, a, b) =>
    `${parseInt(a, 10) + parseInt(b, 10)}개`
  );

  // "x N입" / "× N입" / "x 48CAN" 등 — 곱하기 기호 제거, 앞 공백 삽입
  name = name.replace(/[x×]\s*(\d+(?:입|개|팩|캔|병|봉|개입|CAN|can|SET|set|EA|ea|PCS|pcs))/g, " $1");

  // 영어 수량 단위 → 한국어 변환 (대소문자 무관)
  name = name.replace(/(\d+)\s*CAN\b/gi, "$1캔");
  name = name.replace(/(\d+)\s*EA\b/gi, "$1개");
  name = name.replace(/(\d+)\s*PCS?\b/gi, "$1개");
  name = name.replace(/(\d+)\s*SET\b/gi, "$1세트");
  name = name.replace(/(\d+)\s*BOX\b/gi, "$1박스");
  name = name.replace(/(\d+)\s*PACK?\b/gi, "$1팩");

  // 말미에 숫자 없는 순수 한글 단어가 오면 판매자 추가 브랜드/카테고리로 간주하고 제거
  // (예: "포카리스웨트 340ml 48CAN 동아오츠카" → "포카리스웨트 340ml 48CAN")
  // 단, 상품명 전체가 한글인 경우 제거하지 않도록 앞에 숫자 포함 내용 있어야 함
  if (/\d/.test(name)) {
    name = name.replace(/\s+[가-힣]+$/, "");
  }

  return name.replace(/\s{2,}/g, " ").trim();
}

/** URL 파라미터에서 쿠폰가 추출 (utparam-url JSON 파싱) */
function extractCouponPriceFromUrl(url: string): number | null {
  try {
    const match = url.match(/utparam-url=([^&]+)/);
    if (!match) return null;
    const json = JSON.parse(decodeURIComponent(match[1])) as Record<string, string>;
    const couponPrice = json["coupon_price"];
    if (couponPrice) return parseInt(couponPrice, 10);
  } catch {
    // ignore
  }
  return null;
}

/** 지마켓 이미지 URL을 최대 해상도(1000px)로 변환 */
function toHighResImageUrl(url: string): string {
  // 패턴 1: /still/300? → /still/1000?
  if (/\/still\/\d+/.test(url)) {
    return url.replace(/(\/still\/)(\d+)/, "$11000");
  }
  // 패턴 2: _300.jpg → _1000.jpg (크기 suffix)
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
    const res = await fetch(imageUrl, {
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
      .upload(storagePath, buffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.error("[gmarket-product] Storage upload error:", error.message);
      return null;
    }

    const { data } = serviceClient.storage
      .from("product-images")
      .getPublicUrl(storagePath);

    return data.publicUrl;
  } catch (e) {
    console.error("[gmarket-product] Image upload failed:", e);
    return null;
  }
}

/** 단일 지마켓 상품 페이지 스크래핑 */
async function scrapeGmarketProduct(
  url: string,
  userId: string,
  serviceClient: ReturnType<typeof getServiceSupabaseClient>
): Promise<GmarketProductResult> {
  const browser = await launchBrowser();
  const context = await createStealthContext(browser);
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    // ── 상품명 추출 ──────────────────────────────────────────
    const rawName = await page.evaluate((): string => {
      // 1순위: og:title — 단, 지마켓은 29자로 잘라 "..."을 붙이므로 잘린 경우 제외
      const ogTitle = document.querySelector<HTMLMetaElement>(
        'meta[property="og:title"]'
      )?.content?.trim();
      if (ogTitle && !ogTitle.endsWith("...")) return ogTitle;

      // 2순위: document.title — 전체 상품명 포함 ("G마켓 - [상품명]" 형식)
      const docTitle = document.title.trim();
      if (docTitle) {
        // "G마켓 - " 또는 "지마켓 - " 접두사 제거
        const stripped = docTitle.replace(/^[Gg지]?마켓\s*[-–]\s*/i, "").trim();
        if (stripped && stripped !== docTitle) return stripped;
      }

      // 3순위: 상품명 전용 DOM 요소
      const selectors = [
        ".itemtit",
        "#itemtit",
        ".item-tit",
        ".goods-name",
        'h1[class*="tit"]',
        'h2[class*="tit"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }

      return ogTitle ?? docTitle;
    });

    const product_name = normalizeProductName(rawName);

    // ── 카테고리 추출 (브레드크럼) ────────────────────────────
    const category = await page.evaluate((): string => {
      // 1순위: item.gmarket.co.kr — .location-navi li > a
      const locationNavi = document.querySelector(".location-navi");
      if (locationNavi) {
        const links = Array.from(locationNavi.querySelectorAll<HTMLAnchorElement>("li > a"));
        const crumbs = links
          .map((a) => a.textContent?.trim() || "")
          .filter((t) => t && t !== "스타배송 홈" && t !== "G마켓 홈" && t !== "홈");
        if (crumbs.length > 0) return crumbs[crumbs.length - 1];
      }

      // 2순위: 일반 지마켓 카테고리 영역
      const catSelectors = [
        ".sub_location a",
        ".item_location a",
        "#location a",
        ".location a",
        '[class*="location"] a',
      ];
      for (const sel of catSelectors) {
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(sel));
        const crumbs = links
          .map((a) => a.textContent?.trim() || "")
          .filter((t) => t && !t.includes("홈") && t.length < 30);
        if (crumbs.length > 0) return crumbs[crumbs.length - 1];
      }

      return "";
    });

    // ── 가격 추출 (URL 파라미터 우선 → 페이지 파싱) ──────────
    const urlCouponPrice = extractCouponPriceFromUrl(url);
    const price = urlCouponPrice ?? await page.evaluate((): number => {
      // 쿠폰 적용가를 감싸는 요소 탐색
      const allText = Array.from(document.querySelectorAll("*"));

      // "쿠폰적용가" 또는 "쿠폰" 라벨과 인접한 가격 요소 탐색
      for (const el of allText) {
        const text = el.textContent || "";
        if (
          text.includes("쿠폰적용가") ||
          (text.includes("쿠폰") && text.includes("원") && el.children.length < 5)
        ) {
          // 숫자만 추출
          const match = text.match(/쿠폰[^0-9]*([0-9,]+)\s*원/);
          if (match) {
            return parseInt(match[1].replace(/,/g, ""), 10);
          }
        }
      }

      // 쿠폰가 없으면 메인 판매가
      const priceSelectors = [
        ".price-real",
        ".selling-price",
        ".item-price",
        '[class*="price"] strong',
        ".price strong",
      ];
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el?.textContent) {
          const n = parseInt(el.textContent.replace(/[^0-9]/g, ""), 10);
          if (n > 0) return n;
        }
      }

      // og:description에서 가격 추출 시도
      const desc =
        document.querySelector<HTMLMetaElement>(
          'meta[property="og:description"]'
        )?.content || "";
      const match = desc.match(/([0-9,]+)\s*원/);
      if (match) return parseInt(match[1].replace(/,/g, ""), 10);

      return 0;
    });

    // ── 이미지 추출 ──────────────────────────────────────────
    // (urlCouponPrice가 있으면 page.evaluate price는 건너뜀 — 타입 만족용 fallback)
    const rawImageUrls = await page.evaluate((): string[] => {
      const urls = new Set<string>();

      // 1. og:image (대표 이미지)
      const ogImage = document.querySelector<HTMLMetaElement>(
        'meta[property="og:image"]'
      )?.content;
      if (ogImage) urls.add(ogImage);

      // 2. 메인 이미지 갤러리 영역
      const gallerySelectors = [
        ".gallery img",
        ".item-photo img",
        ".itemphoto img",
        ".product-image img",
        '[class*="gallery"] img',
        '[class*="photo"] img',
        '[class*="slide"] img',
        ".swiper-slide img",
      ];
      for (const sel of gallerySelectors) {
        document.querySelectorAll<HTMLImageElement>(sel).forEach((img) => {
          const src = img.dataset.src || img.dataset.lazySrc || img.src;
          if (src && src.startsWith("http") && !src.includes("icon") && !src.includes("logo")) {
            urls.add(src);
          }
        });
      }

      // 3. 썸네일 리스트
      const thumbSelectors = [
        ".thumb-list img",
        ".thumbnail-list img",
        '[class*="thumb"] img',
      ];
      for (const sel of thumbSelectors) {
        document.querySelectorAll<HTMLImageElement>(sel).forEach((img) => {
          const src = img.dataset.src || img.dataset.lazySrc || img.src;
          if (src && src.startsWith("http")) urls.add(src);
        });
      }

      return Array.from(urls).filter((u) => {
        // 너무 작은 이미지(아이콘류) URL 필터링
        return (
          !u.includes("icon") &&
          !u.includes("logo") &&
          !u.includes("btn") &&
          !u.includes("blank")
        );
      });
    });

    // 최대 20장 제한, 고해상도(1000px) URL로 변환
    const limitedImageUrls = rawImageUrls
      .slice(0, 20)
      .map(toHighResImageUrl);

    // ── Supabase Storage 업로드 ───────────────────────────────
    const timestamp = Date.now();
    const uploadResults = await Promise.all(
      limitedImageUrls.map((imgUrl, idx) => {
        const ext = imgUrl.split("?")[0].split(".").pop()?.replace(/[^a-z]/gi, "") || "jpg";
        const path = `products/${userId}/${timestamp}_${idx}.${ext}`;
        return uploadImageToStorage(imgUrl, path, serviceClient);
      })
    );

    const uploaded = uploadResults.filter((u): u is string => u !== null);

    return {
      url,
      product_name,
      price,
      category,
      thumbnail_url: uploaded[0] ?? null,
      image_urls: uploaded,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[gmarket-product] 스크래핑 실패 (${url}):`, msg);
    return {
      url,
      product_name: "",
      price: 0,
      category: "",
      thumbnail_url: null,
      image_urls: [],
      error: msg,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function POST(request: NextRequest) {
  // 인증
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

  const body = (await request.json()) as ScrapeRequest;
  if (!body.urls || body.urls.length === 0) {
    return NextResponse.json({ error: "URL이 없습니다." }, { status: 400 });
  }

  const validUrls = body.urls.filter(
    (u) => typeof u === "string" && u.includes("gmarket.co.kr")
  );
  if (validUrls.length === 0) {
    return NextResponse.json(
      { error: "유효한 지마켓 URL이 없습니다." },
      { status: 400 }
    );
  }

  const serviceClient = getServiceSupabaseClient();

  await browserPool.acquire();
  try {
    // URL 순차 처리 (브라우저 메모리 절약)
    const results: GmarketProductResult[] = [];
    for (const url of validUrls) {
      const result = await scrapeGmarketProduct(url, user.id, serviceClient);
      results.push(result);
    }

    return NextResponse.json({ results });
  } finally {
    browserPool.release();
  }
}
