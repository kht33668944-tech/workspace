import { chromium } from "playwright";
import type { ScrapeResult } from "./types";

const LOGIN_URL = "https://signin.auction.co.kr/Authenticate/MobileLogin.aspx?url=http%3a%2f%2fwww.auction.co.kr&return_value=0&loginType=0";
const TRACKING_URL = "https://tracking.auction.co.kr";

// 택배사명 정규화
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

/**
 * Playwright 기반 옥션 배송정보 일괄 수집
 * 1. Chromium으로 로그인
 * 2. 각 주문번호별로 tracking.auction.co.kr에서 배송정보 직접 추출
 *    (옥션은 주문번호만으로 배송추적 페이지 접근 가능)
 */
export async function collectAuctionTracking(
  loginId: string,
  loginPw: string,
  orderNos: string[]
): Promise<ScrapeResult> {
  const result: ScrapeResult = { success: [], failed: [], notFound: [] };

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
    console.log("[auction] 로그인 중...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 60000 });

    const loginInput = page.locator("#typeMemberInputId");
    await loginInput.waitFor({ state: "visible", timeout: 30000 });
    await loginInput.fill(loginId);
    await page.locator("#typeMemberInputPassword").fill(loginPw);

    await Promise.all([
      page.waitForURL((url) => !url.toString().includes("signin.auction.co.kr"), { timeout: 30000 }).catch(() => null),
      page.getByRole("button", { name: "로그인" }).click(),
    ]);

    await page.waitForTimeout(3000);

    if (page.url().includes("signin.auction.co.kr")) {
      const hasCaptcha = await page.locator('[id*="captcha"], [class*="captcha"]').count() > 0;
      await browser.close();
      return {
        success: [],
        failed: orderNos.map(no => ({ orderNo: no, reason: hasCaptcha ? "캡차 인증이 필요합니다" : "로그인 실패: 아이디/비밀번호 확인" })),
        notFound: [],
      };
    }
    console.log("[auction] 로그인 성공");

    // 2. 각 주문번호별로 배송추적 페이지 방문하여 택배사/운송장 추출
    console.log(`[auction] ${orderNos.length}건 배송추적 시작...`);

    for (const orderNo of orderNos) {
      try {
        const trackingPage = await context.newPage();
        const url = `${TRACKING_URL}/?orderNo=${orderNo}`;
        await trackingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

        // __NEXT_DATA__에서 배송정보 추출
        // 옥션 구조: shippingInfo.shippingCompany (택배사), shippingInfo.invoiceNo (배열)
        const data = await trackingPage.evaluate(() => {
          const el = document.getElementById("__NEXT_DATA__");
          if (!el) return null;
          try {
            const json = JSON.parse(el.textContent || "");
            const state = json?.props?.pageProps?.initialState;
            if (!state?.shippingInfo) return null;
            const info = state.shippingInfo;
            return {
              courier: info.shippingCompany || "",
              trackingNo: Array.isArray(info.invoiceNo) ? info.invoiceNo[0] || "" : info.invoiceNo || "",
            };
          } catch {
            return null;
          }
        });

        await trackingPage.close();

        if (data?.courier && data?.trackingNo) {
          result.success.push({
            orderNo,
            courier: normalizeCourier(data.courier),
            trackingNo: data.trackingNo,
            status: "배송조회완료",
          });
          console.log(`[auction] ${orderNo}: ${data.courier} ${data.trackingNo}`);
        } else {
          // __NEXT_DATA__ 실패 시 텍스트 파싱 fallback
          const fallbackPage = await context.newPage();
          await fallbackPage.goto(url, { waitUntil: "networkidle", timeout: 15000 });
          const fallbackData = await fallbackPage.evaluate(() => {
            const text = document.body?.innerText || "";
            const match = text.match(/(CJ대한통운|한진택배|롯데택배|우체국택배|로젠택배|경동택배|대신택배|일양로지스|합동택배|천일택배|건영택배|호남택배|한의사랑택배|SLX)\s+(\d{10,14})/);
            if (match) return { courier: match[1], trackingNo: match[2] };
            return null;
          });
          await fallbackPage.close();

          if (fallbackData?.courier && fallbackData?.trackingNo) {
            result.success.push({
              orderNo,
              courier: normalizeCourier(fallbackData.courier),
              trackingNo: fallbackData.trackingNo,
              status: "배송조회완료",
            });
            console.log(`[auction] ${orderNo}: ${fallbackData.courier} ${fallbackData.trackingNo} (fallback)`);
          } else {
            result.notFound.push(orderNo);
            console.log(`[auction] ${orderNo}: 배송정보 없음`);
          }
        }
      } catch (err) {
        result.failed.push({
          orderNo,
          reason: `조회 오류: ${err instanceof Error ? err.message : String(err)}`,
        });
        console.log(`[auction] ${orderNo}: 오류 - ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log("[auction] 수집 완료:", `성공=${result.success.length}, 실패=${result.failed.length}, 미발견=${result.notFound.length}`);
  } catch (err) {
    console.error("[auction] 수집 오류:", err);
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
