import { chromium } from "playwright";
import type { ScrapeResult } from "./types";

const LOGIN_URL = "https://ohou.se/users/sign_in";
const ORDER_LIST_API = "/order/v1/front/orders/list";
const DELIVERY_BASE_URL = "https://store.ohou.se/deliveries";

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

interface OhouseOrder {
  orderId: number;
  emailToken: string;
  optionList: {
    orderOptionId: number;
    optionStatus: string;
    isDeliveryTraceable: boolean;
    productName: string;
  }[];
}

interface OhouseOrderListResponse {
  nextCursor: number | null;
  orderList: OhouseOrder[];
}

/**
 * Playwright 기반 오늘의집 배송정보 일괄 수집
 *
 * 전략:
 * 1. 로그인 후 주문 목록 API 호출 (페이지네이션)
 * 2. 대상 주문번호 매칭 → emailToken + orderOptionId 확보
 * 3. 배송조회 페이지 접속 → __NEXT_DATA__에서 택배사/운송장 추출
 */
export async function collectOhouseTracking(
  loginId: string,
  loginPw: string,
  orderNos: string[]
): Promise<ScrapeResult> {
  const result: ScrapeResult = { success: [], failed: [], notFound: [] };
  const targetSet = new Set(orderNos);

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
    console.log("[ohouse] 로그인 중...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    const emailInput = page.locator('input[type="text"], input[placeholder*="이메일"]').first();
    await emailInput.waitFor({ state: "visible", timeout: 30000 });
    await emailInput.fill(loginId);
    await page.locator('input[type="password"]').fill(loginPw);

    await Promise.all([
      page.waitForURL((url) => !url.toString().includes("sign_in"), { timeout: 30000 }).catch(() => null),
      page.locator('button:has-text("로그인")').click(),
    ]);

    await page.waitForTimeout(3000);

    if (page.url().includes("sign_in")) {
      const hasCaptcha = await page.locator('[id*="captcha"], [class*="captcha"], [class*="recaptcha"]').count() > 0;
      await browser.close();
      return {
        success: [],
        failed: orderNos.map((no) => ({
          orderNo: no,
          reason: hasCaptcha ? "캡차 인증이 필요합니다" : "로그인 실패: 이메일/비밀번호 확인",
        })),
        notFound: [],
      };
    }
    console.log("[ohouse] 로그인 성공");

    // 2. 주문 목록 API로 대상 주문 정보 수집
    console.log(`[ohouse] 주문 목록에서 ${orderNos.length}건 검색 중...`);

    // 주문 목록 페이지로 이동 (쿠키/세션 활성화)
    await page.goto("https://ohou.se/user_shopping_pages/order_list", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const matchedOrders: Map<string, { orderId: number; emailToken: string; orderOptionId: number; productName: string }> = new Map();
    let cursor = "";
    let pageCount = 0;
    const MAX_PAGES = 50;

    while (pageCount < MAX_PAGES) {
      const apiUrl = `${ORDER_LIST_API}?cursor=${cursor}&pageSize=20&period=&optionStatus=&searchWord=`;
      const apiResponse = await page.evaluate(async (url: string) => {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) return null;
        return res.json();
      }, apiUrl);

      if (!apiResponse) {
        console.log("[ohouse] 주문 목록 API 호출 실패");
        break;
      }

      const data = apiResponse as OhouseOrderListResponse;

      for (const order of data.orderList) {
        const orderIdStr = String(order.orderId);
        if (targetSet.has(orderIdStr)) {
          const traceableOption = order.optionList.find((opt) => opt.isDeliveryTraceable);
          if (traceableOption) {
            matchedOrders.set(orderIdStr, {
              orderId: order.orderId,
              emailToken: order.emailToken,
              orderOptionId: traceableOption.orderOptionId,
              productName: traceableOption.productName,
            });
          }
        }
      }

      // 모든 대상을 찾았으면 조기 종료
      if (matchedOrders.size === targetSet.size) break;

      // 다음 페이지
      if (!data.nextCursor) break;
      cursor = String(data.nextCursor);
      pageCount++;
    }

    console.log(`[ohouse] ${matchedOrders.size}/${orderNos.length}건 매칭 완료`);

    // 매칭되지 않은 주문 → notFound
    for (const no of orderNos) {
      if (!matchedOrders.has(no)) {
        result.notFound.push(no);
      }
    }

    // 3. 배송조회 페이지에서 운송장 정보 추출
    if (matchedOrders.size > 0) {
      const trackingPage = await context.newPage();
      const entries = Array.from(matchedOrders.entries());

      for (let i = 0; i < entries.length; i++) {
        const [orderNo, info] = entries[i];
        try {
          if (i > 0) await delay(2000);

          const deliveryUrl = `${DELIVERY_BASE_URL}/${info.orderId}?type=ORDER&targetOptionId=${info.orderOptionId}&token=${info.emailToken}`;
          console.log(`[ohouse] ${orderNo}: 배송조회 중...`);

          await trackingPage.goto(deliveryUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          await trackingPage.waitForTimeout(1500);

          // __NEXT_DATA__에서 배송정보 추출
          const trackingData = await trackingPage.evaluate(() => {
            const el = document.getElementById("__NEXT_DATA__");
            if (!el) return null;
            try {
              const json = JSON.parse(el.textContent || "");
              const deliveryInfo = json?.props?.pageProps?.data?.deliveryInfo;
              if (!deliveryInfo) return null;
              return {
                courier: deliveryInfo.logisticsName || "",
                trackingNo: deliveryInfo.invoiceNumber || "",
                status: deliveryInfo.deliveryTrackingStatus || "",
              };
            } catch {
              return null;
            }
          });

          if (trackingData?.courier && trackingData?.trackingNo) {
            result.success.push({
              orderNo,
              courier: normalizeCourier(trackingData.courier),
              trackingNo: trackingData.trackingNo,
              status: "배송조회완료",
              itemName: info.productName,
            });
            console.log(`[ohouse] ${orderNo}: ${trackingData.courier} ${trackingData.trackingNo}`);
          } else {
            // fallback: 페이지 텍스트에서 추출
            const fallbackData = await trackingPage.evaluate(() => {
              const text = document.body?.innerText || "";
              const match = text.match(
                /(CJ대한통운|한진택배|롯데택배|우체국택배|로젠택배|경동택배|대신택배|일양로지스|합동택배|천일택배|건영택배|호남택배|한의사랑택배|SLX)\s+(\d{10,14})/
              );
              if (match) return { courier: match[1], trackingNo: match[2] };
              return null;
            });

            if (fallbackData?.courier && fallbackData?.trackingNo) {
              result.success.push({
                orderNo,
                courier: normalizeCourier(fallbackData.courier),
                trackingNo: fallbackData.trackingNo,
                status: "배송조회완료",
                itemName: info.productName,
              });
              console.log(`[ohouse] ${orderNo}: ${fallbackData.courier} ${fallbackData.trackingNo} (fallback)`);
            } else {
              result.failed.push({ orderNo, reason: "배송정보를 추출할 수 없습니다 (아직 발송 전일 수 있음)" });
              console.log(`[ohouse] ${orderNo}: 배송정보 없음`);
            }
          }
        } catch (err) {
          result.failed.push({
            orderNo,
            reason: `조회 오류: ${err instanceof Error ? err.message : String(err)}`,
          });
          console.log(`[ohouse] ${orderNo}: 오류 - ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await trackingPage.close();
    }

    console.log("[ohouse] 수집 완료:", `성공=${result.success.length}, 실패=${result.failed.length}, 미발견=${result.notFound.length}`);
  } catch (err) {
    console.error("[ohouse] 수집 오류:", err);
    for (const no of orderNos) {
      const noStr = String(no);
      if (
        !result.success.some((s) => s.orderNo === noStr) &&
        !result.failed.some((f) => f.orderNo === noStr) &&
        !result.notFound.includes(noStr)
      ) {
        result.failed.push({ orderNo: noStr, reason: `오류: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  } finally {
    await browser.close();
  }

  return result;
}
