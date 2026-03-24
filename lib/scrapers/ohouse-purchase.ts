import { type Page, type BrowserContext, type Cookie } from "playwright";
import { launchBrowser } from "./browser";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PurchaseOrderInfo, PurchaseResult } from "./types";
import { loadSession, saveSession, loadFileSession, saveFileSession } from "./session-manager";

const LOGIN_URL = "https://ohou.se/users/sign_in";

// 환경변수에서 읽기 (.env.local)
const FIXED_PHONE_SUFFIX = process.env.OHOUSE_PHONE_SUFFIX ?? "";
const KAKAO_PHONE = process.env.OHOUSE_KAKAO_PHONE ?? "";
const KAKAO_BIRTHDAY = process.env.OHOUSE_KAKAO_BIRTHDAY ?? "";
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
 *    e. 카카오페이 카톡결제 선택 → 결제요청
 *    f. 사용자 결제 승인 대기 (20-30초)
 *    g. 주문완료 → 주문번호 + 원가 추출
 */
export async function purchaseOhouse(
  loginId: string,
  loginPw: string,
  orders: PurchaseOrderInfo[],
  onProgress?: ProgressCallback,
  supabase?: SupabaseClient,
  abortSignal?: AbortSignal
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
            page, activeContext, singleOrder, q > 1, onProgress
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
  onProgress?: ProgressCallback
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

  // 6. 결제수단 선택 (카카오페이) + 결제요청
  onProgress?.(order.orderId, "waiting_payment", "카카오페이 결제 승인 대기 중...");
  await selectPaymentAndRequest(page);

  // 7. 사용자 결제 승인 대기
  console.log(`[ohouse-purchase] 결제 승인 대기 중... (${PAYMENT_WAIT_MS / 1000}초)`);
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
    console.error("[ohouse-purchase] 배송지 변경 오류:", err);
    throw new Error(`배송지 변경 실패: ${err instanceof Error ? err.message : String(err)}`);
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
    console.log("[ohouse-purchase] 배송메모 입력 오류 (계속 진행):", err);
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
    console.log("[ohouse-purchase] 주문자 정보 입력 오류 (계속 진행):", err);
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
async function selectPaymentAndRequest(page: Page) {
  try {
    // 결제 영역으로 스크롤
    await page.keyboard.press("End");
    await page.waitForTimeout(1000);

    // 1. 간편결제 선택 (카카오페이)
    const easyPayBtn = page.locator('label:has-text("간편결제"), button:has-text("간편결제"), [class*="간편결제"]').first();
    if (await easyPayBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await easyPayBtn.click();
      await page.waitForTimeout(1000);
    }

    // "카카오페이" 선택
    const kakaoPayBtn = page.locator('label:has-text("카카오페이"), button:has-text("카카오페이"), [class*="kakao"]').first();
    if (await kakaoPayBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await kakaoPayBtn.click();
      await page.waitForTimeout(1000);
      console.log("[ohouse-purchase] 카카오페이 선택 완료");
    }

    // 2. 결제하기 버튼 클릭 + 팝업 감지
    await page.keyboard.press("End");
    await page.waitForTimeout(1000);

    const payBtn = page.locator('button:has-text("결제하기")').first();
    await payBtn.waitFor({ state: "visible", timeout: 10000 });

    // 팝업 대기를 먼저 등록한 뒤 클릭 (타이밍 이슈 방지)
    // timeout을 2초로 짧게: ohouse는 iframe 방식이므로 팝업 미감지 시 빠르게 fallback
    const popupPromise = page.context().waitForEvent("page", { timeout: 2000 });
    await payBtn.click();
    console.log("[ohouse-purchase] 결제하기 버튼 클릭");

    let popup: Page | null = null;
    try {
      popup = await popupPromise;
      console.log(`[ohouse-purchase] 카카오페이 팝업 창 감지: ${popup.url()}`);
    } catch {
      // 팝업 없이 iframe으로 처리되는 경우 (ohouse 기본)
      console.log("[ohouse-purchase] 팝업 없음, iframe 방식으로 시도");
    }

    // 3. 카카오페이 팝업 또는 iframe에서 카톡결제 선택
    await switchToKakaoPayAndRequest(page, popup);
  } catch (err) {
    console.error("[ohouse-purchase] 결제 처리 오류:", err);
    throw new Error(`결제 처리 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 카카오페이 팝업 창 또는 중첩 iframe에서 카톡결제 선택 및 결제요청
 *
 * - 팝업 방식: 결제하기 클릭 시 새 창(popup)이 열리는 경우 → popup.frames() 탐색
 * - iframe 방식: 기존처럼 메인페이지 내 중첩 iframe으로 열리는 경우 → page.frames() 탐색
 */
async function switchToKakaoPayAndRequest(page: Page, popup: Page | null) {
  // 팝업이 있으면 팝업에서, 없으면 원래 페이지에서 탐색
  const targetPage = popup ?? page;

  // 팝업 방식: 이미 카카오 페이지에 있으므로 첫 시도 전 대기 짧게
  // iframe 방식: 페이지 내 iframe 렌더링 대기 필요
  const initWait = popup ? 800 : 2000;
  await targetPage.waitForTimeout(initWait);

  for (let attempt = 0; attempt < 15; attempt++) {
    if (attempt > 0) await targetPage.waitForTimeout(1500);

    // targetPage.frames()로 모든 중첩 iframe 탐색 (카카오페이 프레임 찾기)
    for (const frame of targetPage.frames()) {
      const url = frame.url();
      if (!url.includes("kakaopay") && !url.includes("kakao")) continue;

      console.log(`[ohouse-purchase] 카카오페이 프레임 발견: ${url}`);

      // 카톡결제 탭 클릭 (기본은 QR결제 탭)
      const kakaoTalkTab = frame.locator('[role="tab"]:has-text("카톡결제")').first();
      if (await kakaoTalkTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await kakaoTalkTab.click();
        await targetPage.waitForTimeout(1000);
        console.log("[ohouse-purchase] 카톡결제 탭 선택");
      } else {
        continue; // 아직 로딩 중
      }

      // 전화번호 입력 - 다양한 셀렉터 fallback
      const phoneSelectors = [
        'input[placeholder*="휴대폰"]',
        'input[placeholder*="번호"]',
        'input[type="tel"]',
        'input:not([disabled]):not([readonly])',
      ];
      let phoneFilled = false;
      for (const sel of phoneSelectors) {
        const phoneInput = frame.locator(sel).first();
        if (await phoneInput.isVisible({ timeout: 1500 }).catch(() => false)) {
          await phoneInput.click({ force: true });
          await phoneInput.fill(KAKAO_PHONE);
          console.log(`[ohouse-purchase] 카카오페이 전화번호 입력 완료`);
          phoneFilled = true;
          break;
        }
      }
      if (!phoneFilled) console.log("[ohouse-purchase] 전화번호 input 못 찾음");

      // 생년월일 입력 - 다양한 셀렉터 fallback
      const bdaySelectors = [
        'input[placeholder*="생년월일"]',
        'input[placeholder*="생년"]',
      ];
      let bdayFilled = false;
      for (const sel of bdaySelectors) {
        const bdayInput = frame.locator(sel).first();
        if (await bdayInput.isVisible({ timeout: 1500 }).catch(() => false)) {
          await bdayInput.click({ force: true });
          await bdayInput.fill(KAKAO_BIRTHDAY);
          console.log(`[ohouse-purchase] 카카오페이 생년월일 입력 완료`);
          bdayFilled = true;
          break;
        }
      }
      if (!bdayFilled) {
        // 두 번째 input으로 fallback (전화번호가 첫 번째)
        const secondInput = frame.locator('input:not([disabled]):not([readonly])').nth(1);
        if (await secondInput.isVisible({ timeout: 1500 }).catch(() => false)) {
          await secondInput.click({ force: true });
          await secondInput.fill(KAKAO_BIRTHDAY);
          console.log(`[ohouse-purchase] 카카오페이 생년월일 입력 완료 (fallback)`);
        } else {
          console.log("[ohouse-purchase] 생년월일 input 못 찾음");
        }
      }

      // 결제요청 버튼 클릭 (입력 후 활성화됨)
      await targetPage.waitForTimeout(700);
      const requestBtn = frame.locator('button:has-text("결제요청")').first();
      if (await requestBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        try {
          await requestBtn.click({ force: true, timeout: 5000 });
          console.log("[ohouse-purchase] 결제요청 클릭 완료");
          return;
        } catch {
          console.log("[ohouse-purchase] 결제요청 버튼 클릭 실패, 재시도...");
        }
      }
    }
  }

  throw new Error("카카오페이 결제 화면을 찾을 수 없습니다");
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

    // 페이지 텍스트로도 확인 (fallback)
    const bodyText = await page.locator("body").textContent().catch(() => "");
    if (bodyText && (bodyText.includes("주문이 완료") || bodyText.includes("결제가 완료"))) {
      console.log("[ohouse-purchase] 주문 완료 텍스트 확인!");
      await page.waitForTimeout(2000);
      return;
    }

    await page.waitForTimeout(3000);
  }

  throw new Error("결제 승인 시간 초과 (휴대폰에서 결제를 승인했는지 확인해주세요)");
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
    let cost: number | null = null;
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
      if (!cost && costMatch) cost = parseInt(costMatch[1].replace(/,/g, ""));

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
      cost: cost ?? undefined,
    };
  } catch (err) {
    console.error("[ohouse-purchase] 주문 정보 추출 오류:", err);
    throw new Error(`주문 정보 추출 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}
