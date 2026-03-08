import { chromium } from "playwright";
import type { ScrapeResult } from "./types";

const LOGIN_URL = "https://signin.auction.co.kr/Authenticate/MobileLogin.aspx?url=http%3a%2f%2fwww.auction.co.kr&return_value=0&loginType=0";
const TRACKING_URL = "https://tracking.auction.co.kr";

// 택배사명 정규화
const COURIER_MAP: Record<string, string> = {
  "CJ대한통운": "CJ대한통운",
  "CJ택배": "CJ대한통운",
  "대한통운": "CJ대한통운",
  "한진택배": "한진택배",
  "한진": "한진택배",
  "롯데택배": "롯데택배",
  "롯데": "롯데택배",
  "우체국택배": "우체국택배",
  "우체국": "우체국택배",
  "우편": "우체국택배",
  "로젠택배": "로젠택배",
  "로젠": "로젠택배",
  "경동택배": "경동택배",
  "대신택배": "대신택배",
  "일양로지스": "일양로지스",
  "합동택배": "합동택배",
  "천일택배": "천일택배",
  "건영택배": "건영택배",
  "호남택배": "호남택배",
  "한의사랑택배": "한의사랑택배",
  "SLX": "SLX",
};

function normalizeCourier(name: string): string {
  return COURIER_MAP[name] || name;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 단일 페이지에서 배송정보 추출 (캡차 감지 포함)
 */
async function extractTrackingFromPage(
  page: import("playwright").Page
): Promise<{ courier: string; trackingNo: string; hasCaptcha: boolean } | null> {
  // 캡차 감지
  const hasCaptcha = await page.locator('[id*="captcha"], [class*="captcha"], [id*="recaptcha"], iframe[src*="captcha"]').count() > 0;
  if (hasCaptcha) {
    return { courier: "", trackingNo: "", hasCaptcha: true };
  }

  // __NEXT_DATA__에서 배송정보 추출
  const data = await page.evaluate(() => {
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

  if (data?.courier && data?.trackingNo) {
    return { ...data, hasCaptcha: false };
  }

  // fallback: 텍스트 파싱 (같은 페이지에서)
  const fallbackData = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const match = text.match(/(CJ대한통운|한진택배|롯데택배|우체국택배|로젠택배|경동택배|대신택배|일양로지스|합동택배|천일택배|건영택배|호남택배|한의사랑택배|SLX)\s+(\d{10,14})/);
    if (match) return { courier: match[1], trackingNo: match[2] };
    return null;
  });

  if (fallbackData?.courier && fallbackData?.trackingNo) {
    return { ...fallbackData, hasCaptcha: false };
  }

  return null;
}

/**
 * Playwright 기반 옥션 배송정보 일괄 수집
 * - 단일 페이지 재사용 (봇 감지 최소화)
 * - 요청 간 딜레이 적용
 * - 실패 건 1회 재시도
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

    // 2. 단일 페이지로 순차 조회 (딜레이 적용)
    console.log(`[auction] ${orderNos.length}건 배송추적 시작...`);
    const trackingPage = await context.newPage();
    const retryQueue: string[] = [];

    for (let i = 0; i < orderNos.length; i++) {
      const orderNo = orderNos[i];
      try {
        // 첫 건이 아니면 딜레이
        if (i > 0) await delay(2000);

        const url = `${TRACKING_URL}/?orderNo=${orderNo}`;
        await trackingPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        await trackingPage.waitForTimeout(1000); // 페이지 로딩 안정화

        const data = await extractTrackingFromPage(trackingPage);

        if (data?.hasCaptcha) {
          console.log(`[auction] ${orderNo}: 캡차 감지 → 재시도 대기열에 추가`);
          retryQueue.push(orderNo);
          // 캡차 감지 시 긴 딜레이
          await delay(5000);
          continue;
        }

        if (data?.courier && data?.trackingNo) {
          result.success.push({
            orderNo,
            courier: normalizeCourier(data.courier),
            trackingNo: data.trackingNo,
            status: "배송조회완료",
          });
          console.log(`[auction] ${orderNo}: ${data.courier} ${data.trackingNo}`);
        } else {
          // 첫 시도 실패 → 재시도 대기열에 추가
          retryQueue.push(orderNo);
          console.log(`[auction] ${orderNo}: 배송정보 없음 → 재시도 예정`);
        }
      } catch (err) {
        retryQueue.push(orderNo);
        console.log(`[auction] ${orderNo}: 오류 → 재시도 예정 - ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. 실패 건 재시도 (더 긴 딜레이)
    if (retryQueue.length > 0) {
      console.log(`[auction] ${retryQueue.length}건 재시도 시작...`);
      await delay(3000);

      for (let i = 0; i < retryQueue.length; i++) {
        const orderNo = retryQueue[i];
        try {
          if (i > 0) await delay(3000);

          const url = `${TRACKING_URL}/?orderNo=${orderNo}`;
          await trackingPage.goto(url, { waitUntil: "networkidle", timeout: 20000 });
          await trackingPage.waitForTimeout(1500);

          const data = await extractTrackingFromPage(trackingPage);

          if (data?.hasCaptcha) {
            result.failed.push({ orderNo, reason: "캡차 인증이 필요합니다. 잠시 후 다시 시도해주세요." });
            console.log(`[auction] ${orderNo}: 재시도 실패 (캡차)`);
            continue;
          }

          if (data?.courier && data?.trackingNo) {
            result.success.push({
              orderNo,
              courier: normalizeCourier(data.courier),
              trackingNo: data.trackingNo,
              status: "배송조회완료",
            });
            console.log(`[auction] ${orderNo}: ${data.courier} ${data.trackingNo} (재시도 성공)`);
          } else {
            result.notFound.push(orderNo);
            console.log(`[auction] ${orderNo}: 배송정보 없음 (재시도 후)`);
          }
        } catch (err) {
          result.failed.push({
            orderNo,
            reason: `조회 오류: ${err instanceof Error ? err.message : String(err)}`,
          });
          console.log(`[auction] ${orderNo}: 재시도 오류 - ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    await trackingPage.close();
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
