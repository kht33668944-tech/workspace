import { chromium, type Page, type Frame, type BrowserContext } from "playwright";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import path from "path";
import type { PurchaseOrderInfo, PurchaseResult } from "./types";

// Next.js(Turbopack)에서 tesseract.js 워커 경로가 C:\ROOT\로 변환되는 문제 해결
const TESSERACT_WORKER_PATH = path.resolve(
  process.cwd(),
  "node_modules/tesseract.js/src/worker-script/node/index.js"
);

const LOGIN_URL = "https://signinssl.gmarket.co.kr/login/login";

interface ProgressCallback {
  (orderId: string, status: "processing" | "success" | "failed", message: string, purchaseOrderNo?: string): void;
}

/**
 * 지마켓 자동구매 스크래퍼
 * 1. 로그인 → 2. 각 주문건 순차 처리 (상품 URL → 쿠폰 → 구매 → 배송지 → 결제 → 주문번호 추출)
 */
export async function purchaseGmarket(
  loginId: string,
  loginPw: string,
  paymentPin: string,
  orders: PurchaseOrderInfo[],
  onProgress?: ProgressCallback
): Promise<PurchaseResult> {
  const result: PurchaseResult = { success: [], failed: [] };

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
    console.log("[gmarket-purchase] 로그인 중...");
    await login(page, context, loginId, loginPw);
    console.log("[gmarket-purchase] 로그인 성공");

    // 2. 각 주문건 순차 처리 (수량 > 1이면 1개씩 여러 번 구매)
    let activePage = page;
    for (const order of orders) {
      const totalQty = Math.max(order.quantity, 1);
      onProgress?.(order.orderId, "processing", totalQty > 1 ? `구매 진행 중... (0/${totalQty})` : "구매 진행 중...");

      let lastOrderNo = "";
      let totalCost = 0;
      let lastPaymentMethod: string | undefined;
      let successCount = 0;

      try {
        for (let q = 1; q <= totalQty; q++) {
          if (totalQty > 1) {
            console.log(`[gmarket-purchase] 주문 ${order.orderId} - ${q}/${totalQty}번째 구매`);
            onProgress?.(order.orderId, "processing", `구매 진행 중... (${q - 1}/${totalQty})`);
          }

          // 페이지 상태 확인 및 복구
          if (activePage.isClosed()) {
            console.log("[gmarket-purchase] 주문 시작 전 페이지 닫힘 감지, 복구...");
            activePage = await recoverPage(context, "about:blank");
          }

          // 이전 주문의 다이얼로그/팝업 정리
          try {
            await activePage.evaluate(() => {
              document.querySelectorAll('.box__layer, [class*="popup"], [class*="modal"]').forEach(el => {
                (el as HTMLElement).style.display = "none";
              });
            });
          } catch { /* 무시 */ }

          // 항상 수량 1로 구매 (order의 quantity를 무시)
          // 2번째 이후 구매는 배송지가 이미 저장되어 있으므로 빠른 검증만 수행
          const singleOrder = { ...order, quantity: 1 };
          const isRepeat = q > 1;
          const { purchaseOrderNo, cost, paymentMethod } = await processSingleOrder(activePage, context, singleOrder, paymentPin, isRepeat);

          lastOrderNo = purchaseOrderNo;
          if (cost) totalCost += cost;
          if (paymentMethod) lastPaymentMethod = paymentMethod;
          successCount++;

          if (totalQty > 1) {
            console.log(`[gmarket-purchase] ${q}/${totalQty}번째 구매 성공: ${purchaseOrderNo} (단가: ${cost ?? "미확인"})`);
          }
        }

        // 모든 수량 구매 완료 → 마지막 주문번호 + 원가 합산으로 결과 기록
        const finalCost = totalCost > 0 ? totalCost : undefined;
        result.success.push({ orderId: order.orderId, purchaseOrderNo: lastOrderNo, cost: finalCost, paymentMethod: lastPaymentMethod });
        onProgress?.(order.orderId, "success", `주문번호: ${lastOrderNo}${finalCost ? ` (원가: ${finalCost.toLocaleString()}원)` : ""}${lastPaymentMethod ? ` [${lastPaymentMethod}]` : ""}${totalQty > 1 ? ` (${totalQty}개)` : ""}`, lastOrderNo);
        console.log(`[gmarket-purchase] 주문 성공: ${order.orderId} → ${lastOrderNo} (총 원가: ${finalCost ?? "미확인"}, ${totalQty}개, 카드: ${lastPaymentMethod ?? "미확인"})`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const failMsg = totalQty > 1 ? `${reason} (${successCount}/${totalQty}개 구매 후 실패)` : reason;
        result.failed.push({ orderId: order.orderId, reason: failMsg });
        onProgress?.(order.orderId, "failed", failMsg);
        console.error(`[gmarket-purchase] 주문 실패: ${order.orderId}`, failMsg);

        // 실패 후 페이지 상태 복구 시도
        try {
          if (activePage.isClosed()) {
            activePage = await recoverPage(context, "about:blank");
          } else {
            // 불필요한 탭 닫기 (메인 페이지만 유지)
            const pages = context.pages();
            for (const p of pages) {
              if (p !== activePage && !p.isClosed()) {
                await p.close().catch(() => {});
              }
            }
          }
        } catch {
          console.log("[gmarket-purchase] 실패 후 페이지 복구 불가, 새 페이지 생성 시도");
          try {
            activePage = await context.newPage();
          } catch {
            console.error("[gmarket-purchase] 브라우저 컨텍스트 사용 불가, 남은 주문 중단");
            break;
          }
        }
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // 로그인 실패 등 전체 실패
    for (const order of orders) {
      if (!result.success.some(s => s.orderId === order.orderId) &&
          !result.failed.some(f => f.orderId === order.orderId)) {
        result.failed.push({ orderId: order.orderId, reason });
        onProgress?.(order.orderId, "failed", reason);
      }
    }
  } finally {
    await browser.close();
  }

  return result;
}

// ═══════════════════════════════════
// 로그인
// ═══════════════════════════════════
async function login(page: Page, context: BrowserContext, loginId: string, loginPw: string) {
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
  const hasUserInfo = cookies.some((c) => c.name === "user_info" || c.name === "user%5Finfo");

  if (!hasUserInfo && page.url().includes("login")) {
    throw new Error("로그인 실패: 아이디/비밀번호 확인");
  }
}

// ═══════════════════════════════════
// 단건 주문 처리
// ═══════════════════════════════════
interface SingleOrderResult {
  purchaseOrderNo: string;
  cost?: number;
  paymentMethod?: string;
}

async function processSingleOrder(
  page: Page,
  context: BrowserContext,
  order: PurchaseOrderInfo,
  paymentPin: string,
  isRepeatPurchase = false
): Promise<SingleOrderResult> {
  // 현재 작업 페이지 (쿠폰 등에서 새 탭이 열릴 수 있음)
  let activePage = page;

  // 1. 상품 페이지 이동
  console.log(`[gmarket-purchase] 상품 페이지 이동: ${order.productUrl}${isRepeatPurchase ? " (반복구매)" : ""}`);
  await activePage.goto(order.productUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await activePage.waitForTimeout(2000);

  // 2. 쿠폰 수집
  await collectCoupons(activePage);

  // 페이지 닫힘 시 복구 (쿠폰 팝업이 새 탭을 열고 원래 탭을 닫는 경우)
  if (activePage.isClosed()) {
    console.log("[gmarket-purchase] 쿠폰 수집 후 페이지 닫힘 감지, 복구 시도...");
    activePage = await recoverPage(context, order.productUrl);
  }

  // 3. 쿠폰 적용 (할인 최대화) — 수량은 항상 1개 (여러 개는 반복 구매)
  await applyCoupon(activePage);

  // 페이지 닫힘 시 복구
  if (activePage.isClosed()) {
    console.log("[gmarket-purchase] 쿠폰 적용 후 페이지 닫힘 감지, 복구 시도...");
    activePage = await recoverPage(context, order.productUrl);
  }

  // 4. 쿠폰 적용 후 오버레이/inert 최종 정리
  await dismissCouponOverlays(activePage).catch(() => {});

  // 5. 구매하기 클릭
  await clickPurchaseButton(activePage);

  // 6. 배송지 처리
  if (isRepeatPurchase) {
    // 반복 구매: 배송지가 이전 주문에서 이미 설정됨 → 검증만 수행
    await verifyAndPrepareCheckout(activePage, order);
  } else {
    // 첫 구매: 새 배송지 입력
    await changeShippingAddress(activePage, order);
  }

  // 7. 결제하기 클릭 + 비밀번호 입력
  await processPayment(activePage, paymentPin);

  // 8. 주문내역에서 주문번호 + 결제방식 + 원가 한번에 추출
  const orderInfo = await extractOrderInfo(activePage, context);

  return orderInfo;
}

// ═══════════════════════════════════
// 반복 구매 시 주문 페이지 검증 (배송지 변경 생략)
// ═══════════════════════════════════
async function verifyAndPrepareCheckout(page: Page, order: PurchaseOrderInfo) {
  try {
    console.log("[gmarket-purchase] 반복구매: 배송지 확인 중...");

    // 1. 주문 결제 페이지에서 배송지 정보 확인
    const addressText = await page.evaluate(() => {
      // 배송지 영역의 텍스트를 가져옴
      const addrEl = document.querySelector('.box__shipping-address, [class*="delivery-info"], [class*="shipping"]');
      return addrEl?.textContent || "";
    }).catch(() => "");

    if (addressText && order.recipientName) {
      const hasName = addressText.includes(order.recipientName);
      console.log(`[gmarket-purchase] 배송지 수취인 확인: ${hasName ? "일치" : "불일치"} (${order.recipientName})`);
      if (!hasName) {
        console.log("[gmarket-purchase] 배송지 불일치 → 전체 배송지 변경 수행");
        await changeShippingAddress(page, order);
        return;
      }
    }

    // 2. 안심번호 사용하기 체크
    await checkSafeNumber(page);

    // 3. 할인/쿠폰 적용 확인 (주문 결제 페이지의 쿠폰 적용 버튼)
    await applyCheckoutDiscount(page);

    console.log("[gmarket-purchase] 반복구매: 검증 완료 (배송지 변경 생략)");
  } catch (err) {
    console.log("[gmarket-purchase] 반복구매 검증 실패, 전체 배송지 변경으로 전환:", err);
    await changeShippingAddress(page, order);
  }
}

/** 안심번호 사용하기 체크 (배송지 변경 내부와 독립적으로 사용) */
async function checkSafeNumber(page: Page) {
  try {
    const safeNumSelectors = [
      'label:has-text("안심번호")',
      'input[type="checkbox"] + label:has-text("안심번호")',
      'text=안심번호 사용하기',
      '[class*="safe-number"] input[type="checkbox"]',
      '[class*="safeNumber"] input[type="checkbox"]',
      '[id*="safeNumber"]',
      '[id*="safe_number"]',
    ];
    for (const selector of safeNumSelectors) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const isChecked = await page.evaluate((sel) => {
          const label = document.querySelector(sel);
          if (!label) return false;
          const checkbox = label.querySelector('input[type="checkbox"]')
            || label.previousElementSibling as HTMLInputElement
            || label.closest('[class*="check"]')?.querySelector('input[type="checkbox"]');
          if (checkbox && (checkbox as HTMLInputElement).checked) return true;
          return label.classList.contains("checked") || label.getAttribute("aria-checked") === "true";
        }, selector).catch(() => false);

        if (!isChecked) {
          await el.click({ force: true });
          console.log("[gmarket-purchase] 안심번호 사용하기 체크 완료");
        } else {
          console.log("[gmarket-purchase] 안심번호 이미 체크됨");
        }
        break;
      }
    }
    await page.waitForTimeout(500);
  } catch {
    console.log("[gmarket-purchase] 안심번호 체크 스킵 (오류)");
  }
}

/** 주문 결제 페이지에서 추가 할인/쿠폰 적용 확인 */
async function applyCheckoutDiscount(page: Page) {
  try {
    // 쿠폰 적용 버튼이 있으면 클릭 (주문 결제 페이지 내)
    const couponApplyBtn = page.locator('button:has-text("쿠폰적용"), a:has-text("쿠폰적용"), button:has-text("할인적용")').first();
    if (await couponApplyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await couponApplyBtn.click();
      await page.waitForTimeout(1500);

      // 쿠폰 선택 팝업에서 최대 할인 적용
      const couponLayer = page.locator('[class*="coupon-layer"], [class*="CouponBox"], [id*="CouponBox"]').first();
      if (await couponLayer.isVisible({ timeout: 2000 }).catch(() => false)) {
        const applyBtn = couponLayer.locator('button:has-text("적용")').first();
        if (await applyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await applyBtn.click();
          await page.waitForTimeout(1000);
        }
      }

      // 오버레이 정리
      await dismissCouponOverlays(page).catch(() => {});
      console.log("[gmarket-purchase] 반복구매: 할인 적용 확인 완료");
    }
  } catch {
    console.log("[gmarket-purchase] 반복구매: 할인 확인 스킵");
  }
}

/** 페이지가 닫혔을 때 context에서 활성 페이지를 찾거나 새로 생성 */
async function recoverPage(context: BrowserContext, fallbackUrl: string): Promise<Page> {
  // 닫히지 않은 페이지 필터링
  const activePages = context.pages().filter(p => !p.isClosed());
  if (activePages.length > 0) {
    const lastPage = activePages[activePages.length - 1];
    console.log(`[gmarket-purchase] 기존 페이지 발견: ${lastPage.url()}`);
    return lastPage;
  }
  // 페이지가 하나도 없으면 새로 생성
  console.log("[gmarket-purchase] 새 페이지 생성");
  const newPage = await context.newPage();
  if (fallbackUrl && fallbackUrl !== "about:blank") {
    await newPage.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await newPage.waitForTimeout(2000);
  }
  return newPage;
}

// ═══════════════════════════════════
// 쿠폰 수집
// ═══════════════════════════════════
async function collectCoupons(page: Page) {
  try {
    // "쿠폰받기" 또는 "쿠폰 다운로드" 버튼 클릭
    const couponBtn = page.locator('a:has-text("쿠폰받기"), button:has-text("쿠폰받기"), a:has-text("쿠폰다운"), button:has-text("쿠폰다운")').first();
    if (await couponBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await couponBtn.click();
      await page.waitForTimeout(2000);

      // 페이지 닫힘 체크
      if (page.isClosed()) {
        console.log("[gmarket-purchase] 쿠폰받기 클릭 후 페이지 닫힘 감지");
        return;
      }

      // 쿠폰 팝업에서 "모두 받기" 또는 개별 쿠폰 받기
      const allCouponBtn = page.locator('button:has-text("모두받기"), button:has-text("모두 받기"), a:has-text("모두받기")').first();
      if (await allCouponBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await allCouponBtn.click();
        await page.waitForTimeout(1000);
      } else {
        // 개별 쿠폰 "받기" 버튼 클릭
        const individualBtns = page.locator('.coupon-download, button:has-text("받기"):not(:has-text("모두"))');
        const count = await individualBtns.count();
        for (let i = 0; i < Math.min(count, 5); i++) {
          try {
            await individualBtns.nth(i).click({ timeout: 1000 });
            await page.waitForTimeout(500);
          } catch { /* skip */ }
        }
      }

      // 팝업 닫기 - X 버튼 클릭 시도 (VIP 쿠폰 팝업 포함)
      const closeBtnSelectors = [
        '.section__iframe-vipcoupon--active button[class*="close"]',
        '.section__iframe-vipcoupon--active .close',
        '.box__coupon-content button[class*="close"]',
        '.popup-close',
        '.modal-close',
        'button[aria-label="닫기"]',
      ];
      for (const selector of closeBtnSelectors) {
        const closeBtn = page.locator(selector).first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await closeBtn.click();
          await page.waitForTimeout(500);
          break;
        }
      }
      // ESC로 닫기 시도
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);

      // 스크롤이 발생했을 수 있으므로 페이지 상단으로 복귀
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
    }
    console.log("[gmarket-purchase] 쿠폰 수집 완료");
  } catch {
    console.log("[gmarket-purchase] 쿠폰 수집 스킵 (쿠폰 없음 또는 오류)");
  }
}

// ═══════════════════════════════════
// 쿠폰 적용 (할인 최대화)
// ═══════════════════════════════════
async function applyCoupon(page: Page) {
  try {
    // 쿠폰 적용 영역 내의 버튼만 대상 (광범위한 "확인" 버튼 오클릭 방지)
    const applyBtn = page.locator('button:has-text("쿠폰적용"), a:has-text("쿠폰적용"), button:has-text("할인적용")').first();
    if (await applyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      // 클릭 전 현재 URL 저장 (네비게이션 감지용)
      const urlBefore = page.url();
      await applyBtn.click();
      await page.waitForTimeout(2000);

      // 페이지 닫힘/네비게이션 체크
      if (page.isClosed()) {
        console.log("[gmarket-purchase] 쿠폰적용 클릭 후 페이지 닫힘 감지");
        return;
      }
      if (page.url() !== urlBefore) {
        console.log(`[gmarket-purchase] 쿠폰적용 클릭 후 페이지 이동 감지: ${urlBefore} → ${page.url()}`);
        return;
      }

      // 쿠폰 팝업/레이어 내에서만 쿠폰 선택 + 적용
      // 쿠폰 팝업 컨테이너 찾기
      const couponLayer = page.locator('[class*="coupon"], [class*="Coupon"], [id*="coupon"], .layer-coupon, .popup-coupon').first();
      if (await couponLayer.isVisible({ timeout: 2000 }).catch(() => false)) {
        // 팝업 내 쿠폰 항목 선택
        const couponItems = couponLayer.locator('li, .coupon-item, [class*="item"]');
        const itemCount = await couponItems.count();
        if (itemCount > 0) {
          await couponItems.first().click();
          await page.waitForTimeout(500);
        }

        // 팝업 내 "적용" 버튼만 클릭 (광범위한 "확인" 버튼 회피)
        const confirmBtn = couponLayer.locator('button:has-text("적용")').first();
        if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirmBtn.click();
          await page.waitForTimeout(1000);
        }
      }
    }
    // 쿠폰 적용 후 남아있는 dimmed 오버레이 제거
    await dismissCouponOverlays(page);

    console.log("[gmarket-purchase] 쿠폰 적용 완료");
  } catch {
    console.log("[gmarket-purchase] 쿠폰 적용 스킵");
    // 에러 발생 시에도 오버레이 정리 시도
    await dismissCouponOverlays(page).catch(() => {});
  }
}

/** 쿠폰 관련 dimmed 오버레이 및 팝업 제거 */
async function dismissCouponOverlays(page: Page) {
  try {
    // 1. ESC 키로 팝업 닫기 시도
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // 2. 모든 쿠폰 관련 오버레이/팝업 강제 제거
    await page.evaluate(() => {
      // CouponBoxDimmed 제거
      const dimmed = document.getElementById("CouponBoxDimmed");
      if (dimmed) {
        dimmed.style.display = "none";
        dimmed.remove();
      }

      // VIP 쿠폰 팝업 비활성화 (section__iframe-vipcoupon--active)
      document.querySelectorAll('.section__iframe-vipcoupon--active').forEach((el) => {
        el.classList.remove("section__iframe-vipcoupon--active");
        (el as HTMLElement).style.display = "none";
      });

      // box__coupon-content 제거 (구매 버튼 가리는 요소)
      document.querySelectorAll('.box__coupon-content').forEach((el) => {
        (el as HTMLElement).style.display = "none";
      });

      // 쿠폰 관련 dimmed/overlay 전부 정리
      document.querySelectorAll('.dimmed, [id*="Dimmed"], [class*="dimmed"]').forEach((el) => {
        const htmlEl = el as HTMLElement;
        if (htmlEl.id.includes("Coupon") || htmlEl.className.includes("coupon") || htmlEl.className.includes("Coupon")) {
          htmlEl.style.display = "none";
          htmlEl.remove();
        }
      });

      // 쿠폰 레이어/팝업 닫기
      document.querySelectorAll('[class*="coupon-layer"], [class*="CouponBox"], [id*="CouponBox"], [class*="vipcoupon"]').forEach((el) => {
        (el as HTMLElement).style.display = "none";
      });

      // inert 속성 제거
      document.querySelectorAll('[inert]').forEach((el) => {
        el.removeAttribute("inert");
      });

      // 스크롤 복귀
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
  } catch {
    // 무시
  }
}

// ═══════════════════════════════════
// 구매하기 버튼 클릭
// ═══════════════════════════════════
async function clickPurchaseButton(page: Page) {
  // 구매 버튼 클릭 전 모든 오버레이/쿠폰 팝업 정리
  await page.evaluate(() => {
    // CouponBoxDimmed 및 기타 dimmed 오버레이 제거
    document.querySelectorAll('#CouponBoxDimmed, .dimmed, [id*="Dimmed"]').forEach((el) => {
      (el as HTMLElement).style.display = "none";
      el.remove();
    });
    // VIP 쿠폰 팝업 비활성화
    document.querySelectorAll('.section__iframe-vipcoupon--active').forEach((el) => {
      el.classList.remove("section__iframe-vipcoupon--active");
      (el as HTMLElement).style.display = "none";
    });
    document.querySelectorAll('.box__coupon-content').forEach((el) => {
      (el as HTMLElement).style.display = "none";
    });
    // inert 속성 제거
    document.querySelectorAll('[inert]').forEach((el) => {
      el.removeAttribute("inert");
    });
    // 스크롤 복귀
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);

  // "선택" 버튼 먼저 클릭 (수량 확정, class=bt_select)
  const selectBtn = page.locator('button.bt_select').first();
  if (await selectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await selectBtn.click({ force: true });
    await page.waitForTimeout(1000);
  }

  // alert 핸들러 등록 (중복 등록 방지 - once 사용)
  page.once("dialog", async (dialog) => {
    console.log(`[gmarket-purchase] dialog: ${dialog.message()}`);
    await dialog.accept();
  });

  // 구매하기 버튼 클릭 (#coreInsOrderBtn 우선)
  const buyBtn = page.locator('#coreInsOrderBtn, button:has-text("구매하기"), a:has-text("구매하기")').first();
  await buyBtn.waitFor({ state: "visible", timeout: 10000 });

  // force: true로 클릭하여 오버레이가 남아있더라도 통과
  await buyBtn.click({ force: true });

  // 주문 결제 페이지 로딩 대기
  await page.waitForURL((url) => url.toString().includes("order") || url.toString().includes("checkout"), { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(3000);
  console.log("[gmarket-purchase] 주문결제 페이지 이동 완료");
}

// ═══════════════════════════════════
// 배송지 변경
// ═══════════════════════════════════

/** 배송지 변경 iframe (gw로 시작하는 동적 이름)을 찾는다 */
function findShippingFrame(page: Page): Frame | null {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes("mmyg.gmarket.co.kr/ShippingAddress") || url.includes("ShippingAddress/GetAddress")) {
      return frame;
    }
  }
  // fallback: gw*_iframe 패턴
  for (const frame of page.frames()) {
    if (frame.name().match(/^gw\d+_iframe$/)) return frame;
  }
  return null;
}

/** 주소 검색 iframe (addr_search_frame 등)을 찾는다 */
function findAddressSearchFrame(page: Page): Frame | null {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes("address.gmarket.com") || frame.name().includes("addr_search")) {
      return frame;
    }
  }
  return null;
}

async function changeShippingAddress(page: Page, order: PurchaseOrderInfo) {
  try {
    // 1. "배송지 변경" 버튼 클릭
    const changeBtn = page.locator('#xo_id_open_address_book, button:has-text("배송지 변경")').first();
    await changeBtn.waitFor({ state: "visible", timeout: 10000 });
    await changeBtn.click();
    await page.waitForTimeout(2000);

    // 2. 배송지 iframe 찾기
    const shippingFrame = findShippingFrame(page);
    if (!shippingFrame) {
      throw new Error("배송지 변경 iframe을 찾을 수 없습니다");
    }

    // 3. "배송지 추가하기" 클릭
    const addBtn = shippingFrame.locator('button:has-text("배송지 추가하기")');
    await addBtn.waitFor({ state: "visible", timeout: 10000 });
    await addBtn.click();
    await page.waitForTimeout(1500);

    // 4. 이름 입력
    const nameInput = shippingFrame.getByRole("textbox", { name: "이름" });
    await nameInput.waitFor({ state: "visible", timeout: 5000 });
    await nameInput.fill(order.recipientName);

    // 5. 연락처 입력 (고정값 사용)
    const phoneInput = shippingFrame.getByRole("textbox", { name: "연락처" });
    await phoneInput.fill("01065644459");

    // 6. 우편번호 찾기 → 주소 검색
    const zipBtn = shippingFrame.locator('button:has-text("우편번호 찾기")');
    await zipBtn.waitFor({ state: "visible", timeout: 5000 });
    await zipBtn.click();
    await page.waitForTimeout(2000);

    // 7. 주소 검색 iframe 내에서 검색
    const addrFrame = findAddressSearchFrame(page);
    if (!addrFrame) {
      throw new Error("주소 검색 iframe을 찾을 수 없습니다");
    }

    // 도로명주소에서 검색 키워드 추출 (동 이름이나 도로명)
    const searchKeyword = extractSearchKeyword(order.address);
    console.log(`[gmarket-purchase] 주소 검색 키워드: "${searchKeyword}"`);

    const addrInput = addrFrame.getByRole("searchbox", { name: "주소를 입력해 주세요" });
    await addrInput.waitFor({ state: "visible", timeout: 5000 });
    await addrInput.fill(searchKeyword);

    const searchBtn = addrFrame.getByRole("button", { name: "주소검색" });
    await searchBtn.click();
    await page.waitForTimeout(2000);

    // 8. 검색 결과에서 가장 일치하는 항목 클릭
    let resultButtons = addrFrame.locator("ul > li > button:nth-child(2)");
    let resultCount = await resultButtons.count();

    // 검색 결과가 없으면 키워드를 줄여서 재시도
    if (resultCount === 0) {
      // 번지 제거 후 도로명만으로 재검색 (예: "상신하길로 295" → "상신하길로")
      const roadOnly = searchKeyword.replace(/\s+\d[\d-]*$/, "").trim();
      if (roadOnly && roadOnly !== searchKeyword) {
        console.log(`[gmarket-purchase] 주소 재검색 (도로명만): "${roadOnly}"`);
        await addrInput.fill(roadOnly);
        await searchBtn.click();
        await page.waitForTimeout(2000);
        resultButtons = addrFrame.locator("ul > li > button:nth-child(2)");
        resultCount = await resultButtons.count();
      }
    }

    // 그래도 없으면 읍/면/동 포함하여 재검색
    if (resultCount === 0) {
      const addrParts = order.address.replace(/^\[?\d{5}\]?\s*/, "").replace(/\(.*?\)/g, "").trim().split(/\s+/);
      for (let i = 0; i < addrParts.length; i++) {
        if (addrParts[i].match(/(동|읍|면)\d*$/)) {
          const areaKeyword = addrParts.slice(i).join(" ");
          if (areaKeyword !== searchKeyword) {
            console.log(`[gmarket-purchase] 주소 재검색 (동/읍/면 포함): "${areaKeyword}"`);
            await addrInput.fill(areaKeyword);
            await searchBtn.click();
            await page.waitForTimeout(2000);
            resultButtons = addrFrame.locator("ul > li > button:nth-child(2)");
            resultCount = await resultButtons.count();
          }
          break;
        }
      }
    }

    if (resultCount === 0) {
      throw new Error(`주소 검색 결과 없음: "${searchKeyword}"`);
    }

    // 우편번호가 일치하는 결과를 반드시 찾기
    let bestIdx = -1;
    if (order.postalCode) {
      for (let i = 0; i < Math.min(resultCount, 30); i++) {
        const btnText = await resultButtons.nth(i).textContent() || "";
        if (btnText.includes(order.postalCode)) {
          bestIdx = i;
          console.log(`[gmarket-purchase] 우편번호 ${order.postalCode} 일치 결과 발견 (index: ${i})`);
          break;
        }
      }
    }

    // 우편번호 매칭 실패 시: 검색어를 변경하여 재시도
    if (bestIdx === -1 && order.postalCode) {
      // 우편번호 자체로 직접 검색
      console.log(`[gmarket-purchase] 우편번호로 직접 검색: "${order.postalCode}"`);
      await addrInput.fill(order.postalCode);
      await searchBtn.click();
      await page.waitForTimeout(2000);
      resultButtons = addrFrame.locator("ul > li > button:nth-child(2)");
      resultCount = await resultButtons.count();

      for (let i = 0; i < Math.min(resultCount, 30); i++) {
        const btnText = await resultButtons.nth(i).textContent() || "";
        if (btnText.includes(order.postalCode)) {
          bestIdx = i;
          console.log(`[gmarket-purchase] 우편번호 검색으로 일치 결과 발견 (index: ${i})`);
          break;
        }
      }
    }

    // 그래도 못 찾으면 에러 (잘못된 주소를 선택하는 것보다 실패가 안전)
    if (bestIdx === -1) {
      if (order.postalCode) {
        throw new Error(`우편번호 ${order.postalCode}에 일치하는 주소를 찾을 수 없습니다 (검색어: "${searchKeyword}")`);
      }
      // 우편번호가 없는 경우에만 첫 번째 결과 사용 (fallback)
      console.warn("[gmarket-purchase] 우편번호 정보 없음, 첫 번째 검색 결과 사용");
      bestIdx = 0;
    }

    await resultButtons.nth(bestIdx).click();
    await page.waitForTimeout(1500);

    // 9. "이 위치로 배송지 설정" 클릭
    const setLocationBtn = addrFrame.getByRole("button", { name: "이 위치로 배송지 설정" });
    await setLocationBtn.waitFor({ state: "visible", timeout: 5000 });
    await setLocationBtn.click();
    await page.waitForTimeout(2000);

    // 10. 상세주소 입력
    if (order.addressDetail) {
      const detailInput = shippingFrame.getByRole("textbox", { name: /상세주소/ });
      await detailInput.waitFor({ state: "visible", timeout: 5000 });
      await detailInput.fill(order.addressDetail);
    }

    // 11. 배송 요청사항 입력
    if (order.deliveryMemo) {
      const memoSelect = shippingFrame.getByRole("combobox", { name: /배송 요청사항/ });
      if (await memoSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
        await memoSelect.selectOption({ label: "직접 입력" });
        await page.waitForTimeout(500);
        // "직접 입력" 선택 후 나타나는 텍스트 입력 필드
        const memoInput = shippingFrame.getByRole("textbox", { name: /배송 요청사항/ }).or(
          shippingFrame.locator('input[placeholder*="배송"], textarea[placeholder*="배송"]')
        ).first();
        if (await memoInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await memoInput.fill(order.deliveryMemo);
        }
      }
    }

    // 12. "저장하기" 버튼 클릭
    const saveBtn = shippingFrame.getByRole("button", { name: "저장하기" });
    await saveBtn.waitFor({ state: "visible", timeout: 5000 });
    await saveBtn.click();
    await page.waitForTimeout(2000);

    // 13. "배송 요청사항을 입력하지 않으셨습니다" 확인 팝업 처리
    const confirmBtn = shippingFrame.getByRole("button", { name: "확인" });
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
      console.log("[gmarket-purchase] 배송 요청사항 미입력 확인 팝업 처리");
      await page.waitForTimeout(2000);
    }

    // 14. 저장 후 배송지 목록으로 돌아감 → 새 배송지 "선택" 클릭
    const updatedShippingFrame = findShippingFrame(page) || shippingFrame;

    // "선택" 버튼 클릭 (방금 저장한 배송지의 선택 버튼)
    const selectAddrBtn = updatedShippingFrame.locator('button:has-text("선택")').first();
    if (await selectAddrBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await selectAddrBtn.click();
      console.log("[gmarket-purchase] 새 배송지 선택 완료");
      await page.waitForTimeout(2000);
    }

    // 15. 배송지 변경 다이얼로그가 닫힐 때까지 대기
    const dialogClosed = await page.waitForFunction(() => {
      const dialog = document.querySelector('.box__layer.box__checkout-iframe');
      if (!dialog) return true;
      const style = window.getComputedStyle(dialog);
      return style.display === 'none' || style.visibility === 'hidden';
    }, { timeout: 5000 }).then(() => true).catch(() => false);

    if (!dialogClosed) {
      // dialog 닫기 시도 1: X(닫기) 버튼 클릭
      console.log("[gmarket-purchase] dialog 닫기 버튼 클릭 시도");
      const closeBtn = page.locator('.box__layer.box__checkout-iframe button.button__close, .box__layer.box__checkout-iframe [class*="close"]').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(2000);
      }

      // dialog 닫기 시도 2: 여전히 열려있으면 JS로 강제 닫기 + 페이지 refresh 이벤트 트리거
      const stillOpen = await page.evaluate(() => {
        const dialog = document.querySelector('.box__layer.box__checkout-iframe') as HTMLElement;
        if (dialog && window.getComputedStyle(dialog).display !== 'none') {
          // dimmed와 dialog를 완전히 제거 (display:none 대신 remove)
          dialog.remove();
          return true;
        }
        return false;
      });
      if (stillOpen) {
        console.log("[gmarket-purchase] dialog 강제 제거 완료");
        await page.waitForTimeout(1000);
      }
    }
    await page.waitForTimeout(1000);

    // 16. "안심번호 사용하기" 체크박스 클릭
    await checkSafeNumber(page);

    console.log(`[gmarket-purchase] 배송지 변경 완료: ${order.recipientName}`);
  } catch (err) {
    console.error("[gmarket-purchase] 배송지 변경 오류:", err);
    throw new Error(`배송지 변경 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 주소에서 검색 키워드 추출 (도로명 우선, 동/읍/면 fallback) */
function extractSearchKeyword(address: string): string {
  // 우편번호 제거
  let addr = address.replace(/^\[?\d{5}\]?\s*/, "").trim();
  // 괄호 안 내용 제거
  addr = addr.replace(/\(.*?\)/g, "").trim();
  const parts = addr.split(/\s+/);

  // 1순위: 도로명(~로, ~길) + 이후 번지 (가장 정확한 검색 결과)
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].match(/(로|길)\d*$/)) {
      return parts.slice(i).join(" ");
    }
  }
  // 2순위: 동/읍/면 이름 + 이후
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].match(/(동|읍|면)\d*$/)) {
      return parts.slice(i).join(" ");
    }
  }
  // fallback: 뒤에서 3단어
  return parts.slice(-3).join(" ");
}

// ═══════════════════════════════════
// "이 배송지 맞나요?" 팝업 처리
// ═══════════════════════════════════
async function handleAddressConfirmPopup(page: Page) {
  try {
    // "이 배송지 맞나요?" 팝업 내 "결제하기" 버튼 (파란색)
    // 팝업에는 "배송지 변경하기"와 "결제하기" 두 버튼이 있음
    const popupPayBtn = page.locator('[class*="confirm"] button:has-text("결제하기"), [class*="modal"] button:has-text("결제하기"), [class*="popup"] button:has-text("결제하기"), [class*="layer"] button:has-text("결제하기"), [class*="dialog"] button:has-text("결제하기")').first();
    if (await popupPayBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await popupPayBtn.click();
      console.log("[gmarket-purchase] '이 배송지 맞나요?' 팝업 → 결제하기 클릭");
      await page.waitForTimeout(2000);
      return;
    }

    // fallback: "배송지 맞나요" 텍스트가 있는 컨테이너 내의 결제하기 버튼
    const hasAddressConfirm = await page.evaluate(() => {
      const els = document.querySelectorAll('div, section, aside');
      for (const el of els) {
        const text = el.textContent || "";
        if (text.includes("배송지 맞나요") || text.includes("배송지가 맞나요")) {
          const btn = el.querySelector('button');
          if (btn && (btn.textContent || "").includes("결제하기")) {
            (btn as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }).catch(() => false);

    if (hasAddressConfirm) {
      console.log("[gmarket-purchase] '이 배송지 맞나요?' 팝업 → JS로 결제하기 클릭");
      await page.waitForTimeout(2000);
    }
  } catch {
    // 팝업이 없으면 무시 (정상 흐름)
  }
}

// ═══════════════════════════════════
// 결제 처리 (결제하기 → 키패드 비밀번호 입력)
// ═══════════════════════════════════
async function processPayment(page: Page, paymentPin: string) {
  // 결제하기 버튼 클릭 전 dimmed 오버레이 제거
  await page.evaluate(() => {
    document.querySelectorAll('.dimmed, [id*="Dimmed"], [class*="dimmed"]').forEach((el) => {
      (el as HTMLElement).style.display = "none";
      el.remove();
    });
    document.querySelectorAll('[inert]').forEach((el) => {
      el.removeAttribute("inert");
    });
    // 쿠폰 관련 오버레이도 정리
    document.querySelectorAll('[class*="coupon-layer"], [class*="CouponBox"], [id*="CouponBox"]').forEach((el) => {
      (el as HTMLElement).style.display = "none";
    });
  }).catch(() => {});
  await page.waitForTimeout(300);

  // "결제하기" 버튼 클릭
  const payBtn = page.locator('button:has-text("결제하기"), a:has-text("결제하기")').first();
  await payBtn.waitFor({ state: "visible", timeout: 10000 });
  await payBtn.click({ force: true });
  console.log("[gmarket-purchase] 결제하기 버튼 클릭 완료");

  // "이 배송지 맞나요?" 확인 팝업 처리 (반복 구매 시 나타날 수 있음)
  await page.waitForTimeout(2000);
  await handleAddressConfirmPopup(page);

  // 스마일페이 결제 프레임 대기 (동적 이름 탐색)
  let smilepayFrame: Frame | null = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.waitForTimeout(2000);
    // sp_로 시작하는 iframe 또는 smilepay URL 포함 iframe 찾기
    for (const frame of page.frames()) {
      const name = frame.name();
      const url = frame.url();
      if (name.match(/^sp_\d+_iframe$/) || url.includes("smilepay") || url.includes("SmilePay")) {
        smilepayFrame = frame;
        console.log(`[gmarket-purchase] 스마일페이 프레임 발견: name="${name}", url="${url}"`);
        break;
      }
    }
    if (smilepayFrame) break;
    if (attempt % 5 === 4) {
      // 디버그: 현재 존재하는 iframe 목록 출력
      const frameNames = page.frames().map(f => `${f.name()}(${f.url().slice(0, 50)})`);
      console.log(`[gmarket-purchase] 프레임 목록 (시도 ${attempt + 1}):`, frameNames);
    }
  }

  if (!smilepayFrame) {
    // 최종 디버그: 모든 프레임 정보 출력
    const allFrames = page.frames().map(f => ({ name: f.name(), url: f.url() }));
    console.log("[gmarket-purchase] 전체 프레임 목록:", JSON.stringify(allFrames, null, 2));
    throw new Error("스마일페이 결제 프레임을 찾을 수 없습니다");
  }

  // 키패드 버튼 매핑 (OCR)
  const keyMap = await readKeypadNumbers(smilepayFrame);
  console.log("[gmarket-purchase] 키패드 매핑:", keyMap);

  // 비밀번호 6자리 입력
  for (const digit of paymentPin) {
    const btnIndex = keyMap[digit];
    if (btnIndex === undefined) {
      throw new Error(`키패드에서 숫자 ${digit}를 찾을 수 없습니다`);
    }

    const buttons = smilepayFrame.locator("button:has(.KeyboardButton__Wrapper)");
    await buttons.nth(btnIndex).click();
    await page.waitForTimeout(300);
  }

  console.log("[gmarket-purchase] 비밀번호 입력 완료");
  // 결제 완료 대기
  await page.waitForTimeout(5000);
}

// ═══════════════════════════════════
// 키패드 OCR - 스프라이트 이미지에서 숫자 인식
// ═══════════════════════════════════
async function readKeypadNumbers(frame: Frame): Promise<Record<string, number>> {
  // 스프라이트 이미지 base64 추출 + background-position 매핑
  const keypadData = await frame.evaluate(() => {
    const buttons = document.querySelectorAll("button");
    const keypadBtns = Array.from(buttons).filter(b => b.querySelector(".KeyboardButton__Wrapper"));

    // 각 버튼의 background 정보를 정확하게 수집
    const positions = keypadBtns.map((btn, idx) => {
      const wrapper = btn.querySelector(".KeyboardButton__Wrapper");
      if (!wrapper) return null;
      const s = window.getComputedStyle(wrapper);
      return {
        index: idx,
        bgImage: s.backgroundImage,
        bgPosition: s.backgroundPosition,
        bgSize: s.backgroundSize,
        width: parseFloat(s.width),
        height: parseFloat(s.height),
      };
    }).filter(Boolean);

    return { positions };
  });

  if (!keypadData?.positions?.length) {
    throw new Error("키패드 버튼을 찾을 수 없습니다");
  }

  // 첫 번째 유효 버튼에서 base64 이미지 추출
  const firstPos = keypadData.positions[0]!;
  const base64Match = firstPos.bgImage.match(/base64,\s*([A-Za-z0-9+/=]+)/);
  if (!base64Match) {
    throw new Error("키패드 이미지 base64 추출 실패");
  }

  const imageBuffer = Buffer.from(base64Match[1], "base64");
  const metadata = await sharp(imageBuffer).metadata();
  const imgWidth = metadata.width || 1;
  const imgHeight = metadata.height || 1;
  console.log(`[keypad-ocr] 스프라이트 이미지: ${imgWidth}x${imgHeight}`);

  // tesseract 워커 생성
  const worker = await Tesseract.createWorker("eng", undefined, {
    workerPath: TESSERACT_WORKER_PATH,
  });
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: "10" as unknown as Tesseract.PSM,
  });

  try {
    const keyMap: Record<string, number> = {};

    // 방법 1: background-position 값을 직접 사용하여 정확한 크롭
    for (const pos of keypadData.positions) {
      if (!pos) continue;

      // background-position 파싱 (예: "-60px -30px" 또는 "0px 0px")
      const bpParts = pos.bgPosition.match(/-?[\d.]+/g);
      if (!bpParts || bpParts.length < 2) continue;

      // background-position은 음수 = 이미지를 왼쪽/위로 이동 = 오른쪽/아래 영역 표시
      const offsetX = Math.abs(parseFloat(bpParts[0]));
      const offsetY = Math.abs(parseFloat(bpParts[1]));

      // backgroundSize 파싱하여 스케일 계산
      let scaleX = 1;
      let scaleY = 1;
      if (pos.bgSize && pos.bgSize !== "auto") {
        const sizeParts = pos.bgSize.match(/[\d.]+/g);
        if (sizeParts && sizeParts.length >= 2) {
          const bgW = parseFloat(sizeParts[0]);
          const bgH = parseFloat(sizeParts[1]);
          if (bgW > 0 && bgH > 0) {
            scaleX = imgWidth / bgW;
            scaleY = imgHeight / bgH;
          }
        }
      }

      // 실제 이미지에서의 크롭 영역 계산
      const left = Math.round(offsetX * scaleX);
      const top = Math.round(offsetY * scaleY);
      const cropW = Math.round(pos.width * scaleX);
      const cropH = Math.round(pos.height * scaleY);

      // 범위 체크
      const safeLeft = Math.min(left, imgWidth - 1);
      const safeTop = Math.min(top, imgHeight - 1);
      const safeW = Math.min(cropW, imgWidth - safeLeft);
      const safeH = Math.min(cropH, imgHeight - safeTop);

      if (safeW <= 2 || safeH <= 2) continue;

      console.log(`[keypad-ocr] btn${pos.index}: bgPos="${pos.bgPosition}" → crop(${safeLeft},${safeTop},${safeW}x${safeH})`);

      try {
        // 이미지 전처리: 크롭 → 확대 → 이진화
        const cellBuffer = await sharp(imageBuffer)
          .extract({ left: safeLeft, top: safeTop, width: safeW, height: safeH })
          .resize(200, 200, { fit: "fill" })
          .grayscale()
          .negate()
          .normalize()
          .sharpen()
          .png()
          .toBuffer();

        const { data: { text } } = await worker.recognize(cellBuffer);
        const digit = text.trim().replace(/\D/g, "");
        if (digit.length === 1) {
          keyMap[digit] = pos.index;
          console.log(`[keypad-ocr] btn${pos.index} → digit "${digit}"`);
        } else if (digit.length > 1) {
          // 여러 숫자가 인식된 경우 첫 번째만 사용
          keyMap[digit[0]] = pos.index;
          console.log(`[keypad-ocr] btn${pos.index} → digit "${digit[0]}" (원본: "${digit}")`);
        }
      } catch (err) {
        console.log(`[keypad-ocr] btn${pos.index} 크롭 OCR 실패:`, err);
      }
    }

    console.log(`[keypad-ocr] 1차 결과: ${Object.keys(keyMap).length}/10 (${JSON.stringify(keyMap)})`);

    // 방법 2: 미인식 버튼에 대해 스크린샷 fallback (다양한 전처리 시도)
    if (Object.keys(keyMap).length < 10) {
      console.log("[keypad-ocr] 스크린샷 fallback 시작...");
      const buttons = frame.locator("button:has(.KeyboardButton__Wrapper)");
      const count = await buttons.count();

      for (let i = 0; i < count; i++) {
        if (Object.values(keyMap).includes(i)) continue;

        try {
          const btnScreenshot = await buttons.nth(i).screenshot({ type: "png" });

          // 전처리 변형 여러 개 시도
          const variants = [
            // 변형1: grayscale + negate + normalize
            sharp(btnScreenshot).resize(200, 200).grayscale().negate().normalize().sharpen().png().toBuffer(),
            // 변형2: threshold 적용
            sharp(btnScreenshot).resize(200, 200).grayscale().threshold(128).negate().png().toBuffer(),
            // 변형3: 높은 대비
            sharp(btnScreenshot).resize(200, 200).grayscale().linear(2, -128).negate().png().toBuffer(),
          ];

          for (const variantPromise of variants) {
            try {
              const processed = await variantPromise;
              const { data: { text } } = await worker.recognize(processed);
              const digit = text.trim().replace(/\D/g, "");
              if (digit.length >= 1 && !keyMap[digit[0]]) {
                keyMap[digit[0]] = i;
                console.log(`[keypad-ocr] fallback btn${i} → digit "${digit[0]}"`);
                break;
              }
            } catch { /* 다음 변형 시도 */ }
          }
        } catch {
          console.log(`[keypad-ocr] fallback btn${i} 스크린샷 실패`);
        }
      }
    }

    // 방법 3: 전체 스프라이트 이미지를 그리드로 균등 분할하여 OCR
    if (Object.keys(keyMap).length < 10) {
      console.log("[keypad-ocr] 그리드 분할 OCR 시도...");
      const cols = 4;
      const rows = 3;
      const gridCellW = Math.floor(imgWidth / cols);
      const gridCellH = Math.floor(imgHeight / rows);

      // 각 그리드 셀의 숫자를 인식
      const gridResults: { digit: string; col: number; row: number }[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          try {
            const cellBuf = await sharp(imageBuffer)
              .extract({ left: c * gridCellW, top: r * gridCellH, width: gridCellW, height: gridCellH })
              .resize(200, 200, { fit: "fill" })
              .grayscale()
              .negate()
              .normalize()
              .sharpen()
              .png()
              .toBuffer();

            const { data: { text } } = await worker.recognize(cellBuf);
            const digit = text.trim().replace(/\D/g, "");
            if (digit.length >= 1) {
              gridResults.push({ digit: digit[0], col: c, row: r });
            }
          } catch { /* skip */ }
        }
      }

      // 그리드 결과를 button index에 매핑
      // 각 버튼의 background-position으로 어떤 그리드 셀에 해당하는지 매칭
      for (const pos of keypadData.positions) {
        if (!pos || Object.values(keyMap).includes(pos.index)) continue;

        const bpParts = pos.bgPosition.match(/-?[\d.]+/g);
        if (!bpParts || bpParts.length < 2) continue;
        const ox = Math.abs(parseFloat(bpParts[0]));
        const oy = Math.abs(parseFloat(bpParts[1]));

        // bgSize 스케일 계산
        let sx = 1, sy = 1;
        if (pos.bgSize && pos.bgSize !== "auto") {
          const sp = pos.bgSize.match(/[\d.]+/g);
          if (sp && sp.length >= 2) {
            const bw = parseFloat(sp[0]), bh = parseFloat(sp[1]);
            if (bw > 0 && bh > 0) { sx = imgWidth / bw; sy = imgHeight / bh; }
          }
        }

        const pixX = ox * sx;
        const pixY = oy * sy;
        const gridCol = Math.round(pixX / gridCellW);
        const gridRow = Math.round(pixY / gridCellH);

        const match = gridResults.find(g => g.col === gridCol && g.row === gridRow);
        if (match && !keyMap[match.digit]) {
          keyMap[match.digit] = pos.index;
          console.log(`[keypad-ocr] grid(${gridCol},${gridRow}) → digit "${match.digit}" → btn${pos.index}`);
        }
      }
    }

    console.log(`[keypad-ocr] 최종 결과: ${Object.keys(keyMap).length}/10 (${JSON.stringify(keyMap)})`);

    if (Object.keys(keyMap).length < 10) {
      // 누락된 숫자와 매핑되지 않은 버튼 정보 출력
      const allDigits = "0123456789".split("");
      const missing = allDigits.filter(d => !(d in keyMap));
      const mappedIndices = new Set(Object.values(keyMap));
      const unmappedBtns = keypadData.positions
        .filter(p => p && !mappedIndices.has(p.index))
        .map(p => p!.index);
      console.log(`[keypad-ocr] 누락 숫자: [${missing.join(",")}], 미매핑 버튼: [${unmappedBtns.join(",")}]`);

      // 누락 숫자가 1~2개이고 미매핑 버튼도 같은 수(+빈칸/삭제 2개)이면 추론 시도
      // 12버튼 중 10개 숫자 + 2개 기능버튼(빈칸, 삭제)
      // 미매핑 버튼에서 기능버튼(보통 index 8, 11 또는 맨 마지막 2개)을 제외
      if (missing.length <= 2 && unmappedBtns.length === missing.length + 2) {
        // 기능 버튼은 보통 마지막 행의 양 끝 (index 8, 11)
        const funcBtns = unmappedBtns.filter(i => i === 8 || i === 11 || i >= 10);
        const digitBtns = unmappedBtns.filter(i => !funcBtns.includes(i));
        if (digitBtns.length === missing.length) {
          for (let i = 0; i < missing.length; i++) {
            keyMap[missing[i]] = digitBtns[i];
            console.log(`[keypad-ocr] 추론: digit "${missing[i]}" → btn${digitBtns[i]}`);
          }
        }
      }
    }

    if (Object.keys(keyMap).length < 10) {
      throw new Error(`키패드 OCR 실패: ${Object.keys(keyMap).length}/10 숫자만 인식됨 (${JSON.stringify(keyMap)})`);
    }

    return keyMap;
  } finally {
    await worker.terminate();
  }
}

// ═══════════════════════════════════
// 주문정보 추출 (주문번호 + 결제방식 + 원가)
// ═══════════════════════════════════

/** 카드사명 매핑 */
function extractCardBrand(text: string): string | undefined {
  const cardBrands: [string[], string][] = [
    [["삼성", "samsung"], "삼성"],
    [["국민", "kb"], "국민"],
    [["신한", "shinhan"], "신한"],
    [["현대", "hyundai"], "현대"],
    [["롯데", "lotte"], "롯데"],
    [["하나", "hana", "외환"], "하나"],
    [["우리", "woori"], "우리"],
    [["비씨", "bc"], "비씨"],
    [["농협", "nh"], "농협"],
    [["씨티", "citi"], "씨티"],
    [["카카오", "kakao"], "카카오"],
    [["토스", "toss"], "토스"],
  ];
  const lower = text.toLowerCase();
  for (const [keywords, brand] of cardBrands) {
    if (keywords.some(k => lower.includes(k))) return brand;
  }
  return undefined;
}

async function extractOrderInfo(page: Page, _context: BrowserContext): Promise<SingleOrderResult> {
  // 결제 완료 후 주문내역 API에서 주문번호 + payNo를 추출하고,
  // 주문 상세 페이지(/ko/pc/detail/basic/{payNo})에서 결제방식 + 원가를 추출

  await page.waitForTimeout(2000);

  // 주문내역 API에서 주문번호 + payNo 추출
  console.log("[gmarket-purchase] 주문내역 API에서 주문번호 + payNo 추출 시도...");

  const apiPromise = page.waitForResponse(
    (res) => res.url().includes("/api/pays/paging") && res.status() === 200,
    { timeout: 30000 }
  );

  await page.goto("https://my.gmarket.co.kr/ko/pc/main", { waitUntil: "networkidle", timeout: 30000 });

  const apiRes = await apiPromise;

  interface PayApiResponse {
    data?: {
      payBundleList?: Array<{
        payNo: number;
        orderList: Array<{ orderNo: number | string }>;
      }>;
    };
  }

  const data = await apiRes.json() as PayApiResponse;
  const firstBundle = data?.data?.payBundleList?.[0];

  const orderNo = firstBundle?.orderList?.[0]?.orderNo
    ? String(firstBundle.orderList[0].orderNo)
    : null;
  const payNo = firstBundle?.payNo ? String(firstBundle.payNo) : null;

  if (!orderNo) {
    throw new Error("주문번호를 찾을 수 없습니다. 결제가 완료되었는지 확인하세요.");
  }

  console.log(`[gmarket-purchase] 주문내역 API - 주문번호: ${orderNo}, payNo: ${payNo}`);

  // 주문 상세 페이지에서 결제방식 + 원가 추출
  let cost: number | undefined;
  let paymentMethod: string | undefined;

  if (payNo) {
    try {
      console.log(`[gmarket-purchase] 주문 상세 페이지 이동: /ko/pc/detail/basic/${payNo}`);
      await page.goto(`https://my.gmarket.co.kr/ko/pc/detail/basic/${payNo}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      const paymentInfo = await page.evaluate(() => {
        const bodyText = document.body.innerText;

        // 결제방식 추출: "Smile Pay 삼성카드 (일시불)" 형태
        let cardText: string | null = null;
        // 패턴1: "Smile Pay {카드명} (" 형태
        const smileMatch = bodyText.match(/Smile\s*Pay\s+(.+?)\s*\(/);
        if (smileMatch) cardText = smileMatch[1].trim();
        // 패턴2: "결제방식" 다음 줄에서 찾기
        if (!cardText) {
          const lines = bodyText.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === "결제방식" && i + 1 < lines.length) {
              const nextLine = lines[i + 1].trim();
              const m = nextLine.match(/Smile\s*Pay\s+(.+?)\s*\(/);
              if (m) cardText = m[1].trim();
              break;
            }
          }
        }

        // 원가 추출: "결제금액 / 1개" 옆의 금액 또는 "총 결제금액" 옆의 금액
        let amount: number | null = null;
        // 패턴1: "결제금액 / N개  18,900원"
        const perItemMatch = bodyText.match(/결제금액\s*\/\s*\d+개\s*([0-9,]+)\s*원/);
        if (perItemMatch) amount = parseInt(perItemMatch[1].replace(/,/g, ""));
        // 패턴2: "총 결제금액  18,900원"
        if (!amount) {
          const totalMatch = bodyText.match(/총\s*결제금액\s*([0-9,]+)\s*원/);
          if (totalMatch) amount = parseInt(totalMatch[1].replace(/,/g, ""));
        }
        // 패턴3: 일반 "결제금액" 패턴
        if (!amount) {
          const generalMatch = bodyText.match(/결제금액[^0-9]*([0-9,]+)\s*원/);
          if (generalMatch) amount = parseInt(generalMatch[1].replace(/,/g, ""));
        }

        return { cardText, amount };
      });

      console.log(`[gmarket-purchase] 주문 상세 - 결제방식: "${paymentInfo.cardText}", 금액: ${paymentInfo.amount}`);

      if (paymentInfo.cardText) {
        paymentMethod = extractCardBrand(paymentInfo.cardText);
        if (paymentMethod) {
          console.log(`[gmarket-purchase] 결제 카드: "${paymentMethod}"`);
        }
      }

      if (paymentInfo.amount) {
        cost = paymentInfo.amount;
        console.log(`[gmarket-purchase] 결제 금액: ${cost.toLocaleString()}원`);
      }
    } catch (err) {
      console.log("[gmarket-purchase] 주문 상세 페이지 추출 오류 (주문번호는 확보됨):", err);
    }
  } else {
    console.log("[gmarket-purchase] payNo를 찾을 수 없어 상세 페이지 접근 불가");
  }

  return { purchaseOrderNo: orderNo, cost, paymentMethod };
}
