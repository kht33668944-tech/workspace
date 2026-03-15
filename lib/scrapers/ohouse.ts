import { type BrowserContext, type Cookie } from "playwright";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScrapeResult } from "./types";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { launchBrowser, createStealthContext } from "./browser";
import { normalizeCourier } from "./constants";
import { loadSession, saveSession } from "./session-manager";

const LOGIN_URL = "https://ohou.se/users/sign_in";
const ORDER_LIST_API = "/order/v1/front/orders/list";
const DELIVERY_BASE_URL = "https://store.ohou.se/deliveries";
const SESSION_DIR = path.join(process.cwd(), ".sessions");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 계정별 쿠키 파일 경로 생성
function getCookiePath(loginId: string): string {
  const hash = crypto.createHash("md5").update(loginId).digest("hex").substring(0, 8);
  return path.join(SESSION_DIR, `ohouse-${hash}.json`);
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
    const cookiePath = getCookiePath(loginId);
    const data = await readFile(cookiePath, "utf-8");
    const session: SavedSession = JSON.parse(data);
    if (session.loginId !== loginId) return null;
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
    const session: SavedSession = { loginId, cookies, savedAt: Date.now() };
    const cookiePath = getCookiePath(loginId);
    await writeFile(cookiePath, JSON.stringify(session), "utf-8");
  } catch {
    // 쿠키 저장 실패는 무시
  }
}

async function isSessionValid(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto("https://ohou.se/user_shopping_pages/order_list", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    const url = page.url();
    if (url.includes("sign_in") || url.includes("login")) return false;
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
 * 1. 계정별 저장된 쿠키로 세션 복원 시도 → 실패 시 로그인
 * 2. 주문 목록 API 호출 (페이지네이션)
 * 3. 대상 주문번호 매칭 → emailToken + orderOptionId 확보
 * 4. 배송조회 페이지 접속 → __NEXT_DATA__에서 택배사/운송장 추출
 */
export async function collectOhouseTracking(
  loginId: string,
  loginPw: string,
  orderNos: string[],
  supabase?: SupabaseClient
): Promise<ScrapeResult> {
  const result: ScrapeResult = { success: [], failed: [], notFound: [] };
  const targetSet = new Set(orderNos);

  const browser = await launchBrowser();

  let context: BrowserContext;
  let needsLogin = true;

  // 1. 계정별 쿠키 복원 시도 (DB 우선, fallback: 파일)
  const savedCookies = supabase
    ? await loadSession(supabase, "ohouse", loginId)
    : await loadCookies(loginId);
  if (savedCookies) {
    console.log("[ohouse] 저장된 세션으로 복원 시도...");
    context = await createStealthContext(browser);
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
    context = await createStealthContext(browser);
    const page = await context.newPage();

    try {
      console.log("[ohouse] 로그인 중...");
      await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 60000 });

      console.log("[ohouse] 로그인 페이지 URL:", page.url());

      // SPA 렌더링 대기
      await page.waitForTimeout(3000);

      const emailSelectors = [
        'input[placeholder*="이메일"]',
        'input[name="email"]',
        'input[type="email"]',
        'input[placeholder*="아이디"]',
        'input[name="username"]',
        'input[autocomplete="email"]',
        'form input[type="text"]:first-of-type',
        'input:not([type="hidden"])',
      ];

      let emailInput = null;
      for (const sel of emailSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
          emailInput = loc;
          console.log("[ohouse] 이메일 입력 필드 발견:", sel);
          break;
        }
      }

      if (!emailInput) {
        const debugInfo = await page.evaluate(() => ({
          title: document.title,
          bodyText: document.body?.innerText?.substring(0, 500) || "",
          inputs: Array.from(document.querySelectorAll("input")).map((el) => ({
            type: el.type, name: el.name, placeholder: el.placeholder, id: el.id,
            visible: el.offsetParent !== null,
          })),
          iframes: Array.from(document.querySelectorAll("iframe")).map((el) => el.src),
        }));
        console.log("[ohouse] 디버그 정보:", JSON.stringify(debugInfo, null, 2));
        await browser.close();
        return {
          success: [],
          failed: orderNos.map((no) => ({
            orderNo: no,
            reason: `로그인 필드 없음. title="${debugInfo.title}", inputs=${debugInfo.inputs.length}, URL=${page.url()}`,
          })),
          notFound: [],
        };
      }

      await emailInput.click();
      await emailInput.pressSequentially(loginId, { delay: 50 });
      await page.waitForTimeout(300);
      const pwInput = page.locator('input[type="password"]').first();
      await pwInput.click();
      await pwInput.pressSequentially(loginPw, { delay: 50 });

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

      // 계정별 쿠키 저장 (DB 우선, fallback: 파일)
      const cookies = await context.cookies();
      if (supabase) {
        await saveSession(supabase, "ohouse", loginId, cookies);
      } else {
        await saveCookies(loginId, cookies);
      }
    } finally {
      await page.close();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const activeContext = context!;

  try {
    // 3. 주문 목록 API로 대상 주문 정보 수집
    console.log(`[ohouse] 주문 목록에서 ${orderNos.length}건 검색 중...`);

    const listPage = await activeContext.newPage();
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

      if (matchedOrders.size === targetSet.size) break;
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
