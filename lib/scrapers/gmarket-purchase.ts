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

    // 2. 각 주문건 순차 처리
    for (const order of orders) {
      onProgress?.(order.orderId, "processing", "구매 진행 중...");
      try {
        const { purchaseOrderNo, cost, paymentMethod } = await processSingleOrder(page, context, order, paymentPin);
        result.success.push({ orderId: order.orderId, purchaseOrderNo, cost, paymentMethod });
        onProgress?.(order.orderId, "success", `주문번호: ${purchaseOrderNo}${cost ? ` (원가: ${cost.toLocaleString()}원)` : ""}${paymentMethod ? ` [${paymentMethod}]` : ""}`, purchaseOrderNo);
        console.log(`[gmarket-purchase] 주문 성공: ${order.orderId} → ${purchaseOrderNo} (원가: ${cost ?? "미확인"}, 카드: ${paymentMethod ?? "미확인"})`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.failed.push({ orderId: order.orderId, reason });
        onProgress?.(order.orderId, "failed", reason);
        console.error(`[gmarket-purchase] 주문 실패: ${order.orderId}`, reason);
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
  paymentPin: string
): Promise<SingleOrderResult> {
  // 현재 작업 페이지 (쿠폰 등에서 새 탭이 열릴 수 있음)
  let activePage = page;

  // 1. 상품 페이지 이동
  console.log(`[gmarket-purchase] 상품 페이지 이동: ${order.productUrl}`);
  await activePage.goto(order.productUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await activePage.waitForTimeout(2000);

  // 2. 쿠폰 수집
  await collectCoupons(activePage);

  // 페이지 닫힘 시 복구 (쿠폰 팝업이 새 탭을 열고 원래 탭을 닫는 경우)
  if (activePage.isClosed()) {
    console.log("[gmarket-purchase] 쿠폰 수집 후 페이지 닫힘 감지, 복구 시도...");
    activePage = await recoverPage(context, order.productUrl);
  }

  // 3. 수량 선택 (1인 경우 기본값)
  if (order.quantity > 1) {
    await setQuantity(activePage, order.quantity);
  }

  // 4. 쿠폰 적용 (할인 최대화)
  await applyCoupon(activePage);

  // 페이지 닫힘 시 복구
  if (activePage.isClosed()) {
    console.log("[gmarket-purchase] 쿠폰 적용 후 페이지 닫힘 감지, 복구 시도...");
    activePage = await recoverPage(context, order.productUrl);
  }

  // 5. 구매하기 클릭
  await clickPurchaseButton(activePage);

  // 6. 주문 결제 페이지에서 배송지 변경
  await changeShippingAddress(activePage, order);

  // 7. 결제하기 클릭 + 비밀번호 입력
  await processPayment(activePage, paymentPin);

  // 8. 주문내역에서 주문번호 + 결제방식 + 원가 한번에 추출
  const orderInfo = await extractOrderInfo(activePage, context);

  return orderInfo;
}

/** 페이지가 닫혔을 때 context에서 활성 페이지를 찾거나 새로 생성 */
async function recoverPage(context: BrowserContext, fallbackUrl: string): Promise<Page> {
  const pages = context.pages();
  if (pages.length > 0) {
    // 가장 최근 페이지 사용
    const lastPage = pages[pages.length - 1];
    console.log(`[gmarket-purchase] 기존 페이지 발견: ${lastPage.url()}`);
    return lastPage;
  }
  // 페이지가 하나도 없으면 새로 생성
  console.log("[gmarket-purchase] 새 페이지 생성");
  const newPage = await context.newPage();
  await newPage.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await newPage.waitForTimeout(2000);
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

      // 팝업 닫기
      const closeBtn = page.locator('.popup-close, .modal-close, button[aria-label="닫기"]').first();
      if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await closeBtn.click();
      }
      // ESC로 닫기 시도
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
    console.log("[gmarket-purchase] 쿠폰 수집 완료");
  } catch {
    console.log("[gmarket-purchase] 쿠폰 수집 스킵 (쿠폰 없음 또는 오류)");
  }
}

// ═══════════════════════════════════
// 수량 선택
// ═══════════════════════════════════
async function setQuantity(page: Page, quantity: number) {
  try {
    // 수량 input 필드 (class="num") 에 직접 입력
    const qtyInput = page.locator('input.num, input[type="number"], input[name*="quantity"]').first();
    if (await qtyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await qtyInput.fill(String(quantity));
    }
  } catch {
    console.log("[gmarket-purchase] 수량 설정 스킵");
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
    console.log("[gmarket-purchase] 쿠폰 적용 완료");
  } catch {
    console.log("[gmarket-purchase] 쿠폰 적용 스킵");
  }
}

// ═══════════════════════════════════
// 구매하기 버튼 클릭
// ═══════════════════════════════════
async function clickPurchaseButton(page: Page) {
  // "선택" 버튼 먼저 클릭 (수량 확정, class=bt_select)
  const selectBtn = page.locator('button.bt_select').first();
  if (await selectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await selectBtn.click();
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
  await buyBtn.click();

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
    const resultButtons = addrFrame.locator("ul > li > button:nth-child(2)");
    const resultCount = await resultButtons.count();
    if (resultCount === 0) {
      throw new Error(`주소 검색 결과 없음: "${searchKeyword}"`);
    }

    // 주소 텍스트가 가장 일치하는 결과 찾기
    let bestIdx = 0;
    for (let i = 0; i < Math.min(resultCount, 20); i++) {
      const btnText = await resultButtons.nth(i).textContent() || "";
      // 우편번호가 일치하면 최우선
      if (order.postalCode && btnText.includes(order.postalCode)) {
        bestIdx = i;
        break;
      }
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

    console.log(`[gmarket-purchase] 배송지 변경 완료: ${order.recipientName}`);
  } catch (err) {
    console.error("[gmarket-purchase] 배송지 변경 오류:", err);
    throw new Error(`배송지 변경 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 주소에서 검색 키워드 추출 (도로명 또는 동/읍/면 이름) */
function extractSearchKeyword(address: string): string {
  // 우편번호 제거
  let addr = address.replace(/^\[?\d{5}\]?\s*/, "").trim();
  // 괄호 안 내용 제거
  addr = addr.replace(/\(.*?\)/g, "").trim();
  // "시/도 구/군" 뒤의 도로명 또는 동이름 추출
  // 예: "경기도 수원시 팔달구 월드컵로357번길 11-16" → "월드컵로357번길 11-16"
  const parts = addr.split(/\s+/);
  // 도로명(~로, ~길) 또는 동(~동, ~읍, ~면)이 포함된 부분부터
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].match(/(로|길|동|읍|면)\d*$/)) {
      return parts.slice(i).join(" ");
    }
  }
  // fallback: 뒤에서 3단어
  return parts.slice(-3).join(" ");
}

// ═══════════════════════════════════
// 결제 처리 (결제하기 → 키패드 비밀번호 입력)
// ═══════════════════════════════════
async function processPayment(page: Page, paymentPin: string) {
  // "결제하기" 버튼 클릭
  const payBtn = page.locator('button:has-text("결제하기"), a:has-text("결제하기")').first();
  await payBtn.waitFor({ state: "visible", timeout: 10000 });
  await payBtn.click();
  console.log("[gmarket-purchase] 결제하기 버튼 클릭 완료");

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

    // 스프라이트 이미지 URL 추출 (첫 번째 버튼에서)
    const firstWrapper = keypadBtns[0]?.querySelector(".KeyboardButton__Wrapper");
    if (!firstWrapper) return null;

    const style = window.getComputedStyle(firstWrapper);
    const bgImage = style.backgroundImage;
    const bgSize = style.backgroundSize;

    // 각 버튼의 background-position 수집
    const positions = keypadBtns.map((btn, idx) => {
      const wrapper = btn.querySelector(".KeyboardButton__Wrapper");
      if (!wrapper) return null;
      const s = window.getComputedStyle(wrapper);
      return {
        index: idx,
        bgPosition: s.backgroundPosition,
        width: parseInt(s.width),
        height: parseInt(s.height),
      };
    }).filter(Boolean);

    return { bgImage, bgSize, positions };
  });

  if (!keypadData?.bgImage) {
    throw new Error("키패드 스프라이트 이미지를 찾을 수 없습니다");
  }

  // base64 PNG 추출
  const base64Match = keypadData.bgImage.match(/base64,\s*([A-Za-z0-9+/=]+)/);
  if (!base64Match) {
    throw new Error("키패드 이미지 base64 추출 실패");
  }

  const imageBuffer = Buffer.from(base64Match[1], "base64");

  // tesseract 워커 생성 (workerPath 명시적 지정)
  const worker = await Tesseract.createWorker("eng", undefined, {
    workerPath: TESSERACT_WORKER_PATH,
  });
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: "10" as unknown as Tesseract.PSM,
  });

  try {
    // 스프라이트 이미지를 셀별로 분할 + OCR
    const cellWidth = 30;
    const cellHeight = 30;
    const cols = 4;
    const rows = 3;

    const keyMap: Record<string, number> = {};

    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width || 120;
    const imgHeight = metadata.height || 90;
    const scaleX = imgWidth / (cellWidth * cols);
    const scaleY = imgHeight / (cellHeight * rows);

    for (const pos of keypadData.positions) {
      if (!pos) continue;

      const [bpX, bpY] = pos.bgPosition.split(" ").map((v: string) => Math.abs(parseInt(v)));
      const cellCol = Math.round(bpX / cellWidth);
      const cellRow = Math.round(bpY / cellHeight);

      const left = Math.round(cellCol * cellWidth * scaleX);
      const top = Math.round(cellRow * cellHeight * scaleY);
      const extractWidth = Math.min(Math.round(cellWidth * scaleX), imgWidth - left);
      const extractHeight = Math.min(Math.round(cellHeight * scaleY), imgHeight - top);

      if (extractWidth <= 0 || extractHeight <= 0) continue;

      try {
        const cellBuffer = await sharp(imageBuffer)
          .extract({ left, top, width: extractWidth, height: extractHeight })
          .negate()
          .resize(120, 120)
          .png()
          .toBuffer();

        const { data: { text } } = await worker.recognize(cellBuffer);
        const digit = text.trim().replace(/\D/g, "");
        if (digit.length === 1) {
          keyMap[digit] = pos.index;
          console.log(`[keypad-ocr] cell(${cellCol},${cellRow}) → digit "${digit}" → button index ${pos.index}`);
        }
      } catch (err) {
        console.log(`[keypad-ocr] cell(${cellCol},${cellRow}) OCR 실패:`, err);
      }
    }

    // 숫자 0-9 중 10개를 찾아야 함 (1개는 빈칸)
    if (Object.keys(keyMap).length < 10) {
      console.warn(`[keypad-ocr] ${Object.keys(keyMap).length}/10 숫자만 인식됨. 스크린샷 방식으로 재시도...`);

      const buttons = frame.locator("button:has(.KeyboardButton__Wrapper)");
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        if (Object.values(keyMap).includes(i)) continue;

        try {
          const btnScreenshot = await buttons.nth(i).screenshot({ type: "png" });
          const processed = await sharp(btnScreenshot)
            .resize(150, 150)
            .grayscale()
            .negate()
            .png()
            .toBuffer();

          const { data: { text } } = await worker.recognize(processed);
          const digit = text.trim().replace(/\D/g, "");
          if (digit.length === 1 && !keyMap[digit]) {
            keyMap[digit] = i;
            console.log(`[keypad-ocr] 재시도 button ${i} → digit "${digit}"`);
          }
        } catch { /* skip */ }
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
