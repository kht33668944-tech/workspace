import { chromium } from "playwright";
import type {
  GmarketOrderResponse,
  TrackingInfo,
  ScrapeResult,
} from "./types";

const LOGIN_URL = "https://signinssl.gmarket.co.kr/login/login";
const TRACKING_URL = "https://tracking.gmarket.co.kr/track";

// 택배사명 정규화 (지마켓 → 우리 DB 형식)
const COURIER_MAP: Record<string, string> = {
  "CJ대한통운": "CJ대한통운",
  "한진택배": "한진택배",
  "롯데택배": "롯데택배",
  "우체국택배": "우체국택배",
  "로젠택배": "로젠택배",
  "경동택배": "경동택배",
  "대신택배": "대신택배",
  "일양로지스": "일양로지스",
  "합동택배": "합동택배",
  "천일택배": "천일택배",
  "건영택배": "건영택배",
  "호남택배": "호남택배",
  "한의사랑택배": "한의사랑택배",
  "SLX": "SLX",
  "우편": "우체국택배",
};

function normalizeCourier(name: string): string {
  return COURIER_MAP[name] || name;
}

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
  orderNos: string[]
): Promise<ScrapeResult> {
  const result: ScrapeResult = { success: [], failed: [], notFound: [] };

  // 시스템 Chrome 사용 (Cloudflare 우회에 가장 효과적)
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  const page = await context.newPage();

  try {
    // 1. 로그인
    console.log("[gmarket] 로그인 중...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 60000 });

    const loginInput = page.getByPlaceholder("아이디");
    await loginInput.waitFor({ state: "visible", timeout: 30000 });
    await loginInput.fill(loginId);
    await page.locator("#typeMemberInputPassword").fill(loginPw);

    await Promise.all([
      page.waitForURL((url) => !url.toString().includes("login/login"), { timeout: 30000 }).catch(() => null),
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
      { timeout: 30000 }
    );
    await page.goto("https://my.gmarket.co.kr/ko/pc/main", { waitUntil: "networkidle", timeout: 60000 });

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

      // 나머지 페이지를 캡처한 헤더로 직접 요청
      for (let pageNo = 2; pageNo <= Math.min(totalPages, 100) && found.size < targetSet.size; pageNo++) {
        const params = new URLSearchParams();
        originalParams.forEach((v, k) => params.set(k, v));
        params.set("pageNo", String(pageNo));

        const apiRes = await context.request.get(`${capturedBaseUrl}?${params}`, {
          headers: capturedHeaders,
        });

        if (!apiRes.ok()) {
          console.log(`[gmarket] 페이지 ${pageNo}: HTTP ${apiRes.status()}`);
          break;
        }

        const pageData = await apiRes.json() as GmarketOrderResponse;
        if (!pageData.data?.payBundleList?.length) break;
        allBundles.push(...pageData.data.payBundleList);
        console.log(`[gmarket] 페이지 ${pageNo}: bundles=${pageData.data.payBundleList.length}`);

        // 현재까지 모은 번들에서 대상 주문 찾기 (일찍 종료용)
        for (const bundle of pageData.data.payBundleList) {
          for (const order of bundle.orderList) {
            if (targetSet.has(String(order.orderNo))) found.add(String(order.orderNo));
          }
        }
      }
    }

    // 3. 수집된 주문 데이터에서 대상 주문 매칭 및 배송정보 수집
    found.clear(); // 재검색
    console.log(`[gmarket] 총 ${allBundles.length}개 번들에서 주문 검색...`);

    for (const bundle of allBundles) {
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
  try {
    const trackingPage = await page.context().newPage();
    const url = `${TRACKING_URL}/${orderNo}?trackingType=DELIVERY&charset=ko`;
    await trackingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });

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

    await trackingPage.close();

    if (data?.courier) {
      return { courier: normalizeCourier(data.courier), trackingNo: data.trackingNo };
    }
    return data;
  } catch {
    return null;
  }
}
