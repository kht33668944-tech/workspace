import { type Page, type BrowserContext, type Cookie } from "playwright";
import { launchBrowser } from "./browser";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PurchaseOrderInfo, PurchaseResult } from "./types";
import { loadSession, saveSession, loadFileSession, saveFileSession } from "./session-manager";

const LOGIN_URL = "https://ohou.se/users/sign_in";

// 환경변수에서 읽기 (.env.local)
const FIXED_PHONE_SUFFIX = process.env.OHOUSE_PHONE_SUFFIX ?? "";
const PAYMENT_WAIT_MS = 60000;          // 결제 승인 대기 시간 (60초)

interface ProgressCallback {
  (orderId: string, status: "processing" | "success" | "failed" | "waiting_payment", message: string, purchaseOrderNo?: string): void;
}
// 메인 함수
// ═══════════════════════════════════

/**
 * 오늘의집 자동구매 스크래퍼
 *
 * 플로우:
 * 1. 로그인 (쿠키 세션 복원 또는 신규 로그인)
 * 2. 각 주문건 순차 처리:
 *    a. 상품 페이지 이동 → 쿠폰 받기
 *    b. 바로구매 클릭
 *    c. 배송지 변경 (수취인명, 고정 전화번호, 주소)
 *    d. 주문자 정보 입력
 *    e. 간편결제 할인 비교 → 최대할인 or 네이버페이 선택 → 결제
 *    f. 네이버페이 키패드 비밀번호 입력
 *    g. 주문완료 → 주문번호 + 원가 추출
 */
export async function purchaseOhouse(
  loginId: string,
  loginPw: string,
  orders: PurchaseOrderInfo[],
  onProgress?: ProgressCallback,
  supabase?: SupabaseClient,
  abortSignal?: AbortSignal,
  paymentPin?: string,
  naverLoginId?: string,
  naverLoginPw?: string
): Promise<PurchaseResult> {
  const result: PurchaseResult = { success: [], failed: [] };

  const browser = await launchBrowser();

  let context: BrowserContext;
  let needsLogin = true;

  // 1. 세션 복원 시도 (DB 우선, fallback: 파일)
  const savedCookies = supabase
    ? await loadSession(supabase, "ohouse", loginId)
    : await loadFileSession("ohouse", loginId);
  if (savedCookies) {
    console.log("[ohouse-purchase] 저장된 세션으로 복원 시도...");
    context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await context.addCookies(savedCookies);

    // 세션 유효성 확인
    const testPage = await context.newPage();
    try {
      await testPage.goto("https://ohou.se/user_shopping_pages/order_list", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      const url = testPage.url();
      if (!url.includes("sign_in") && !url.includes("login")) {
        console.log("[ohouse-purchase] 세션 복원 성공");
        needsLogin = false;
      } else {
        console.log("[ohouse-purchase] 세션 만료, 재로그인 필요");
        await context.close();
      }
    } catch {
      console.log("[ohouse-purchase] 세션 확인 실패, 재로그인 필요");
      await context.close();
    } finally {
      if (!testPage.isClosed()) await testPage.close();
    }
  }

  // 2. 로그인
  if (needsLogin) {
    context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    try {
      await login(context, loginId, loginPw);
      const cookies = await context.cookies();
      if (supabase) {
        await saveSession(supabase, "ohouse", loginId, cookies);
      } else {
        await saveFileSession("ohouse", loginId, cookies);
      }
    } catch (err) {
      await browser.close();
      const reason = err instanceof Error ? err.message : String(err);
      for (const order of orders) {
        result.failed.push({ orderId: order.orderId, reason });
        onProgress?.(order.orderId, "failed", reason);
      }
      return result;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const activeContext = context!;
  const page = await activeContext.newPage();

  try {
    // 3. 각 주문건 순차 처리
    for (const order of orders) {
      // 중단 요청 확인
      if (abortSignal?.aborted) {
        console.log("[ohouse-purchase] 사용자 중단 요청 → 남은 주문 건너뜀");
        for (const remaining of orders) {
          if (!result.success.some(s => s.orderId === remaining.orderId) &&
              !result.failed.some(f => f.orderId === remaining.orderId)) {
            result.failed.push({ orderId: remaining.orderId, reason: "사용자가 작업을 중단했습니다." });
            onProgress?.(remaining.orderId, "failed", "사용자가 작업을 중단했습니다.");
          }
        }
        break;
      }

      const totalQty = Math.max(order.quantity, 1);
      onProgress?.(order.orderId, "processing", "구매 진행 중...");

      let lastOrderNo = "";
      let totalCost = 0;
      let costExtractedCount = 0;
      let successCount = 0;

      try {
        for (let q = 1; q <= totalQty; q++) {
          if (totalQty > 1) {
            console.log(`[ohouse-purchase] 주문 ${order.orderId} - ${q}/${totalQty}번째 구매`);
            onProgress?.(order.orderId, "processing", `구매 진행 중... (${q - 1}/${totalQty})`);
          }

          const singleOrder = { ...order, quantity: 1 };
          const { purchaseOrderNo, cost } = await processSingleOrder(
            page, activeContext, singleOrder, q > 1, onProgress, paymentPin, naverLoginId, naverLoginPw
          );

          lastOrderNo = purchaseOrderNo;
          if (cost) { totalCost += cost; costExtractedCount++; }
          successCount++;

          if (totalQty > 1) {
            console.log(`[ohouse-purchase] ${q}/${totalQty}번째 구매 성공: ${purchaseOrderNo} (단가: ${cost ?? "미확인"})`);
          }
        }

        // 일부 반복에서 원가 추출 실패 시 단가 평균 × 총 수량으로 보정
        let finalCost: number | undefined;
        if (totalCost > 0) {
          finalCost = (costExtractedCount > 0 && costExtractedCount < totalQty)
            ? Math.round(totalCost / costExtractedCount) * totalQty
            : totalCost;
        }
        result.success.push({ orderId: order.orderId, purchaseOrderNo: lastOrderNo, cost: finalCost });
        onProgress?.(order.orderId, "success",
          `주문번호: ${lastOrderNo}${finalCost ? ` (원가: ${finalCost.toLocaleString()}원)` : ""}${totalQty > 1 ? ` (${totalQty}개)` : ""}`,
          lastOrderNo
        );
        console.log(`[ohouse-purchase] 주문 성공: ${order.orderId} → ${lastOrderNo} (총 원가: ${finalCost ?? "미확인"}, ${totalQty}개)`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const failMsg = totalQty > 1 ? `${reason} (${successCount}/${totalQty}개 구매 후 실패)` : reason;
        result.failed.push({ orderId: order.orderId, reason: failMsg });
        onProgress?.(order.orderId, "failed", failMsg);
        console.error(`[ohouse-purchase] 주문 실패: ${order.orderId}`, failMsg);
      }
    }

    // 세션 갱신
    const updatedCookies = await activeContext.cookies();
    if (supabase) {
      await saveSession(supabase, "ohouse", loginId, updatedCookies);
    } else {
      await saveFileSession("ohouse", loginId, updatedCookies);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
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
async function login(context: BrowserContext, loginId: string, loginPw: string) {
  const page = await context.newPage();
  try {
    console.log("[ohouse-purchase] 로그인 중...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    const emailInput = page.locator('input[placeholder*="이메일"], input[name="email"], input[type="email"]').first();
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
      throw new Error(hasCaptcha ? "캡차 인증이 필요합니다" : "로그인 실패: 이메일/비밀번호 확인");
    }

    console.log("[ohouse-purchase] 로그인 성공");
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════
// 단건 주문 처리
// ═══════════════════════════════════
interface SingleOrderResult {
  purchaseOrderNo: string;
  cost?: number;
}

async function processSingleOrder(
  page: Page,
  _context: BrowserContext,
  order: PurchaseOrderInfo,
  isRepeat: boolean,
  onProgress?: ProgressCallback,
  paymentPin?: string,
  naverLoginId?: string,
  naverLoginPw?: string
): Promise<SingleOrderResult> {
  // 1. 상품 페이지 이동
  console.log(`[ohouse-purchase] 상품 페이지 이동: ${order.productUrl}${isRepeat ? " (반복구매)" : ""}`);
  await page.goto(order.productUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // 2. 쿠폰 받기 시도
  await tryDownloadCoupon(page);

  // 3. 바로구매 클릭
  await clickBuyNow(page);

  // 4. 배송지 변경
  await changeDeliveryAddress(page, order);

  // 4.5. 배송시 요청사항 입력
  await fillDeliveryMemo(page, order.deliveryMemo);

  // 5. 주문자 정보 입력
  await fillOrdererInfo(page, order.recipientName);

  // 6. 결제수단 선택 (간편결제 할인 비교 → 네이버페이 fallback) + 결제
  onProgress?.(order.orderId, "waiting_payment", "결제 처리 중...");
  await selectPaymentAndRequest(page, paymentPin, naverLoginId, naverLoginPw);

  // 7. 결제 완료 대기
  console.log(`[ohouse-purchase] 결제 완료 대기 중... (${PAYMENT_WAIT_MS / 1000}초)`);
  await waitForPaymentCompletion(page);

  // 8. 주문 완료 후 주문번호 + 원가 추출
  const orderInfo = await extractOrderInfo(page);

  return orderInfo;
}

// ═══════════════════════════════════
// 쿠폰 받기
// ═══════════════════════════════════
async function tryDownloadCoupon(page: Page) {
  try {
    // "쿠폰 받기" 빨간 버튼 확인 (이미 받은 경우 "받은 쿠폰 보기"로 표시됨)
    const couponBtn = page.locator('button:has-text("쿠폰 받기")').first();
    const isVisible = await couponBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (isVisible) {
      // "받은 쿠폰 보기"가 아닌 "쿠폰 받기"인지 확인
      const btnText = await couponBtn.textContent() || "";
      if (btnText.includes("받은") || btnText.includes("보기")) {
        console.log("[ohouse-purchase] 이미 쿠폰을 받은 상태 (받은 쿠폰 보기)");
        return;
      }

      console.log("[ohouse-purchase] 쿠폰 받기 클릭...");
      await couponBtn.click();
      await page.waitForTimeout(2000);

      // 쿠폰 모달에서 "확인" 버튼 클릭
      const confirmBtn = page.locator('button:has-text("확인")').first();
      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(1000);
        console.log("[ohouse-purchase] 쿠폰 받기 완료");
      }
    } else {
      console.log("[ohouse-purchase] 쿠폰 받기 버튼 없음 (이미 받았거나 쿠폰 없음)");
    }
  } catch {
    console.log("[ohouse-purchase] 쿠폰 받기 스킵 (오류)");
  }
}

// ═══════════════════════════════════
// 바로구매 클릭
// ═══════════════════════════════════
async function clickBuyNow(page: Page) {
  // "바로구매" 버튼 클릭
  const buyBtn = page.locator('button:has-text("바로구매")').first();
  await buyBtn.waitFor({ state: "visible", timeout: 10000 });
  await buyBtn.click();

  // 주문/결제 페이지 로딩 대기
  await page.waitForURL((url) => {
    const u = url.toString();
    return u.includes("order") || u.includes("checkout") || u.includes("pay");
  }, { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(3000);
  console.log("[ohouse-purchase] 주문/결제 페이지 이동 완료");
}

// ═══════════════════════════════════
// 배송지 변경
// ═══════════════════════════════════
async function changeDeliveryAddress(page: Page, order: PurchaseOrderInfo) {
  try {
    console.log(`[ohouse-purchase] 배송지 변경: ${order.recipientName} / ${order.address}`);

    // 1. "변경" 버튼 클릭 (배송지 영역)
    const changeBtn = page.locator('button:has-text("변경")').first();
    await changeBtn.waitFor({ state: "visible", timeout: 10000 });
    await changeBtn.click();
    await page.waitForTimeout(2000);

    // 2. 배송지 선택 모달에서 "수정" 클릭
    const editBtn = page.locator('button:has-text("수정")').first();
    await editBtn.waitFor({ state: "visible", timeout: 5000 });
    await editBtn.click();
    await page.waitForTimeout(2000);

    // 3. 배송지 수정 모달 내에서만 입력 (모달 스코프)
    // 모달: "배송지 수정" 헤더 + "저장" 버튼이 포함된 컨테이너
    const modal = page.locator(':text-is("배송지 수정")').locator('..').locator('..');
    const modalInputs = modal.locator('input:not([disabled])');
    const inputCount = await modalInputs.count().catch(() => 0);
    console.log(`[ohouse-purchase] 배송지 수정 모달 input 수: ${inputCount}`);

    // 모달 내 input 순서: 배송지명(0), 받는사람(1), 전화번호(2), 우편번호(disabled), 기본주소(disabled), 상세주소(3)
    if (inputCount >= 3) {
      // 배송지명
      await modalInputs.nth(0).fill(order.recipientName, { force: true });
      console.log(`[ohouse-purchase] 배송지명 입력: ${order.recipientName}`);

      // 받는 사람
      await modalInputs.nth(1).fill(order.recipientName, { force: true });
      console.log(`[ohouse-purchase] 받는 사람 입력: ${order.recipientName}`);

      // 전화번호 (010 뒤 뒷자리)
      await modalInputs.nth(2).fill(FIXED_PHONE_SUFFIX, { force: true });
      console.log(`[ohouse-purchase] 배송지 전화번호 입력 완료`);
    } else {
      // fallback: 라벨 기반 (모달 스코프 실패 시)
      console.log("[ohouse-purchase] 모달 input 감지 실패, 라벨 기반 fallback");
      const nameInput = page.locator(':text-is("배송지명")').locator('..').locator('input:not([disabled])').first();
      if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await nameInput.fill(order.recipientName, { force: true });
      }
      const recvInput = page.locator(':text-is("받는 사람")').locator('..').locator('input:not([disabled])').first();
      if (await recvInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await recvInput.fill(order.recipientName, { force: true });
      }
      // 전화번호는 fallback에서도 배송지명 라벨 근처에서 찾기 (주문자 영역과 구분)
      const phoneInput = page.locator(':text-is("배송지명")').locator('../..').locator('input:not([disabled])').nth(2);
      if (await phoneInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await phoneInput.fill(FIXED_PHONE_SUFFIX, { force: true });
      }
    }

    console.log(`[ohouse-purchase] 배송지 정보 입력 완료: ${order.recipientName}`);

    // 4. 주소찾기 버튼 클릭
    const searchAddrBtn = page.locator('button:has-text("주소찾기")').first();
    await searchAddrBtn.waitFor({ state: "visible", timeout: 5000 });
    await searchAddrBtn.click({ force: true });
    await page.waitForTimeout(2000);

    // 5. 주소 검색 입력 (도로명 검색 입력란)
    const searchKeyword = extractAddressKeyword(order.address);
    console.log(`[ohouse-purchase] 주소 검색: "${searchKeyword}"`);

    const addrSearchInput = page.locator('input[placeholder*="도로명"]').first();
    await addrSearchInput.waitFor({ state: "visible", timeout: 5000 });
    await addrSearchInput.click({ force: true });
    await addrSearchInput.fill(searchKeyword);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    // 6. 검색 결과에서 우편번호 일치하는 주소 클릭
    await selectAddressResult(page, order.postalCode);
    await page.waitForTimeout(2000);

    // 7. 상세주소 입력
    if (order.addressDetail) {
      const detailInput = page.locator('input[placeholder*="상세주소"]').first();
      if (await detailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await detailInput.click({ force: true });
        await detailInput.fill(order.addressDetail);
        console.log(`[ohouse-purchase] 상세주소 입력: ${order.addressDetail}`);
      }
    }

    // 8. 저장 버튼 클릭
    const saveBtn = page.locator('button:has-text("저장")').first();
    await saveBtn.waitFor({ state: "visible", timeout: 5000 });
    await saveBtn.click({ force: true });
    await page.waitForTimeout(3000);

    console.log(`[ohouse-purchase] 배송지 변경 완료: ${order.recipientName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ohouse-purchase] 배송지 변경 오류:", msg);
    throw new Error(`배송지 변경 실패: ${msg}`);
  }
}

// ═══════════════════════════════════
// 배송시 요청사항 입력
// ═══════════════════════════════════
async function fillDeliveryMemo(page: Page, memo: string) {
  if (!memo || memo.trim() === "") {
    console.log("[ohouse-purchase] 배송메모 없음, 스킵");
    return;
  }

  try {
    const trimmedMemo = memo.trim().substring(0, 50);
    console.log(`[ohouse-purchase] 배송메모 입력: ${trimmedMemo}`);

    // 1. "배송시 요청사항" 드롭다운에서 "직접 입력" 선택
    const selectDropdown = page.locator('select').filter({ hasText: /요청사항|선택해주세요/ }).first();
    if (await selectDropdown.isVisible({ timeout: 3000 }).catch(() => false)) {
      await selectDropdown.selectOption({ label: "직접 입력" });
    } else {
      // 커스텀 드롭다운
      const dropdownBtn = page.locator('button:has-text("요청사항"), div:has-text("요청사항을 선택")').first();
      if (await dropdownBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await dropdownBtn.click({ force: true });
        await page.waitForTimeout(1000);
        const directOpt = page.locator('text=직접 입력').last();
        if (await directOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
          await directOpt.click({ force: true });
          await page.waitForTimeout(1000);
        }
      }
    }
    console.log("[ohouse-purchase] '직접 입력' 선택 완료");

    // 2. 배송메모 입력란 (maxlength=50인 input)
    const memoInput = page.locator('input[maxlength="50"]').first();
    if (await memoInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await memoInput.click({ force: true });
      await memoInput.fill(trimmedMemo);
      console.log(`[ohouse-purchase] 배송메모 입력 완료: ${trimmedMemo}`);
    } else {
      console.log("[ohouse-purchase] 배송메모 입력란을 찾을 수 없음");
    }
  } catch (err) {
    console.log("[ohouse-purchase] 배송메모 입력 오류 (계속 진행):", err instanceof Error ? err.message : String(err));
  }
}

/** 주소에서 검색 키워드 추출 */
function extractAddressKeyword(address: string): string {
  // 우편번호 제거
  let addr = address.replace(/^\[?\d{5}\]?\s*/, "").trim();
  // 괄호 안 내용 제거
  addr = addr.replace(/\(.*?\)/g, "").trim();
  const parts = addr.split(/\s+/);

  // 도로명(~로, ~길) + 번지
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].match(/(로|길)\d*$/)) {
      return parts.slice(i).join(" ");
    }
  }
  // 동/읍/면 + 이후
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].match(/(동|읍|면)\d*$/)) {
      return parts.slice(i).join(" ");
    }
  }
  return parts.slice(-3).join(" ");
}

/** 주소 검색 결과에서 우편번호 일치하는 항목 클릭
 *
 * 오늘의집 주소 검색 결과: button 요소에 "우편번호+주소" 텍스트 포함
 * 예: button "우편번호 43005대구광역시 달성군 현풍읍 테크노북로 33-19"
 */
async function selectAddressResult(page: Page, postalCode: string) {
  // 우편번호가 포함된 button 결과 찾기
  const resultBtn = page.locator(`button:has-text("${postalCode}")`).first();
  if (await resultBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await resultBtn.click({ force: true });
    console.log(`[ohouse-purchase] 우편번호 ${postalCode} 일치 주소 선택`);
    return;
  }

  // fallback: 첫 번째 검색 결과 button 클릭
  const firstResult = page.locator('button:has-text("우편번호")').first();
  if (await firstResult.isVisible({ timeout: 3000 }).catch(() => false)) {
    await firstResult.click({ force: true });
    console.warn(`[ohouse-purchase] 우편번호 ${postalCode} 불일치, 첫 번째 결과 사용`);
    return;
  }

  throw new Error(`주소 검색 결과 없음 (우편번호: ${postalCode})`);
}

// ═══════════════════════════════════
// 주문자 정보 입력
// ═══════════════════════════════════
async function fillOrdererInfo(page: Page, recipientName: string) {
  try {
    console.log(`[ohouse-purchase] 주문자 정보 입력: ${recipientName}`);

    // "주문자" 헤딩 기준으로 섹션 스코프 제한
    // ※ 전화번호는 절대 건드리지 않음 (변경 시 휴대폰 재인증 필요)
    // ※ maxlength="50"은 배송메모 input이므로 반드시 제외
    const section = page.locator(':text-is("주문자")').locator('..').locator('..');
    const sectionInputs = section.locator('input:not([disabled]):not([maxlength="50"])');
    const inputCount = await sectionInputs.count().catch(() => 0);
    console.log(`[ohouse-purchase] 주문자 섹션 input 수: ${inputCount}`);

    if (inputCount >= 2) {
      // 주문자 섹션 input 순서: 이름(0), 이메일앞부분(1), 전화번호(2) ← 건드리지 않음
      await sectionInputs.nth(0).clear({ force: true });
      await sectionInputs.nth(0).fill(recipientName, { force: true });
      console.log(`[ohouse-purchase] 주문자 이름 입력: ${recipientName}`);

      const randomEmail = generateRandomEmail();
      await sectionInputs.nth(1).clear({ force: true });
      await sectionInputs.nth(1).fill(randomEmail, { force: true });
      console.log(`[ohouse-purchase] 이메일 입력: ${randomEmail}`);
    }

    console.log("[ohouse-purchase] 주문자 전화번호: 기존 유지 (변경 안 함)");
  } catch (err) {
    console.log("[ohouse-purchase] 주문자 정보 입력 오류 (계속 진행):", err instanceof Error ? err.message : String(err));
  }
}

/** 임의 이메일 주소 앞부분 생성 */
function generateRandomEmail(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ═══════════════════════════════════
// 결제수단 선택 + 결제요청
// ═══════════════════════════════════

/** 간편결제 옵션 */
interface EasyPayOption {
  name: string;            // 카카오페이, 토스페이, 네이버페이, 페이코
  discountPercent: number; // 최대 할인율 (%), 0이면 할인 없음
}

async function parseEasyPayOptions(page: Page): Promise<EasyPayOption[]> {
  // evaluate로 페이지 내 결제 옵션을 직접 탐색
  // (Playwright locator.click()은 다른 요소가 가로막으면 실패하므로 JS 직접 클릭 사용)
  //
  // 할인 판단 기준: "최대 N% 할인" 의 % 값
  // ※ "N원 즉시할인"은 오늘의집 낚시쿠폰으로 실제 적용 안 됨 → 무시
  // ※ "적립"은 할인이 아님 → 무시
  const rawOptions = await page.evaluate(() => {
    const paymentNames = ["카카오페이", "토스페이", "네이버페이", "페이코"];
    const results: { name: string; discountPercent: number }[] = [];

    const candidates = document.querySelectorAll("label, button, div, li, a, span, [role='radio'], [role='button']");

    for (const name of paymentNames) {
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i] as HTMLElement;
        const text = el.textContent?.trim() || "";

        // 결제수단 이름 포함 + 텍스트 길이 제한 (너무 큰 컨테이너 제외)
        if (!text.includes(name) || text.length > 100) continue;

        // 이미 찾은 이름이면 스킵
        if (results.some(r => r.name === name)) break;

        // % 할인율 파싱 (예: "최대 15% 할인", "최대15%할인")
        let discountPercent = 0;
        const percentMatch = text.match(/최대\s*(\d+)\s*%\s*할인/);
        if (percentMatch) {
          discountPercent = parseInt(percentMatch[1]);
        }

        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          results.push({ name, discountPercent });
          break;
        }
      }
    }

    return results;
  }).catch(() => []);

  const options: EasyPayOption[] = rawOptions.map(raw => {
    console.log(`[ohouse-purchase] 간편결제 옵션: ${raw.name} (할인: ${raw.discountPercent}%)`);
    return { name: raw.name, discountPercent: raw.discountPercent };
  });
  return options;
}

/** evaluate를 사용하여 결제수단을 JS로 직접 클릭 (pointer event interception 우회) */
async function clickPaymentOptionByName(page: Page, name: string): Promise<boolean> {
  return page.evaluate((targetName) => {
    const candidates = document.querySelectorAll("label, button, div, li, a, span, [role='radio'], [role='button']");
    for (const el of candidates) {
      const text = el.textContent?.trim() || "";
      if (text.includes(targetName) && text.length < 100 && el instanceof HTMLElement) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }, name).catch(() => false);
}

async function selectPaymentAndRequest(page: Page, paymentPin?: string, naverLoginId?: string, naverLoginPw?: string) {
  try {
    // 결제 영역으로 스크롤
    await page.keyboard.press("End");
    await page.waitForTimeout(1000);

    // 1. "간편결제" 라디오 선택 (주의: "계좌 간편결제"와 구분해야 함)
    //    "계좌 간편결제"는 오늘의집페이, "간편결제"는 카카오/토스/네이버/페이코
    //    text-is를 사용하여 정확히 "간편결제"만 매칭
    let easyPayClicked = false;

    // 방법 1: 정확히 "간편결제" 텍스트만 가진 라벨/라디오 (계좌 간편결제 제외)
    const allLabels = page.locator('label, [role="radio"], input[type="radio"] + span, input[type="radio"] + label');
    const labelCount = await allLabels.count();
    for (let i = 0; i < labelCount; i++) {
      const label = allLabels.nth(i);
      const text = await label.textContent().catch(() => "") || "";
      const trimmed = text.trim();
      // "간편결제"를 포함하되 "계좌"는 포함하지 않는 것
      if (trimmed.includes("간편결제") && !trimmed.includes("계좌")) {
        await label.click();
        easyPayClicked = true;
        console.log(`[ohouse-purchase] '간편결제' 선택 완료 (텍스트: ${trimmed.substring(0, 30)})`);
        break;
      }
    }

    // 방법 2: evaluate fallback
    if (!easyPayClicked) {
      easyPayClicked = await page.evaluate(() => {
        const allEls = document.querySelectorAll("label, span, div, input");
        for (const el of allEls) {
          const text = el.textContent?.trim() || "";
          // "간편결제"를 포함하고 "계좌"는 포함하지 않으며, 텍스트가 너무 길지 않은 것
          if (text.includes("간편결제") && !text.includes("계좌") && text.length < 20) {
            if (el instanceof HTMLElement) {
              el.click();
              return true;
            }
          }
        }
        return false;
      }).catch(() => false);
      if (easyPayClicked) console.log("[ohouse-purchase] '간편결제' 선택 완료 (evaluate fallback)");
    }

    if (!easyPayClicked) {
      console.log("[ohouse-purchase] '간편결제' 라디오를 찾지 못함, 네이버페이 직접 탐색");
    }

    await page.waitForTimeout(1500);

    // 2. 간편결제 옵션 % 할인 비교
    //    "최대 N% 할인"이 가장 높은 수단을 선택 (리셀 원가 최소화)
    //    % 할인이 모두 0이면 네이버페이 선택 (PIN 자동결제)
    const options = await parseEasyPayOptions(page);
    console.log(`[ohouse-purchase] 감지된 간편결제 옵션: ${options.length}개`);

    let selectedOption: EasyPayOption | undefined;

    // % 할인이 있는 옵션 중 최대 할인율 선택
    const discountOptions = options.filter(o => o.discountPercent > 0);

    if (discountOptions.length > 0) {
      selectedOption = discountOptions.reduce((best, cur) => cur.discountPercent > best.discountPercent ? cur : best);
      console.log(`[ohouse-purchase] 최대 할인 수단: ${selectedOption.name} (${selectedOption.discountPercent}%)`);
      if (selectedOption.name !== "네이버페이") {
        console.log("[ohouse-purchase] ※ 이 수단은 수동 앱 승인이 필요합니다");
      }
    } else {
      // % 할인 없음 → 네이버페이 (자동 결제)
      selectedOption = options.find(o => o.name === "네이버페이");
      if (selectedOption) {
        console.log("[ohouse-purchase] % 할인 없음 → 네이버페이 선택 (자동 결제)");
      }
    }

    // 옵션 탐색 실패 시 네이버페이를 기본으로
    if (!selectedOption) {
      console.log("[ohouse-purchase] 옵션 파싱 실패, 네이버페이를 기본 선택");
      selectedOption = { name: "네이버페이", discountPercent: 0 };
    }

    // 결제수단 선택: Playwright click(force:true) 사용 (React 상태 업데이트 보장)
    // evaluate JS 클릭은 React synthetic event를 트리거하지 않을 수 있음
    let paymentClicked = false;

    // 방법 1: Playwright locator로 직접 클릭 (force:true로 pointer interception 우회)
    const paymentLocators = [
      page.locator(`label:has-text("${selectedOption.name}")`).first(),
      page.locator(`button:has-text("${selectedOption.name}")`).first(),
      page.locator(`li:has-text("${selectedOption.name}")`).first(),
      page.locator(`div:has-text("${selectedOption.name}")`).first(),
    ];

    for (const loc of paymentLocators) {
      if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
        try {
          await loc.click({ force: true, timeout: 3000 });
          paymentClicked = true;
          console.log(`[ohouse-purchase] ${selectedOption.name} Playwright 클릭 성공`);
          break;
        } catch {
          // 다음 locator 시도
        }
      }
    }

    // 방법 2: evaluate fallback (Playwright 클릭 실패 시)
    if (!paymentClicked) {
      paymentClicked = await clickPaymentOptionByName(page, selectedOption.name);
      if (paymentClicked) {
        console.log(`[ohouse-purchase] ${selectedOption.name} evaluate 클릭 성공`);
      }
    }

    if (!paymentClicked) {
      throw new Error(`결제수단 '${selectedOption.name}'을 찾을 수 없습니다`);
    }

    await page.waitForTimeout(1500);

    // 선택 검증: 결제수단이 실제로 선택되었는지 확인
    const isSelected = await page.evaluate((name) => {
      // 선택된 상태의 시각적 표시 확인 (활성화된 라디오, 체크된 input 등)
      const allEls = document.querySelectorAll("input[type='radio']:checked, [aria-checked='true'], .selected, [class*='active'], [class*='checked']");
      for (const el of allEls) {
        const parent = el.closest("label, li, div");
        if (parent?.textContent?.includes(name)) return true;
      }
      return false;
    }, selectedOption.name).catch(() => false);
    console.log(`[ohouse-purchase] ${selectedOption.name} 선택 상태 확인: ${isSelected}`);

    // 3. 결제하기 버튼 클릭 (팝업 대기를 먼저 등록)
    await page.keyboard.press("End");
    await page.waitForTimeout(1000);

    // 결제하기 버튼은 반드시 Playwright click (force:true) 사용
    // JS evaluate 클릭은 "사용자 제스처"로 인식되지 않아 팝업이 차단됨
    const payBtn = page.locator('button:has-text("결제하기")').first();
    await payBtn.waitFor({ state: "visible", timeout: 10000 });

    if (selectedOption.name === "네이버페이") {
      // 네이버페이: 팝업/새 창/리다이렉트 대기를 먼저 등록한 뒤 클릭
      const popupPromise = page.context().waitForEvent("page", { timeout: 30000 }).catch(() => null);
      const pagePopupPromise = page.waitForEvent("popup", { timeout: 30000 }).catch(() => null);
      await payBtn.click({ force: true });
      console.log("[ohouse-purchase] 결제하기 버튼 클릭 (네이버페이)");

      await handleNaverPayFlow(page, popupPromise, pagePopupPromise, paymentPin, naverLoginId, naverLoginPw);
    } else {
      await payBtn.click({ force: true });
      console.log("[ohouse-purchase] 결제하기 버튼 클릭");
      console.log(`[ohouse-purchase] ${selectedOption.name} 결제 - 사용자 승인 대기`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ohouse-purchase] 결제 처리 오류:", msg);
    throw new Error(`결제 처리 실패: ${msg}`);
  }
}

// ═══════════════════════════════════
// 네이버페이 결제 플로우
// ═══════════════════════════════════

/** 네이버페이 결제 처리: 새 창 감지 → 로그인(필요시) → 동의하고 결제하기 → 키패드 비밀번호 입력 */
async function handleNaverPayFlow(
  page: Page,
  popupPromise: Promise<Page | null>,
  pagePopupPromise: Promise<Page | null>,
  paymentPin?: string,
  naverLoginId?: string,
  naverLoginPw?: string
) {
  let payPopup: Page | null = null;

  // 1. 이미 열린 네이버페이 창 확인
  const existingPages = page.context().pages();
  for (const p of existingPages) {
    const url = p.url();
    if (url.includes("pay.naver.com") || url.includes("nid.naver.com") || url.includes("m.pay.naver.com")) {
      payPopup = p;
      console.log(`[ohouse-purchase] 네이버페이 팝업 이미 열림: ${url}`);
      break;
    }
  }

  // 2. 팝업 대기 (context 이벤트 + page popup 이벤트 동시 대기)
  if (!payPopup) {
    try {
      // 두 Promise 중 먼저 resolve 되는 것 사용 (null은 필터)
      const results = await Promise.all([popupPromise, pagePopupPromise]);
      payPopup = results[0] || results[1];
      if (payPopup) {
        console.log(`[ohouse-purchase] 네이버페이 팝업 감지: ${payPopup.url()}`);
      } else {
        throw new Error("no popup");
      }
    } catch {
      // 팝업 미감지 → 리다이렉트/새 탭/iframe 탐색
      console.log("[ohouse-purchase] 팝업 미감지, 대안 탐색...");
      await page.waitForTimeout(5000);

      const currentUrl = page.url();
      if (currentUrl.includes("pay.naver.com") || currentUrl.includes("nid.naver.com")) {
        payPopup = page;
      } else {
        // 새 탭 확인
        for (const p of page.context().pages()) {
          if (p !== page) {
            const url = p.url();
            if (url.includes("pay.naver.com") || url.includes("nid.naver.com")) {
              payPopup = p;
              break;
            }
          }
        }
        // iframe 확인
        if (!payPopup) {
          for (const frame of page.frames()) {
            if (frame.url().includes("pay.naver.com") || frame.url().includes("nid.naver.com")) {
              payPopup = page;
              break;
            }
          }
        }
        if (!payPopup) {
          throw new Error("네이버페이 결제 창이 열리지 않았습니다");
        }
      }
    }
  }

  await payPopup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);

  await payPopup.waitForTimeout(2000);

  // 네이버 로그인 페이지인지 확인 (nid.naver.com)
  const popupUrl = payPopup.url();
  if (popupUrl.includes("nid.naver.com") || popupUrl.includes("login")) {
    console.log("[ohouse-purchase] 네이버 로그인 필요");
    if (!naverLoginId || !naverLoginPw) {
      throw new Error("네이버 로그인이 필요하지만 스마트스토어 계정 정보가 없습니다. 설정 > 구매처 계정관리에서 스마트스토어 계정을 등록해주세요.");
    }
    await naverLogin(payPopup, naverLoginId, naverLoginPw);
  }

  // 네이버페이 결제 페이지 대기 (m.pay.naver.com 또는 pay.naver.com)
  await payPopup.waitForTimeout(2000);

  // "동의하고 결제하기" 버튼 대기 및 클릭
  await clickAgreeAndPay(payPopup);

  // 비밀번호 키패드 입력
  if (!paymentPin || paymentPin.length !== 6) {
    throw new Error("네이버페이 결제 비밀번호 6자리가 필요합니다.");
  }
  await enterNaverPayPassword(payPopup, paymentPin);

  console.log("[ohouse-purchase] 네이버페이 결제 완료 처리 대기");
}

/** 네이버 로그인 (nid.naver.com) */
async function naverLogin(popup: Page, loginId: string, loginPw: string) {
  console.log("[ohouse-purchase] 네이버 로그인 중...");

  // 아이디 입력
  const idInput = popup.locator('input#id, input[name="id"], input[placeholder*="아이디"]').first();
  await idInput.waitFor({ state: "visible", timeout: 10000 });
  await idInput.click();
  // Playwright fill 대신 keyboard로 입력 (봇 감지 우회)
  await idInput.fill("");
  await popup.keyboard.type(loginId, { delay: 50 });

  // 비밀번호 입력
  const pwInput = popup.locator('input#pw, input[name="pw"], input[type="password"]').first();
  await pwInput.click();
  await pwInput.fill("");
  await popup.keyboard.type(loginPw, { delay: 50 });

  // 로그인 버튼 클릭
  const loginBtn = popup.locator('button:has-text("로그인"), button.btn_login, #log\\.login').first();
  await loginBtn.click();

  // 로그인 완료 대기 (URL 변경)
  await popup.waitForTimeout(3000);

  // 로그인 상태 유지 체크박스가 뜨면 스킵
  const keepLoginBtn = popup.locator('button:has-text("유지"), button:has-text("확인")').first();
  if (await keepLoginBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await keepLoginBtn.click();
    await popup.waitForTimeout(1000);
  }

  // 2차 인증 페이지 체크
  const currentUrl = popup.url();
  if (currentUrl.includes("nid.naver.com") && (currentUrl.includes("login") || currentUrl.includes("sign"))) {
    // 여전히 로그인 페이지면 실패
    const hasError = await popup.locator('.error_message, .err_common, #err_common').isVisible({ timeout: 2000 }).catch(() => false);
    if (hasError) {
      throw new Error("네이버 로그인 실패: 아이디/비밀번호를 확인해주세요");
    }
    // 2차 인증 등 추가 검증이 필요할 수 있음
    console.log("[ohouse-purchase] 네이버 로그인 후 추가 인증 대기 중...");
    await popup.waitForURL((url) => !url.toString().includes("nid.naver.com"), { timeout: 30000 }).catch(() => {
      throw new Error("네이버 로그인 추가 인증 시간 초과");
    });
  }

  console.log("[ohouse-purchase] 네이버 로그인 성공");
}

/** "동의하고 결제하기" 버튼 클릭 */
async function clickAgreeAndPay(popup: Page) {
  console.log("[ohouse-purchase] '동의하고 결제하기' 버튼 대기 중...");

  // 네이버페이 결제 페이지 로딩 대기
  for (let attempt = 0; attempt < 20; attempt++) {
    const url = popup.url();

    // 결제 페이지 확인 (m.pay.naver.com 또는 pay.naver.com)
    if (url.includes("pay.naver.com")) {
      // "동의하고 결제하기" 버튼 찾기
      const agreeBtn = popup.locator('button:has-text("동의하고 결제하기")').first();
      if (await agreeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        // 스크롤 다운하여 버튼이 보이게
        await popup.keyboard.press("End");
        await popup.waitForTimeout(500);
        await agreeBtn.click({ force: true });
        console.log("[ohouse-purchase] '동의하고 결제하기' 클릭 완료");
        return;
      }
    }

    await popup.waitForTimeout(1500);
  }

  throw new Error("네이버페이 '동의하고 결제하기' 버튼을 찾을 수 없습니다");
}

/** 네이버페이 비밀번호 키패드 입력 (랜덤 배치)
 *
 * 키패드는 pay.naver.com/authentication/pw/check 페이지에서 나타남
 * 숫자 0-9가 랜덤 배치된 HTML 버튼으로 구성됨
 */
async function enterNaverPayPassword(popup: Page, pin: string) {
  console.log("[ohouse-purchase] 네이버페이 비밀번호 키패드 입력 중...");

  // 키패드 페이지 로딩 대기
  for (let attempt = 0; attempt < 20; attempt++) {
    const url = popup.url();
    if (url.includes("authentication") || url.includes("pw/check")) break;
    await popup.waitForTimeout(1500);
  }
  await popup.waitForTimeout(3000);
  console.log(`[ohouse-purchase] 키패드 URL: ${popup.url()}`);

  // Gemini Vision으로 키패드 숫자 배치 분석 (보안 키패드 → DOM 접근 불가)
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const sharp = (await import("sharp")).default;

  // 키패드가 보이도록 스크롤 후 뷰포트 스크린샷 (fullPage가 아닌 뷰포트 기준)
  // 뷰포트 스크린샷 좌표 = mouse.click() 좌표 (정확히 일치)
  await popup.keyboard.press("End");
  await popup.waitForTimeout(1000);
  const screenshotBuf = await popup.screenshot();
  const base64 = Buffer.from(screenshotBuf).toString("base64");
  console.log("[ohouse-purchase] 키패드 스크린샷 캡처 완료");

  // Gemini API로 키패드 분석
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY 환경변수 필요");

  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash" });

  const geminiResult = await geminiModel.generateContent([
    { inlineData: { data: base64, mimeType: "image/png" } },
    { text: `이 이미지는 네이버페이 비밀번호 키패드입니다.
녹색 배경의 4행×3열 숫자 키패드를 읽어주세요.

출력 형식 (4줄, 쉼표 구분, 숫자 아닌 칸은 X):
예시:
7,8,9
1,5,3
6,0,4
X,2,X

규칙:
- 반드시 4줄, 각 줄 3개 값
- 0~9 각각 정확히 1번
- 마지막 행 좌측=전체삭제(X), 우측=삭제(X)
- 숫자와 쉼표만 출력, 설명 없이` },
  ]);

  const geminiText = geminiResult.response.text?.() ?? "";
  console.log(`[ohouse-purchase] Gemini 응답: ${geminiText.replace(/\n/g, " | ")}`);

  // 그리드 크기 계산 — 녹색 영역의 실제 경계를 감지
  const imgMeta = await sharp(screenshotBuf).metadata();
  const fullW = imgMeta.width || 750;
  const fullH = imgMeta.height || 800;

  let keypadTop = Math.round(fullH * 0.64);
  let keypadLeft = 0;
  let keypadRight = fullW;

  try {
    const rawPixels = await sharp(screenshotBuf).removeAlpha().raw().toBuffer();

    // 녹색 영역 상단(Y) 감지
    const cx = Math.round(fullW / 2);
    for (let y = Math.round(fullH * 0.5); y < fullH; y++) {
      const idx = (y * fullW + cx) * 3;
      if (rawPixels[idx] < 100 && rawPixels[idx + 1] > 120 && rawPixels[idx + 2] < 100) {
        keypadTop = y;
        break;
      }
    }

    // 녹색 영역 좌우(X) 경계 감지 (키패드 중간 높이에서 수평 스캔)
    const midY = keypadTop + Math.round((fullH - keypadTop) / 2);
    for (let x = 0; x < fullW; x++) {
      const idx = (midY * fullW + x) * 3;
      if (rawPixels[idx] < 100 && rawPixels[idx + 1] > 120 && rawPixels[idx + 2] < 100) {
        keypadLeft = x;
        break;
      }
    }
    for (let x = fullW - 1; x >= 0; x--) {
      const idx = (midY * fullW + x) * 3;
      if (rawPixels[idx] < 100 && rawPixels[idx + 1] > 120 && rawPixels[idx + 2] < 100) {
        keypadRight = x;
        break;
      }
    }
  } catch { /* 기본값 */ }

  const keypadW = keypadRight - keypadLeft;
  const keypadH = fullH - keypadTop;
  const rowH = Math.round(keypadH / 4);
  const colW = Math.round(keypadW / 3);
  console.log(`[ohouse-purchase] 키패드 영역: left=${keypadLeft} right=${keypadRight} top=${keypadTop} w=${keypadW} rowH=${rowH} colW=${colW}`);

  // Gemini 응답 파싱
  const digitMap = new Map<string, { x: number; y: number }>();
  const lines = geminiText.trim().split("\n").filter(l => l.includes(","));

  for (let row = 0; row < Math.min(lines.length, 4); row++) {
    const cells = lines[row].split(",").map(s => s.trim());
    for (let col = 0; col < Math.min(cells.length, 3); col++) {
      const cell = cells[col];
      if (/^[0-9]$/.test(cell)) {
        const centerX = keypadLeft + col * colW + Math.round(colW / 2);
        const centerY = keypadTop + row * rowH + Math.round(rowH / 2);
        digitMap.set(cell, { x: centerX, y: centerY });
        console.log(`[ohouse-purchase] '${cell}' → [${row},${col}] (${centerX},${centerY})`);
      }
    }
  }

  console.log(`[ohouse-purchase] 인식 완료: ${digitMap.size}개 (${Array.from(digitMap.keys()).sort().join(",")})`);

  // 비밀번호 6자리 좌표 클릭
  // 뷰포트 스크린샷 좌표 = mouse.click() 좌표 (직접 대응)
  for (const digit of pin) {
    const pos = digitMap.get(digit);
    if (!pos) {
      await popup.screenshot({ path: ".sessions/naverpay-keypad-error.png" }).catch(() => null);
      const recognized = Array.from(digitMap.keys()).sort().join(",");
      throw new Error(`키패드 숫자 '${digit}' 미인식 (인식됨: ${recognized})`);
    }

    await popup.mouse.click(pos.x, pos.y);
    console.log(`[ohouse-purchase] 키패드 '${digit}' 클릭 (${pos.x},${pos.y})`);
    await popup.waitForTimeout(300 + Math.random() * 200);
  }

  console.log("[ohouse-purchase] 네이버페이 비밀번호 입력 완료");

  // 결제 완료 시 팝업이 자동으로 닫힘 → 정상 처리
  try {
    await popup.waitForTimeout(3000);
  } catch {
    // "Target page, context or browser has been closed" = 결제 성공으로 팝업 닫힘
    console.log("[ohouse-purchase] 네이버페이 팝업 닫힘 (결제 처리 완료)");
  }
}

// ═══════════════════════════════════
// 결제 완료 대기
// ═══════════════════════════════════
async function waitForPaymentCompletion(page: Page) {
  // 결제 승인 후 자동으로 order_result?success=true 페이지로 리다이렉트됨
  const startTime = Date.now();
  const maxWait = PAYMENT_WAIT_MS + 10000; // 여유 10초 추가

  while (Date.now() - startTime < maxWait) {
    const url = page.url();

    // order_result?success=true URL로 리다이렉트 감지
    if (url.includes("order_result") && url.includes("success=true")) {
      console.log("[ohouse-purchase] 주문 완료 URL 감지: " + url);
      await page.waitForTimeout(2000);
      return;
    }

    // 네이버페이 팝업이 닫혔는지 확인 (결제 완료 시 팝업 자동 닫힘)
    const openPages = page.context().pages();
    const hasPayPopup = openPages.some(p => {
      const u = p.url();
      return u.includes("pay.naver.com") || u.includes("nid.naver.com");
    });
    if (!hasPayPopup && Date.now() - startTime > 5000) {
      // 팝업이 닫혔으면 메인 페이지 URL 재확인
      const mainUrl = page.url();
      if (mainUrl.includes("order_result")) {
        console.log("[ohouse-purchase] 네이버페이 팝업 닫힘 + 주문 완료 URL 감지");
        await page.waitForTimeout(2000);
        return;
      }
    }

    // 페이지 텍스트로도 확인 (fallback)
    const bodyText = await page.locator("body").textContent().catch(() => "");
    if (bodyText && (bodyText.includes("주문이 완료") || bodyText.includes("결제가 완료"))) {
      console.log("[ohouse-purchase] 주문 완료 텍스트 확인!");
      await page.waitForTimeout(2000);
      return;
    }

    await page.waitForTimeout(3000);
  }

  throw new Error("결제 승인 시간 초과");
}

// ═══════════════════════════════════
// 주문 정보 추출 (주문번호 + 원가)
// ═══════════════════════════════════
async function extractOrderInfo(page: Page): Promise<SingleOrderResult> {
  try {
    // 1. URL에서 주문번호 추출 (order_result 페이지: /orders/{주문번호}/order_result)
    let orderNo: string | null = null;
    const url = page.url();
    const urlMatch = url.match(/\/orders\/(\d+)/);
    if (urlMatch) {
      orderNo = urlMatch[1];
      console.log(`[ohouse-purchase] URL에서 주문번호 추출: ${orderNo}`);
    }

    // 2. 결제 완료 페이지에서 결제 금액 추출
    let cost: number | undefined;
    const pageText = await page.locator("body").textContent().catch(() => "") || "";
    const payMatch = pageText.match(/결제\s*금액\s*([0-9,]+)\s*원/);
    if (payMatch) cost = parseInt(payMatch[1].replace(/,/g, ""));

    // 3. URL에서 못 찾은 경우 주문상세 페이지로 이동하여 추출
    if (!orderNo) {
      const orderStatusBtn = page.locator('button:has-text("주문현황 보기")').first();
      if (await orderStatusBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await orderStatusBtn.click();
        await page.waitForTimeout(3000);
      }

      const orderDetailLink = page.locator('text=주문상세').first();
      if (await orderDetailLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await orderDetailLink.click();
        await page.waitForTimeout(3000);
      }

      // 주문상세 페이지: "주문번호 321361385" 텍스트
      const detailText = await page.locator("body").textContent().catch(() => "") || "";
      const orderNoMatch = detailText.match(/주문번호\s*(\d+)/);
      const costMatch = detailText.match(/주문금액\s*([0-9,]+)\s*원/);
      orderNo = orderNoMatch?.[1] ?? null;
      if (cost === undefined && costMatch) cost = parseInt(costMatch[1].replace(/,/g, ""));

      // URL fallback
      if (!orderNo) {
        const detailUrl = page.url();
        const detailMatch = detailUrl.match(/\/orders\/(\d+)/);
        if (detailMatch) orderNo = detailMatch[1];
      }
    }

    if (!orderNo) {
      throw new Error("주문번호를 추출할 수 없습니다");
    }

    console.log(`[ohouse-purchase] 주문번호: ${orderNo}, 원가: ${cost ?? "미확인"}`);

    return {
      purchaseOrderNo: orderNo,
      cost,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ohouse-purchase] 주문 정보 추출 오류:", msg);
    throw new Error(`주문 정보 추출 실패: ${msg}`);
  }
}
