import { NextRequest } from "next/server";
import type { BrowserContext, Cookie } from "playwright";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeProductName as llmNormalizeProductName, classifyCategory } from "@/lib/gemini";
import { launchBrowser, createGmarketContext } from "@/lib/scrapers/browser";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { decrypt } from "@/lib/crypto";
import { loadSession, saveSession } from "@/lib/scrapers/session-manager";

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

// ── G마켓 로그인 세션 캐시 (모듈 레벨 — 서버 프로세스 재시작 전까지 유지) ──────
let gmarketCookieCache: Cookie[] | null = null;
let gmarketCookieCachedAt = 0;
const COOKIE_TTL_MS = 4 * 60 * 60 * 1000; // 4시간

/** purchase_credentials 테이블에서 G마켓 계정 정보 조회 */
async function getGmarketCredential(): Promise<{ id: string; pw: string } | null> {
  try {
    const serviceClient = getServiceSupabaseClient();
    const { data } = await serviceClient
      .from("purchase_credentials")
      .select("login_id, login_pw_encrypted")
      .eq("platform", "gmarket")
      .limit(1)
      .single();

    if (!data?.login_id || !data.login_pw_encrypted) return null;
    const pw = decrypt(data.login_pw_encrypted);
    return { id: data.login_id, pw };
  } catch (e) {
    console.warn("[gmarket-login] 계정 조회 실패:", e);
    return null;
  }
}

/**
 * G마켓 로그인 수행.
 * gmarket-purchase.ts와 동일한 URL/selector 사용.
 */
async function loginToGmarket(context: BrowserContext): Promise<boolean> {
  const cred = await getGmarketCredential();
  if (!cred) {
    console.warn("[gmarket-login] 구매처 계정관리에 지마켓 계정이 없습니다 — 로그인 건너뜀");
    return false;
  }

  const page = await context.newPage();
  try {
    await page.goto("https://signinssl.gmarket.co.kr/login/login", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(1500 + Math.random() * 500);

    // 아이디 / 비밀번호 입력 (gmarket-purchase.ts와 동일 selector)
    const loginInput = page.getByPlaceholder("아이디");
    await loginInput.waitFor({ state: "visible", timeout: 30000 });
    await loginInput.fill(cred.id);
    await page.locator("#typeMemberInputPassword").fill(cred.pw);

    // 로그인 버튼 클릭 후 URL 변경 대기
    await Promise.all([
      page
        .waitForURL((url) => !url.toString().includes("login/login"), { timeout: 30000 })
        .catch(() => null),
      page.getByRole("button", { name: "로그인", exact: false }).first().click(),
    ]);

    await page.waitForTimeout(1500);

    const finalUrl = page.url();
    const success = !finalUrl.includes("login/login");
    console.log(`[gmarket-login] ${success ? "성공" : "실패"} — URL: ${finalUrl}`);
    return success;
  } catch (e) {
    console.error("[gmarket-login] 오류:", e);
    return false;
  } finally {
    await page.close();
  }
}

/**
 * G마켓 로그인 세션을 보장.
 * L1: 모듈 메모리 캐시 (4h)
 * L2: Supabase DB 세션 (24h, Railway 재시작 후에도 유효)
 * L3: 재로그인
 */
/** 실제 로그인 여부 확인 (지마켓 마이페이지 접근 시도) */
async function verifyLogin(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto("https://www.gmarket.co.kr", { waitUntil: "domcontentloaded", timeout: 15000 });
    const loggedIn = await page.evaluate(() => {
      // 로그아웃 버튼이 있으면 로그인 상태
      return !!document.querySelector(".link__logout, .btn-logout, [class*='logout']");
    }).catch(() => false);
    return loggedIn;
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

async function ensureGmarketLogin(
  context: BrowserContext,
  supabase: SupabaseClient,
  loginId: string
): Promise<void> {
  console.log(`[gmarket-login] ensureGmarketLogin 시작 (loginId: ${loginId || "없음"})`);
  const now = Date.now();

  // L1: 모듈 캐시 (프로세스 내, 4시간 유효)
  if (gmarketCookieCache && now - gmarketCookieCachedAt < COOKIE_TTL_MS) {
    await context.addCookies(gmarketCookieCache);
    if (await verifyLogin(context)) {
      console.log("[gmarket-login] L1 메모리 캐시 복원 ✅");
      return;
    }
    console.warn("[gmarket-login] L1 캐시 만료 → 재로그인 필요");
    gmarketCookieCache = null;
  }

  // L2: Supabase DB 세션
  if (loginId) {
    const dbCookies = await loadSession(supabase, "gmarket", loginId);
    if (dbCookies) {
      await context.addCookies(dbCookies);
      if (await verifyLogin(context)) {
        gmarketCookieCache = dbCookies;
        gmarketCookieCachedAt = now;
        console.log("[gmarket-login] L2 DB 세션 복원 ✅");
        return;
      }
      console.warn("[gmarket-login] L2 DB 세션 만료 → 재로그인 필요");
    }
  }

  // L3: 재로그인
  console.log("[gmarket-login] L3 재로그인 시도");
  const ok = await loginToGmarket(context);
  if (ok && await verifyLogin(context)) {
    const cookies = await context.cookies();
    gmarketCookieCache = cookies;
    gmarketCookieCachedAt = Date.now();
    console.log(`[gmarket-login] L3 재로그인 완료 ✅ (쿠키 ${cookies.length}개)`);
    if (loginId) {
      saveSession(supabase, "gmarket", loginId, cookies).catch((e) =>
        console.warn("[gmarket-login] DB 세션 저장 실패:", e)
      );
    }
  } else {
    console.error("[gmarket-login] ❌ 로그인 실패 — 비로그인 상태로 스크래핑 진행");
  }
}

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
    console.error("[gmarket-product] Image upload failed:", e);
    return null;
  }
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
    // 이미지·폰트·미디어 차단 → 페이지 로드 속도 개선
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 판매가 요소 대기 (서버렌더링이므로 빠르게 잡힘)
    await page.waitForSelector(".box__price strong.price_real", {
      timeout: 5000,
    }).catch(() => {});

    // ── DOM 데이터 한 번에 추출 (evaluate 1회) ─────────
    const { rawName, category, rawPrice, rawImageUrls } = await page.evaluate(
      (): { rawName: string; category: string; rawPrice: number; rawImageUrls: string[] } => {
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

        // 이미지 URL 수집 (실제 로딩은 route로 막았으므로 src 속성만 읽음)
        const urls = new Set<string>();
        const ogImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
        if (ogImage) urls.add(ogImage);
        for (const sel of [
          ".gallery img", ".item-photo img", ".itemphoto img",
          '[class*="gallery"] img', '[class*="photo"] img',
          '[class*="slide"] img', ".swiper-slide img",
          ".thumb-list img", ".thumbnail-list img", '[class*="thumb"] img',
        ]) {
          document.querySelectorAll<HTMLImageElement>(sel).forEach((img) => {
            const src = img.dataset.src || img.dataset.lazySrc || img.src;
            if (src && src.startsWith("http") && !src.includes("icon") && !src.includes("logo") && !src.includes("btn") && !src.includes("blank")) {
              urls.add(src);
            }
          });
        }
        return { rawName, category, rawPrice, rawImageUrls: Array.from(urls) };
      }
    );

    await page.close(); // DOM 추출 완료 후 바로 닫기 (업로드 대기 불필요)

    const price = typeof rawPrice === "number" && rawPrice > 0 ? rawPrice : 0;
    console.log(`[gmarket-product] 가격추출: price=${price}, url=${url.slice(0, 80)}`);

    // ── LLM 호출 병렬화 + 이미지 업로드 동시 실행 ───────────
    const regexName = normalizeProductName(rawName);
    const limitedImageUrls = rawImageUrls.slice(0, 3).map(toHighResImageUrl);
    const timestamp = Date.now();

    const VALID_IMG_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
    const [product_name, matched_category, uploadResults] = await Promise.all([
      llmNormalizeProductName(regexName).then((n) => n ?? regexName),
      classifyCategory(regexName, category, categories),
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
    console.error(`[gmarket-product] 스크래핑 실패 (${url}):`, msg);
    return {
      url,
      product_name: "",
      price: 0,
      category: "",
      matched_category: "",
      thumbnail_url: null,
      image_urls: [],
      error: msg,
    };
  } finally {
    if (!page.isClosed()) await page.close();
  }
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) {
    return new Response(JSON.stringify({ error: "인증 필요" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "인증 실패" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = (await request.json()) as ScrapeRequest;
  if (!body.urls || body.urls.length === 0) {
    return new Response(JSON.stringify({ error: "URL이 없습니다." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const validUrls = body.urls.filter(
    (u) => typeof u === "string" && u.includes("gmarket.co.kr")
  );
  if (validUrls.length === 0) {
    return new Response(JSON.stringify({ error: "유효한 지마켓 URL이 없습니다." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const serviceClient = getServiceSupabaseClient();
  const categories = Array.isArray(body.categories) ? body.categories : [];

  // 로그인 ID 미리 조회 (session-manager에 전달용)
  const cred = await getGmarketCredential();

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
      const browser = await launchBrowser();
      const context = await createGmarketContext(browser);

      try {
        await ensureGmarketLogin(context, supabase, cred?.id ?? "");

        const CONCURRENCY = 4;
        let doneCount = 0;

        for (let i = 0; i < validUrls.length; i += CONCURRENCY) {
          // 클라이언트가 연결을 끊었으면 중단
          if (request.signal.aborted) break;

          const batch = validUrls.slice(i, i + CONCURRENCY);
          const batchResults = await Promise.all(
            batch.map((url) =>
              scrapeGmarketProduct(url, user.id, serviceClient, context, categories)
            )
          );

          batchResults.forEach((result) => {
            send({ type: "item_done", result, index: doneCount++, total: validUrls.length });
          });
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
