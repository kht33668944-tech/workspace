# 지마켓 자동구매 최종 결제금액 한도 검사 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 지마켓 자동구매에서 "결제하기" 클릭 직전에 주문결제 페이지의 "최종 결제금액"을 읽어, 회당 한도(정산예정금액÷수량 + 허용적자)를 초과하면 결제하지 않고 실패 처리한다.

**Architecture:** 클라이언트 모달에서 주문별 회당 결제 한도를 계산해 `PurchaseOrderInfo.maxPaymentPerUnit`으로 전달하고, 스크래퍼의 `processPayment()`가 결제 버튼 클릭 직전에 페이지의 최종 결제금액을 파싱해 한도 초과 시 에러를 throw한다. 에러는 기존 실패/부분구매 처리 경로를 그대로 탄다. API route 변경 없음.

**Tech Stack:** Next.js 16 / React 19 / TypeScript 5 (strict) / Playwright(patchright)

## Global Constraints

- 테스트 프레임워크 없음 → 각 태스크 검증은 `npx tsc --noEmit` + 수동 확인
- 커밋은 **사용자 승인 후에만** 진행 (사용자 지침)
- console.log에 `[컴포넌트명]` 접두어 필수 (스크래퍼는 `[gmarket-purchase]`)
- 에러 로깅 시 bare error 금지 → `e instanceof Error ? e.message : String(e)`
- 금액을 확인할 수 없으면 결제하지 않는다 (안전 우선)
- 허용 적자 미입력 시 0원. 한도와 같으면(마진 0 또는 허용적자 소진) 진행, 초과부터 중단
- `settlement`가 0 이하인 주문은 한도 미전달 → 검사 생략

---

### Task 1: `PurchaseOrderInfo`에 회당 결제 한도 필드 추가

**Files:**
- Modify: `lib/scrapers/types.ts:33-45` (interface PurchaseOrderInfo)

**Interfaces:**
- Produces: `PurchaseOrderInfo.maxPaymentPerUnit?: number` — 회당 결제 한도(원). undefined면 검사 생략. Task 2(스크래퍼)와 Task 3(모달)이 사용.

- [ ] **Step 1: 필드 추가**

`lib/scrapers/types.ts`의 `PurchaseOrderInfo`에서 `optionName` 라인 뒤에 추가:

```ts
  optionName?: string;    // 옵션명 (옵션선택 드롭다운이 있는 상품용; 미지정 시 첫 번째 옵션 선택)
  maxPaymentPerUnit?: number; // 회당 결제 한도(원) = 정산예정÷수량 + 허용적자. 미지정 시 최종 결제금액 검사 생략
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음 (기존 오류가 있다면 이 변경과 무관한지 확인)

---

### Task 2: 스크래퍼 — 결제 직전 최종 결제금액 검사

**Files:**
- Modify: `lib/scrapers/gmarket-purchase.ts:476` (processSingleOrder의 processPayment 호출)
- Modify: `lib/scrapers/gmarket-purchase.ts:1515-1541` (processPayment 함수)

**Interfaces:**
- Consumes: `PurchaseOrderInfo.maxPaymentPerUnit` (Task 1)
- Produces: `assertFinalPaymentWithinLimit(page: Page, maxPaymentPerUnit: number): Promise<void>` — 한도 초과/파싱 실패 시 throw. `processPayment(page, paymentPin, maxPaymentPerUnit?)` 시그니처 변경.

- [ ] **Step 1: processPayment 시그니처 변경 및 호출부 수정**

`lib/scrapers/gmarket-purchase.ts:476` (processSingleOrder 내):

```ts
  // 7. 결제하기 클릭 + 비밀번호 입력 (결제 직전 최종 결제금액 한도 검사 포함)
  await processPayment(activePage, paymentPin, order.maxPaymentPerUnit);
```

참고: 반복 구매 시 `purchaseGmarket`의 루프(line 175)가 `{ ...order, quantity: 1 }`로 spread하므로 `maxPaymentPerUnit`은 매 회차에 그대로 전달된다. 별도 수정 불필요.

- [ ] **Step 2: 한도 검사 함수 추가 + processPayment에서 호출**

`processPayment` 함수 정의를 다음으로 변경 (`applyPaymentDiscount(page)` 호출과 "결제하기" 버튼 클릭 사이에 검사 삽입):

```ts
async function processPayment(page: Page, paymentPin: string, maxPaymentPerUnit?: number) {
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

  // 결제할인 드롭다운이 있으면 최대 금액 옵션 선택 (없으면 스킵)
  await applyPaymentDiscount(page);

  // 결제 직전 최종 결제금액 한도 검사 (쿠폰 소진 등으로 비싸게 사는 것 방지)
  if (maxPaymentPerUnit !== undefined) {
    await assertFinalPaymentWithinLimit(page, maxPaymentPerUnit);
  }

  // "결제하기" 버튼 클릭
  const payBtn = page.locator('button:has-text("결제하기"), a:has-text("결제하기")').first();
  await payBtn.waitFor({ state: "visible", timeout: 10000 });
  await payBtn.click({ force: true });
  console.log("[gmarket-purchase] 결제하기 버튼 클릭 완료");
```

(이후 기존 코드 그대로)

`processPayment` 함수 바로 위에 검사 함수 추가:

```ts
// ═══════════════════════════════════
// 결제 직전 최종 결제금액 한도 검사
// 쿠폰 개수 제한 소진 등으로 결제금액이 회당 한도(정산예정÷수량 + 허용적자)를
// 넘으면 결제하지 않고 실패 처리한다. 금액을 못 읽어도 안전을 위해 결제하지 않는다.
// ═══════════════════════════════════
async function assertFinalPaymentWithinLimit(page: Page, maxPaymentPerUnit: number): Promise<void> {
  let finalAmount: number | null = null;

  // 결제할인 적용 직후 금액이 갱신될 시간을 잠깐 준다
  await page.waitForTimeout(1000);

  for (let attempt = 0; attempt < 3; attempt++) {
    const bodyText = await page
      .evaluate(() => document.body?.innerText || "")
      .catch(() => "");
    const match = bodyText.match(/최종\s*결제\s*금액\s*([0-9,]+)\s*원/);
    if (match) {
      finalAmount = parseInt(match[1].replace(/,/g, ""), 10);
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (finalAmount === null || Number.isNaN(finalAmount)) {
    throw new Error(
      `최종 결제금액을 확인할 수 없어 결제 전에 구매를 중단했습니다 (회당 한도 ${maxPaymentPerUnit.toLocaleString()}원).`
    );
  }

  console.log(
    `[gmarket-purchase] 최종 결제금액 검사: ${finalAmount.toLocaleString()}원 / 한도 ${maxPaymentPerUnit.toLocaleString()}원`
  );

  if (finalAmount > maxPaymentPerUnit) {
    throw new Error(
      `최종 결제금액 ${finalAmount.toLocaleString()}원이 회당 한도 ${maxPaymentPerUnit.toLocaleString()}원(정산예정÷수량+허용적자)을 초과해 결제 전에 구매를 중단했습니다. 쿠폰 소진 여부를 확인하세요.`
    );
  }
}
```

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

---

### Task 3: 모달 — 허용 적자 입력칸 + 회당 한도 계산

**Files:**
- Modify: `components/workspace/orders/auto-purchase-modal.tsx:74` (state 추가)
- Modify: `components/workspace/orders/auto-purchase-modal.tsx:427-438` (purchaseOrders 빌드)
- Modify: `components/workspace/orders/auto-purchase-modal.tsx:731-755` (결제 비밀번호 섹션 뒤 UI 추가)

**Interfaces:**
- Consumes: `Order.settlement: number`, `Order.quantity`, `PurchaseOrderInfo.maxPaymentPerUnit` (Task 1)

- [ ] **Step 1: state 추가**

line 74-75 근처 (`paymentPin` state 아래):

```tsx
  const [paymentPin, setPaymentPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  // 허용 적자(원): 회당 결제금액이 (정산예정÷수량 + 이 값)을 넘으면 구매 중단. 빈칸이면 0원
  const [maxDeficit, setMaxDeficit] = useState("");
```

- [ ] **Step 2: purchaseOrders 빌드에 maxPaymentPerUnit 추가**

line 427-438의 map을 다음으로 변경:

```tsx
      const allowedDeficit = Math.max(0, parseInt(maxDeficit, 10) || 0);
      const purchaseOrders: PurchaseOrderInfo[] = group.orders.map((o) => {
        const qty = Math.max(Number(o.quantity) || 1, 1);
        const settlement = Number(o.settlement) || 0;
        return {
          orderId: o.id,
          productUrl: o.purchase_url!,
          recipientName: o.recipient_name || "",
          postalCode: o.postal_code || "",
          address: o.address || "",
          addressDetail: o.address_detail || "",
          recipientPhone: o.recipient_phone || "",
          deliveryMemo: o.delivery_memo || "",
          quantity: o.quantity || 1,
          productName: o.product_name || "",
          // 정산예정금액이 있는 주문만 회당 결제 한도 전달 (없으면 검사 생략)
          ...(settlement > 0 && {
            maxPaymentPerUnit: Math.floor(settlement / qty) + allowedDeficit,
          }),
        };
      });
```

- [ ] **Step 3: 허용 적자 입력 UI 추가**

결제 비밀번호 섹션(닫는 `)}`, line 755) 바로 뒤에 추가. 지마켓 그룹이 있을 때만 표시:

```tsx
              {/* 허용 적자 (지마켓: 결제 직전 최종 결제금액 한도 검사) */}
              {totalMatchedOrders > 0 && matchedGroups.some(g => g.platform === "gmarket") && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-[var(--text-secondary)]">허용 적자 (원)</h3>
                  <div className="max-w-48">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={maxDeficit}
                      onChange={(e) => setMaxDeficit(e.target.value.replace(/\D/g, "").slice(0, 7))}
                      placeholder="0"
                      className="w-full px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50"
                    />
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">
                    최종 결제금액이 (정산예정÷수량 + 허용 적자)를 넘으면 결제하지 않고 실패 처리합니다. 비워두면 0원(적자 불허).
                  </p>
                </div>
              )}
```

- [ ] **Step 4: 타입 체크 + 빌드 확인**

Run: `npx tsc --noEmit`
Expected: 오류 없음

Run: `npm run lint`
Expected: 신규 경고/오류 없음

---

### Task 4: 수동 검증 및 커밋 (사용자 승인 후)

- [ ] **Step 1: UI 확인**

`npm run dev` → 주문 관리에서 자동구매 모달 열기.
Expected: 지마켓 계정 그룹이 있을 때 "허용 적자 (원)" 입력칸이 결제 비밀번호 아래 표시. 숫자만 입력 가능.

- [ ] **Step 2: 차단 동작 확인 (실결제 없이)**

정산예정금액이 실제 구매가보다 확실히 낮은 테스트 주문(예: settlement 1,000원)으로 자동구매 실행.
Expected: 결제하기 클릭 전에 실패 처리, 진행 화면과 `purchase_logs.error_message`에 "최종 결제금액 N원이 회당 한도 M원…" 사유 기록, 주문 상태 복원(구매확인필요 경로), 실제 결제 없음.

- [ ] **Step 3: 정상 동작 확인**

정산예정금액이 정상(구매가보다 높은)인 주문으로 자동구매 실행.
Expected: 기존과 동일하게 결제 진행, 콘솔에 `[gmarket-purchase] 최종 결제금액 검사: …` 로그.

- [ ] **Step 4: 사용자 승인 후 커밋**

```bash
git add lib/scrapers/types.ts lib/scrapers/gmarket-purchase.ts components/workspace/orders/auto-purchase-modal.tsx docs/superpowers/specs/2026-08-05-gmarket-payment-limit-design.md docs/superpowers/plans/2026-08-05-gmarket-payment-limit.md
git commit -m "feat: 지마켓 자동구매 최종 결제금액 한도 검사 (정산예정÷수량+허용적자 초과 시 결제 중단)"
```
