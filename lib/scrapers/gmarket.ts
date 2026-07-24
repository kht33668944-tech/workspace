import { launchBrowser, createStealthContext, keepContextInBackground } from "./browser";
import { normalizeCourier } from "./constants";
import type {
  GmarketOrderResponse,
  ScrapeResult,
} from "./types";

const LOGIN_URL = "https://signinssl.gmarket.co.kr/login/login";
const TRACKING_URL = "https://tracking.gmarket.co.kr/track";
const TIMEOUT_NAV = 60000;
const TIMEOUT_LOGIN = 30000;
const TIMEOUT_API = 30000;
const TIMEOUT_TRACKING = 10000;
// 배송수집 대상은 최근 주문이라 앞쪽 페이지에 있음. 못 찾은 주문 탐색 상한(1페이지=5건).
// 찾는 주문을 다 찾으면 그 전에 멈추므로, 이 값은 "미발견 주문을 몇 페이지까지 뒤질지"만 결정.
const MAX_PAGES = 20;

type StealthContext = Awaited<ReturnType<typeof createStealthContext>>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 지마켓 paging API를 재시도와 함께 요청.
 * ECONNRESET 등 연결 리셋(봇 차단)·HTTP 오류를 지수 백오프로 재시도.
 * 반환: 번들 배열 | null(빈 페이지=데이터 끝) | "error"(재시도 소진 후에도 실패 → 이 페이지만 건너뜀)
 */
async function fetchPageWithRetry(
  context: StealthContext,
  url: string,
  headers: Record<string, string>,
  pageNo: number,
  maxRetries = 3
): Promise<GmarketOrderResponse["data"]["payBundleList"] | null | "error"> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const apiRes = await context.request.get(url, { headers });
      if (!apiRes.ok()) {
        console.log(`[gmarket] 페이지 ${pageNo}: HTTP ${apiRes.status()} (시도 ${attempt}/${maxRetries})`);
        if (attempt < maxRetries) { await sleep(500 * 2 ** (attempt - 1)); continue; }
        return "error";
      }
      const pageData = await apiRes.json() as GmarketOrderResponse;
      if (!pageData.data?.payBundleList?.length) return null;
      console.log(`[gmarket] 페이지 ${pageNo}: bundles=${pageData.data.payBundleList.length}`);
      return pageData.data.payBundleList;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[gmarket] 페이지 ${pageNo}: 네트워크 오류 ${msg} (시도 ${attempt}/${maxRetries})`);
      if (attempt < maxRetries) { await sleep(500 * 2 ** (attempt - 1)); continue; }
      return "error";
    }
  }
  return "error";
}

/**
 * Playwright 기반 지마켓 배송정보 일괄 수집
 * 1. Chromium으로 로그인
 * 2. 브라우저 컨텍스트에서 API 호출 (Cloudflare 우회)
 * 3. 배송 추적 페이지에서 택배사 정보 추출
 */
export async function collectGmarketTracking(
  loginId: string,
  loginPw: string,
  orderNos: string[],
  abortSignal?: AbortSignal
): Promise<ScrapeResult> {
  const result: ScrapeResult = { success: [], failed: [], notFound: [] };

  const browser = await launchBrowser();
  const context = await createStealthContext(browser);
  keepContextInBackground(context);
  const page = await context.newPage();
  keepContextInBackground(context);

  try {
    // 1. 로그인
    console.log("[gmarket] 로그인 중...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: TIMEOUT_NAV });
    keepContextInBackground(context);

    const loginInput = page.getByPlaceholder("아이디");
    await loginInput.waitFor({ state: "visible", timeout: TIMEOUT_LOGIN });
    await loginInput.fill(loginId);
    await page.locator("#typeMemberInputPassword").fill(loginPw);

    await Promise.all([
      page.waitForURL((url) => !url.toString().includes("login/login"), { timeout: TIMEOUT_LOGIN }).catch(() => null),
      page.getByRole("button", { name: "로그인", exact: false }).first().click(),
    ]);

    await page.waitForTimeout(3000);
    const cookies = await context.cookies();
    const hasUserInfo = cookies.some((c: { name: string }) => c.name === "user_info" || c.name === "user%5Finfo");

    if (!hasUserInfo && page.url().includes("login")) {
      const hasCaptcha = await page.locator('[id*="captcha"], [class*="captcha"]').count() > 0;
      await browser.close();
      return {
        success: [],
        failed: orderNos.map(no => ({ orderNo: no, reason: hasCaptcha ? "캡차 인증이 필요합니다" : "로그인 실패: 아이디/비밀번호 확인" })),
        notFound: [],
      };
    }
    console.log("[gmarket] 로그인 성공");

    // 2. 페이지의 자체 API 호출 헤더를 캡처한 뒤, 동일 헤더로 페이지네이션
    const targetSet = new Set(orderNos.map(String));
    const found = new Set<string>();
    const allBundles: GmarketOrderResponse["data"]["payBundleList"] = [];

    // my.gmarket.co.kr/ko/pc/main 이동 → 페이지 자체 API 호출 발생 → 응답 + 요청 헤더 수집
    console.log("[gmarket] my.gmarket.co.kr 이동...");
    const firstApiPromise = page.waitForResponse(
      (res) => res.url().includes("/api/pays/paging") && res.status() === 200,
      { timeout: TIMEOUT_API }
    );
    keepContextInBackground(context);
    await page.goto("https://my.gmarket.co.kr/ko/pc/main", { waitUntil: "networkidle", timeout: TIMEOUT_NAV });
    keepContextInBackground(context);

    const firstApiRes = await firstApiPromise;
    const firstData = await firstApiRes.json() as GmarketOrderResponse;
    console.log("[gmarket] 첫 페이지:", `totalCount=${firstData.data?.totalCount}, bundles=${firstData.data?.payBundleList?.length}`);

    // 첫 응답의 요청 헤더를 그대로 재사용 (page.route 인터셉트 제거 → unroute 블로킹 차단)
    // ":authority" 등 HTTP/2 의사 헤더는 request.get에 넣을 수 없으므로 제외
    const rawHeaders = await firstApiRes.request().allHeaders();
    const capturedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (k.startsWith(":")) continue;
      capturedHeaders[k] = v;
    }
    const capturedBaseUrl = firstApiRes.url().split("?")[0];
    console.log("[gmarket] 요청 헤더 캡처 완료:", Object.keys(capturedHeaders).join(", "), "→ 페이지네이션 시작");

    if (firstData.data?.payBundleList?.length) {
      allBundles.push(...firstData.data.payBundleList);

      const totalCount = firstData.data.totalCount;
      const pageSize = firstData.data.pageSize || 5;
      const totalPages = Math.ceil(totalCount / pageSize);
      console.log(`[gmarket] 총 ${totalCount}건, pageSize=${pageSize}, ${totalPages}페이지`);

      // 캡처한 원본 URL에서 기본 파라미터 추출
      const originalUrl = firstApiRes.url();
      const originalParams = new URL(originalUrl).searchParams;

      // 나머지 페이지를 병렬 배치로 요청.
      // 지마켓/Cloudflare 봇 차단(ECONNRESET) 방지: 동시요청 축소(10→3) + 재시도 + 배치간 딜레이.
      const BATCH_SIZE = 3;
      const BATCH_DELAY_MS = 800;
      const maxPage = Math.min(totalPages, MAX_PAGES);

      for (let batchStart = 2; batchStart <= maxPage && found.size < targetSet.size; batchStart += BATCH_SIZE) {
        if (abortSignal?.aborted) {
          console.log("[gmarket] 사용자 중단 요청 → 페이지네이션 중단");
          break;
        }

        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, maxPage);
        const pageNos = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

        const batchResults = await Promise.all(
          pageNos.map((pageNo) => {
            const params = new URLSearchParams();
            originalParams.forEach((v, k) => params.set(k, v));
            params.set("pageNo", String(pageNo));
            return fetchPageWithRetry(context, `${capturedBaseUrl}?${params}`, capturedHeaders, pageNo);
          })
        );

        let stopped = false;
        for (const res of batchResults) {
          if (res === "error") continue;                 // 재시도 소진 후에도 실패 → 이 페이지만 건너뛰고 계속
          if (res === null) { stopped = true; break; }    // 빈 페이지 = 데이터 끝
          allBundles.push(...res);
          for (const bundle of res) {
            for (const order of bundle.orderList) {
              if (targetSet.has(String(order.orderNo))) found.add(String(order.orderNo));
            }
          }
        }
        if (stopped) break;

        // 배치 사이 딜레이 (봇 차단 완화). 다음 배치가 남았고 아직 못 찾은 주문이 있을 때만.
        if (batchEnd < maxPage && found.size < targetSet.size) {
          await sleep(BATCH_DELAY_MS);
        }
      }
    }

    // 3. 수집된 주문 데이터에서 대상 주문 매칭 및 배송정보 수집
    found.clear(); // 재검색
    console.log(`[gmarket] 총 ${allBundles.length}개 번들에서 주문 검색...`);

    for (const bundle of allBundles) {
      if (abortSignal?.aborted) {
        console.log("[gmarket] 사용자 중단 요청 → 주문 매칭 중단");
        break;
      }
      for (const order of bundle.orderList) {
        const orderNoStr = String(order.orderNo);
        if (!targetSet.has(orderNoStr)) continue;
        found.add(orderNoStr);

        if (order.orderDelivery?.invoiceNo) {
          const trackingInfo = await getTrackingFromPage(page, orderNoStr);
          result.success.push({
            orderNo: orderNoStr,
            courier: trackingInfo?.courier || "",
            trackingNo: trackingInfo?.trackingNo || order.orderDelivery.invoiceNo,
            status: order.displayOrderStatusName,
            itemName: order.orderItem.itemName,
          });
        } else if (!order.orderDelivery?.hasDelivery) {
          result.failed.push({ orderNo: orderNoStr, reason: "배송정보 없음 (아직 발송 전)" });
        } else {
          result.failed.push({ orderNo: orderNoStr, reason: "운송장번호 미등록" });
        }
      }
    }

    // 못 찾은 주문번호
    for (const no of orderNos) {
      if (!found.has(String(no))) {
        result.notFound.push(String(no));
      }
    }

    console.log("[gmarket] 수집 완료:", `성공=${result.success.length}, 실패=${result.failed.length}, 미발견=${result.notFound.length}`);
  } catch (err) {
    console.error("[gmarket] 수집 오류:", err instanceof Error ? err.message : String(err));
    // 아직 처리 안 된 주문번호를 실패로
    for (const no of orderNos) {
      const noStr = String(no);
      if (!result.success.some(s => s.orderNo === noStr) &&
          !result.failed.some(f => f.orderNo === noStr) &&
          !result.notFound.includes(noStr)) {
        result.failed.push({ orderNo: noStr, reason: `오류: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  } finally {
    await browser.close();
  }

  return result;
}

/**
 * 배송 추적 페이지에서 택배사 + 운송장 추출
 */
async function getTrackingFromPage(
  page: import("playwright").Page,
  orderNo: string
): Promise<{ courier: string; trackingNo: string } | null> {
  keepContextInBackground(page.context());
  const trackingPage = await page.context().newPage();
  keepContextInBackground(page.context());
  try {
    const url = `${TRACKING_URL}/${orderNo}?trackingType=DELIVERY&charset=ko`;
    keepContextInBackground(page.context());
    await trackingPage.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_TRACKING });
    keepContextInBackground(page.context());

    const data = await trackingPage.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return null;
      try {
        const json = JSON.parse(el.textContent || "");
        const state = json?.props?.pageProps?.initialState;
        if (!state?.shippingInfo || !state?.shippingCompanyInfo) return null;
        return {
          courier: state.shippingCompanyInfo.deliveryCompName || "",
          trackingNo: state.shippingInfo.invoiceNo || "",
        };
      } catch {
        return null;
      }
    });

    if (data?.courier) {
      return { courier: normalizeCourier(data.courier), trackingNo: data.trackingNo };
    }
    return data;
  } catch {
    return null;
  } finally {
    await trackingPage.close().catch(() => {});
  }
}
