import { launchBrowser, createStealthContext } from "./browser";
import { normalizeCourier } from "./constants";
import type {
  GmarketOrderResponse,
  TrackingInfo,
  ScrapeResult,
} from "./types";

const LOGIN_URL = "https://signinssl.gmarket.co.kr/login/login";
const TRACKING_URL = "https://tracking.gmarket.co.kr/track";
const TIMEOUT_NAV = 60000;
const TIMEOUT_LOGIN = 30000;
const TIMEOUT_API = 30000;
const TIMEOUT_TRACKING = 10000;

function formatDate(d: Date): string {
  return d.toISOString();
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
  const page = await context.newPage();

  try {
    // 1. 로그인
    console.log("[gmarket] 로그인 중...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: TIMEOUT_NAV });

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
    let capturedHeaders: Record<string, string> = {};
    let capturedBaseUrl = "";

    // 페이지의 API 요청 헤더를 캡처 (수정하지 않고 통과)
    await page.route("**/api/pays/paging**", async (route) => {
      const req = route.request();
      capturedHeaders = req.headers();
      capturedBaseUrl = req.url().split("?")[0];
      console.log("[gmarket] 요청 헤더 캡처 완료:", Object.keys(capturedHeaders).join(", "));
      await route.continue();
    });

    // my.gmarket.co.kr/ko/pc/main 이동 → 페이지 자체 API 호출 발생 → 헤더 캡처 + 응답 수집
    console.log("[gmarket] my.gmarket.co.kr 이동...");
    const firstApiPromise = page.waitForResponse(
      (res) => res.url().includes("/api/pays/paging") && res.status() === 200,
      { timeout: TIMEOUT_API }
    );
    await page.goto("https://my.gmarket.co.kr/ko/pc/main", { waitUntil: "networkidle", timeout: TIMEOUT_NAV });

    const firstApiRes = await firstApiPromise;
    const firstData = await firstApiRes.json() as GmarketOrderResponse;
    console.log("[gmarket] 첫 페이지:", `totalCount=${firstData.data?.totalCount}, bundles=${firstData.data?.payBundleList?.length}`);

    // route 해제 (이후 직접 요청)
    await page.unroute("**/api/pays/paging**");

    if (firstData.data?.payBundleList?.length) {
      allBundles.push(...firstData.data.payBundleList);

      const totalCount = firstData.data.totalCount;
      const pageSize = firstData.data.pageSize || 5;
      const totalPages = Math.ceil(totalCount / pageSize);
      console.log(`[gmarket] 총 ${totalCount}건, pageSize=${pageSize}, ${totalPages}페이지`);

      // 캡처한 원본 URL에서 기본 파라미터 추출
      const originalUrl = firstApiRes.url();
      const originalParams = new URL(originalUrl).searchParams;

      // 나머지 페이지를 병렬 배치로 요청 (10페이지씩)
      const BATCH_SIZE = 10;
      const maxPage = Math.min(totalPages, 100);

      for (let batchStart = 2; batchStart <= maxPage && found.size < targetSet.size; batchStart += BATCH_SIZE) {
        if (abortSignal?.aborted) {
          console.log("[gmarket] 사용자 중단 요청 → 페이지네이션 중단");
          break;
        }

        const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, maxPage);
        const pageNos = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

        const batchResults = await Promise.all(
          pageNos.map(async (pageNo) => {
            const params = new URLSearchParams();
            originalParams.forEach((v, k) => params.set(k, v));
            params.set("pageNo", String(pageNo));

            const apiRes = await context.request.get(`${capturedBaseUrl}?${params}`, {
              headers: capturedHeaders,
            });

            if (!apiRes.ok()) {
              console.log(`[gmarket] 페이지 ${pageNo}: HTTP ${apiRes.status()}`);
              return null;
            }

            const pageData = await apiRes.json() as GmarketOrderResponse;
            if (!pageData.data?.payBundleList?.length) return null;
            console.log(`[gmarket] 페이지 ${pageNo}: bundles=${pageData.data.payBundleList.length}`);
            return pageData.data.payBundleList;
          })
        );

        let stopped = false;
        for (const bundles of batchResults) {
          if (!bundles) { stopped = true; break; }
          allBundles.push(...bundles);
          for (const bundle of bundles) {
            for (const order of bundle.orderList) {
              if (targetSet.has(String(order.orderNo))) found.add(String(order.orderNo));
            }
          }
        }
        if (stopped) break;
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
    console.error("[gmarket] 수집 오류:", err);
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
  const trackingPage = await page.context().newPage();
  try {
    const url = `${TRACKING_URL}/${orderNo}?trackingType=DELIVERY&charset=ko`;
    await trackingPage.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_TRACKING });

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
