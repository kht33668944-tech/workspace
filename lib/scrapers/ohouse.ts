import { chromium, type BrowserContext, type Cookie } from "playwright";
import type { ScrapeResult } from "./types";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const LOGIN_URL = "https://ohou.se/users/sign_in";
const ORDER_LIST_API = "/order/v1/front/orders/list";
const DELIVERY_BASE_URL = "https://store.ohou.se/deliveries";
const SESSION_DIR = path.join(process.cwd(), ".sessions");
const COOKIE_FILE = path.join(SESSION_DIR, "ohouse-cookies.json");

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

interface SavedSession {
  loginId: string;
  cookies: Cookie[];
  savedAt: number;
}

async function loadCookies(loginId: string): Promise<Cookie[] | null> {
  try {
    const data = await readFile(COOKIE_FILE, "utf-8");
    const session: SavedSession = JSON.parse(data);

    // 다른 계정이면 무효
    if (session.loginId !== loginId) return null;

    // 24시간 이상 지났으면 무효
    const hoursSaved = (Date.now() - session.savedAt) / (1000 * 60 * 60);
    if (hoursSaved > 24) return null;

    return session.cookies;
  } catch {
    return null;
  }
}

async function saveCookies(loginId: string, cookies: Cookie[]): Promise<void> {
  try {
    await mkdir(SESSION_DIR, { recursive: true });
    const session: SavedSession = {
      loginId,
      cookies,
      savedAt: Date.now(),
    };
    await writeFile(COOKIE_FILE, JSON.stringify(session), "utf-8");
  } catch (err) {
    console.log("[ohouse] 쿠키 저장 실패:", err);
  }
}

async function isSessionValid(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    // 주문 목록 API를 호출해서 세션 유효성 검증
    await page.goto("https://ohou.se/user_shopping_pages/order_list", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // 로그인 페이지로 리다이렉트되면 세션 만료
    const url = page.url();
    if (url.includes("sign_in") || url.includes("login")) {
      return false;
    }

    // API 호출 테스트
    const apiResult = await page.evaluate(async () => {
      const res = await fetch("/order/v1/front/orders/list?cursor=&pageSize=1&period=&optionStatus=&searchWord=", {
        credentials: "include",
      });
      return res.ok;
    });

    return apiResult;
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

/**
 * Playwright 기반 오늘의집 배송정보 일괄 수집
 *
 * 전략:
 * 1. 저장된 쿠키로 세션 복원 시도 → 실패 시 로그인
 * 2. 주문 목록 API 호출 (페이지네이션)
 * 3. 대상 주문번호 매칭 → emailToken + orderOptionId 확보
 * 4. 배송조회 페이지 접속 → __NEXT_DATA__에서 택배사/운송장 추출
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

  let context: BrowserContext;
  let needsLogin = true;

  // 1. 쿠키 복원 시도
  const savedCookies = await loadCookies(loginId);
  if (savedCookies) {
    console.log("[ohouse] 저장된 세션으로 복원 시도...");
    context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await context.addCookies(savedCookies);

    if (await isSessionValid(context)) {
      console.log("[ohouse] 세션 복원 성공 (로그인 생략)");
      needsLogin = false;
    } else {
      console.log("[ohouse] 세션 만료, 재로그인 필요");
      await context.close();
    }
  }

  // 2. 세션 복원 실패 시 로그인
  if (needsLogin) {
    context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await context.newPage();

    try {
      console.log("[ohouse] 로그인 중...");
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      console.log("[ohouse] 로그인 페이지 로드 완료, URL:", page.url());

      // 이메일 입력 필드 찾기 (여러 셀렉터 시도)
      const emailSelectors = [
        'input[type="text"]',
        'input[placeholder*="이메일"]',
        'input[name="email"]',
        'input[type="email"]',
        'input[id*="email"]',
      ];
      let emailInput = null;
      for (const sel of emailSelectors) {
        const loc = page.locator(sel).first();
        const count = await loc.count();
        console.log(`[ohouse] 셀렉터 "${sel}" → ${count}개 발견`);
        if (count > 0 && !emailInput) {
          emailInput = loc;
        }
      }

      if (!emailInput) {
        console.log("[ohouse] 이메일 입력 필드를 찾을 수 없음");
        const pageContent = await page.content();
        console.log("[ohouse] 페이지 일부:", pageContent.substring(0, 500));
        await browser.close();
        return {
          success: [],
          failed: orderNos.map((no) => ({
            orderNo: no,
            reason: "로그인 페이지에서 이메일 입력 필드를 찾을 수 없습니다",
          })),
          notFound: [],
        };
      }

      await emailInput.waitFor({ state: "visible", timeout: 30000 });
      await emailInput.fill(loginId);
      console.log("[ohouse] 이메일 입력 완료");

      const pwInput = page.locator('input[type="password"]');
      const pwCount = await pwInput.count();
      console.log(`[ohouse] 비밀번호 필드 → ${pwCount}개 발견`);
      await pwInput.fill(loginPw);
      console.log("[ohouse] 비밀번호 입력 완료");

      // 로그인 버튼 찾기
      const btnSelectors = [
        'button:has-text("로그인")',
        'button[type="submit"]',
        'input[type="submit"]',
      ];
      let loginBtn = null;
      for (const sel of btnSelectors) {
        const loc = page.locator(sel).first();
        const count = await loc.count();
        console.log(`[ohouse] 버튼 "${sel}" → ${count}개 발견`);
        if (count > 0 && !loginBtn) {
          loginBtn = loc;
        }
      }

      if (!loginBtn) {
        console.log("[ohouse] 로그인 버튼을 찾을 수 없음");
        await browser.close();
        return {
          success: [],
          failed: orderNos.map((no) => ({
            orderNo: no,
            reason: "로그인 버튼을 찾을 수 없습니다",
          })),
          notFound: [],
        };
      }

      await Promise.all([
        page.waitForURL((url) => !url.toString().includes("sign_in"), { timeout: 30000 }).catch(() => null),
        loginBtn.click(),
      ]);
      console.log("[ohouse] 로그인 버튼 클릭 완료, 대기 중...");

      await page.waitForTimeout(3000);
      console.log("[ohouse] 현재 URL:", page.url());

      if (page.url().includes("sign_in")) {
        const hasCaptcha = await page.locator('[id*="captcha"], [class*="captcha"], [class*="recaptcha"]').count() > 0;
        // 페이지에서 에러 메시지 확인
        const errorText = await page.evaluate(() => {
          const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], [class*="warning"], [role="alert"]');
          return Array.from(errorEls).map(el => el.textContent?.trim()).filter(Boolean).join(" | ");
        });
        // 페이지 전체 텍스트 출력 (디버깅용)
        const pageText = await page.evaluate(() => document.body?.innerText || "");
        console.log("[ohouse] 로그인 실패 - 캡차:", hasCaptcha, "에러:", errorText || "없음");
        console.log("[ohouse] 페이지 전체 텍스트:", pageText.substring(0, 1000));
        await browser.close();
        return {
          success: [],
          failed: orderNos.map((no) => ({
            orderNo: no,
            reason: hasCaptcha
              ? "캡차 인증이 필요합니다"
              : errorText
                ? `로그인 실패: ${errorText}`
                : "로그인 실패: 이메일/비밀번호 확인",
          })),
          notFound: [],
        };
      }
      console.log("[ohouse] 로그인 성공");

      // 쿠키 저장
      const cookies = await context.cookies();
      await saveCookies(loginId, cookies);
      console.log("[ohouse] 세션 쿠키 저장 완료");
    } finally {
      await page.close();
    }
  }

  // context는 여기서 반드시 초기화되어 있음
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const activeContext = context!;

  try {
    // 3. 주문 목록 API로 대상 주문 정보 수집
    console.log(`[ohouse] 주문 목록에서 ${orderNos.length}건 검색 중...`);

    const listPage = await activeContext.newPage();

    // 주문 목록 페이지로 이동 (쿠키/세션 활성화)
    await listPage.goto("https://ohou.se/user_shopping_pages/order_list", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const matchedOrders: Map<string, { orderId: number; emailToken: string; orderOptionId: number; productName: string }> = new Map();
    let cursor = "";
    let pageCount = 0;
    const MAX_PAGES = 50;

    while (pageCount < MAX_PAGES) {
      const apiUrl = `${ORDER_LIST_API}?cursor=${cursor}&pageSize=20&period=&optionStatus=&searchWord=`;
      const apiResponse = await listPage.evaluate(async (url: string) => {
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

    await listPage.close();

    console.log(`[ohouse] ${matchedOrders.size}/${orderNos.length}건 매칭 완료`);

    // 매칭되지 않은 주문 → notFound
    for (const no of orderNos) {
      if (!matchedOrders.has(no)) {
        result.notFound.push(no);
      }
    }

    // 4. 배송조회 페이지에서 운송장 정보 추출
    if (matchedOrders.size > 0) {
      const trackingPage = await activeContext.newPage();
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

    // 수집 완료 후 쿠키 갱신 저장
    const updatedCookies = await activeContext.cookies();
    await saveCookies(loginId, updatedCookies);

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
