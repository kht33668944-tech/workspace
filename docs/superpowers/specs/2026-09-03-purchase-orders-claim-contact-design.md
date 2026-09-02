# 반품·교환 연락처 최신화 + 구매 주문 목록(다건 구매) 설계

## Context

쿠팡은 반품/교환이 접수되면 수취인·주문자 안심번호를 새로 발급한다. 우리 발주서는 주문 최초 수집 때 저장한 번호를 다시 쓰지 않아(`order-sync.ts`의 기존 주문은 `skippedExisting`으로 건너뜀, `applyClaim`은 claim_* 컬럼만 갱신) 반품 고객 연락처가 만료된 번호로 남는다. 조사 중 같은 성격의 빈틈이 추가로 확인됐다.

- 스마트스토어는 발송 전 구매자 배송지 변경(`DELIVERY_ADDRESS_CHANGED`)을 조회하지 않아 자동구매가 옛 주소로 나갈 수 있다.
- 교환 건도 연락처·재배송지를 받지 않는다.
- 부분 반품 수량을 기록하지 않는다.
- 수량 2개 이상 자동구매는 지마켓에서 N번 따로 결제하지만 발주서에는 마지막 주문번호·결제번호(상세링크) 하나만 남는다(`gmarket-purchase.ts:157-224` `lastOrderNo/lastPayNo`). 그래서 반품 자동화는 1건만 신청하고, 운송장 수집은 마지막 주문번호로만 매칭한다. 수동 묶음구매(주문 1건에 수량 2)와도 구분되지 않는다.

사용자 결정 사항
- 운송장은 지금처럼 **첫 번째로 수집된 운송장 하나**를 대표 운송장으로 마켓에 보낸다. 나머지는 목록에만 보관.
- 발주서 구조: 기존 `purchase_order_no` / `purchase_detail_url` / `courier` / `tracking_no` 칸은 **대표값**으로 유지하고, 새 JSONB 컬럼 `purchase_orders`에 구매 주문 목록을 둔다. 목록이 비어 있으면 대표값 1건으로 간주(기존 데이터 마이그레이션 불필요).

## 범위 (한 브랜치, 6개 작업 단위)

| # | 작업 | 주요 파일 |
|---|---|---|
| A | DB·타입 추가 | `supabase/migrations/20260903_purchase_orders_claim_contact.sql`, `types/database.ts` |
| B | 쿠팡 반품·교환 시 연락처·수량 갱신 | `lib/coupang-api.ts`, `lib/marketplace/order-sync.ts` |
| C | 스마트스토어 반품·교환 연락처·수량 + 배송지 변경 반영 | `lib/naver-commerce-api.ts`, `lib/marketplace/order-sync.ts` |
| D | 구매 주문 목록 저장 (자동구매) | `lib/purchase-orders.ts`(신규), `lib/scrapers/types.ts`, `lib/scrapers/gmarket-purchase.ts`, `lib/scrapers/ohouse-purchase.ts`, `app/api/orders/auto-purchase/route.ts` |
| E | 운송장 수집·반품 자동화·반품 추적을 목록 기준으로 | `lib/tracking/collect-all.ts`, `lib/tracking/apply.ts`, `app/api/orders/collect-tracking/route.ts`, `app/api/marketplace-api/returns/gmarket/route.ts`, `lib/tracking/gmarket-return-track.ts` |
| F | 화면·엑셀 | `components/workspace/orders/order-side-panel.tsx`, `table/table-utils.ts`, `hooks/use-orders.ts`, `app/workspace/orders/page.tsx`, `lib/excel-export.ts`, `lib/excel-parser.ts` |

범위 밖(후속): 지마켓 반품 모달에서 수거지 연락처를 새 안심번호로 바꿔 넣는 기능. 드라이런 때 해당 입력칸 존재 여부만 확인해 보고한다.

---

## A. DB·타입

마이그레이션 `supabase/migrations/20260903_purchase_orders_claim_contact.sql` (기존 스타일: `add column if not exists`, 수동 적용)

```sql
alter table orders add column if not exists purchase_orders jsonb not null default '[]'::jsonb;
alter table orders add column if not exists claim_quantity integer;
alter table orders add column if not exists claim_contact_updated_at timestamptz;
create index if not exists idx_orders_purchase_orders_gin on orders using gin (purchase_orders jsonb_path_ops);
```

`types/database.ts`
- `Order`에 추가: `purchase_orders: PurchaseOrderEntry[]`, `claim_quantity?: number | null`, `claim_contact_updated_at?: string | null`, 그리고 **누락돼 있던** `claim_reason?: string | null`, `purchase_return_requested_at?: string | null`.
- 새 타입:

```ts
export interface PurchaseOrderEntry {
  order_no: string;            // 구매처 주문번호 (지마켓 orderNo / 오늘의집 orderNo)
  pay_no?: string | null;      // 지마켓 결제번호 (상세링크 키)
  detail_url?: string | null;  // purchaseDetailUrl() 결과
  quantity: number;            // 이 주문에 담긴 수량 (수동 묶음구매는 2 이상)
  courier?: string | null;
  tracking_no?: string | null;
  purchased_at?: string | null;
  return_requested_at?: string | null; // 지마켓 반품신청 완료 시각 (엔트리 단위)
  return_status?: "접수" | "완료" | null; // 반품 추적 결과
  source: "auto" | "manual";
}
```

`OrderUpdate`는 `Partial<Omit<Order,…>>`라 자동으로 쓰기 가능.

---

## B. 쿠팡 반품·교환 연락처·수량

### B-1. API 타입 (`lib/coupang-api.ts`)
`CoupangReturnRequest`에 optional 추가 (공식 문서 확인 완료: "반품 신청인 전화번호(안심번호)"):
`requesterName?`, `requesterPhoneNumber?`, `requesterRealPhoneNumber?`, `requesterAddress?`, `requesterAddressDetail?`, `requesterZipCode?`.

`CoupangExchangeRequest`: 교환 응답의 신청자·재배송지 필드명은 문서에서 아직 확인하지 못했다. 구현 시 첫 단계로 문서(`developers.coupang.com` 교환요청 목록 조회)를 WebFetch로 확인해 필드를 추가하고, 확인 안 되면 `syncCoupangExchanges`에서 응답 1건의 키 목록을 `console.log("[order-sync] exchange keys", Object.keys(x))`로 남기고 연락처 갱신은 반품만 우선 적용한다.

### B-2. `applyClaim` 확장 (`lib/marketplace/order-sync.ts:530`)
매개변수 끝에 `extra?: { contact?: { phone?: string | null; name?: string | null }; quantity?: number | null }` 추가. 세 갈래 update(상태 같음 / 역행 방지 / 본 갱신) 모두에서 공용 패치를 합친다.

```ts
function claimExtraPatch(extra) {
  const p: Record<string, unknown> = {};
  if (extra?.quantity != null) p.claim_quantity = extra.quantity;
  const phone = extra?.contact?.phone?.trim();
  if (phone) { p.recipient_phone = phone; p.orderer_phone = phone; p.claim_contact_updated_at = new Date().toISOString(); }
  return p;
}
```
- 취소(CANCEL)에는 contact를 넘기지 않는다(안심번호 변동 없음).
- 연락처는 값이 있을 때만 덮어쓴다. `TERMINAL` 상태(반품완료 등)는 지금처럼 조기 return 유지.
- `ClaimChange`에 `phoneUpdated?: boolean` 추가 → 디스코드/모달 표시에 "연락처 갱신" 표기(`order-sync-notify.ts`, `order-sync-modal.tsx`의 claim 줄에 접미어).

### B-3. `syncCoupangClaims` (:590)
`applyClaim(...)` 호출에 `{ contact: claimType === "RETURN" ? { phone: r.requesterPhoneNumber, name: r.requesterName } : undefined, quantity: matchedItems.reduce((s,i)=>s+(i.cancelCount??0),0) || r.cancelCountSum }` 전달. `matchedItems` = 해당 주문의 vendorItemId(`marketplace_product_order_no.split("-")[1]`)와 일치하는 `returnItems`.

### B-4. `syncCoupangExchanges` (:641)
`quantity` = 일치하는 `exchangeItemDtoV1s[].quantity` 합. contact는 B-1 확인 결과에 따라.

---

## C. 스마트스토어

### C-1. 타입 (`lib/naver-commerce-api.ts:105`)
`NaverProductOrderDetail`에 optional 추가:
```ts
return?: { claimId?: string; claimStatus?: string; returnReason?: string; requestQuantity?: number;
  collectAddress?: NaverAddress; };
exchange?: { claimId?: string; claimStatus?: string; exchangeReason?: string; requestQuantity?: number;
  collectAddress?: NaverAddress; reDeliveryAddress?: NaverAddress; };
```
`NaverAddress = { name?; tel1?; tel2?; zipCode?; baseAddress?; detailedAddress? }` (shippingAddress와 동일 형태를 공용 타입으로 추출).

### C-2. `syncNaverClaims` (:674)
- 연락처: `type === "RETURN"`이면 `d.return?.collectAddress?.tel1`, `EXCHANGE`면 `d.exchange?.collectAddress?.tel1`, 둘 다 없으면 `d.productOrder.shippingAddress?.tel1`. 값이 있고 기존과 다를 때만 갱신(applyClaim의 contact).
- 수량: `d.currentClaim?.requestQuantity ?? d.return?.requestQuantity ?? d.exchange?.requestQuantity`.
- 교환 재배송지: `reDeliveryAddress`가 있고 배송지와 다르면 `delivery_memo`에 `교환 재배송지: {주소}` 한 줄 append(주소 컬럼은 덮어쓰지 않음 — `order-claims.ts`의 `appendMemo` 재사용).

### C-3. 배송지 변경 반영 (신규 `syncNaverAddressChanges`, `syncOrders` 5단계 직전)
- `fetchNaverChangedIds(client, days, "DELIVERY_ADDRESS_CHANGED")` — 함수 시그니처의 type 유니온을 `NaverLastChangedType`으로 넓힌다.
- 해당 productOrderId가 `existing.byProductOrderNo`에 있으면 `fetchNaverDetails`로 상세를 받아 `shippingAddress`를 `mapNaverProductOrder`와 같은 규칙(`splitAddress`, `sanitizeAddressDetail`)으로 변환해 `recipient_name/recipient_phone/postal_code/address/address_detail/delivery_memo` 갱신. 기존 값과 모두 같으면 건너뜀.
- 이미 구매된 행(`purchase_order_no` 또는 `purchased_at` 있음)이면 컬럼은 갱신하되 `delivery_memo`에 `⚠ 구매 후 배송지 변경(마켓)` append하고 `result.addressChanges`에 `afterPurchase: true`로 기록.
- `SyncResult`에 `addressChanges: Array<{ orderId, recipientName, productName, afterPurchase }>` 추가(`app/api/marketplace-api/orders/sync/route.ts:44`의 빈 결과 리터럴에도 추가). 디스코드 알림(`order-sync-notify.ts`)에 "배송지 변경 N건(구매 후 M건)" 줄 추가.
- `loadExistingOrders`의 select에 `purchase_order_no, purchased_at, recipient_phone, orderer_phone`를 추가하고 `ExistingOrder`에 반영(연락처 비교·구매 여부 판단용).

---

## D. 구매 주문 목록 저장

### D-1. 공용 헬퍼 `lib/purchase-orders.ts` (신규)
```ts
export function getPurchaseOrders(o: Pick<Order,"purchase_orders"|"purchase_order_no"|"purchase_detail_url"|"courier"|"tracking_no"|"quantity"|"purchased_at">): PurchaseOrderEntry[]
// purchase_orders 가 비어 있고 purchase_order_no 가 있으면 대표값 1건(quantity = 주문 수량, source "manual") 을 만들어 반환
export function representativePatch(entries: PurchaseOrderEntry[]): Partial<Order>
// 첫 엔트리 → purchase_order_no, purchase_detail_url; 운송장은 tracking_no 가 있는 첫 엔트리 → courier, tracking_no
export function allOrderNos(entries): string[]
export function upsertEntry(entries, entry): PurchaseOrderEntry[]  // order_no 기준 교체/추가
```
서버·클라이언트 공용(순수 함수, supabase 의존 없음).

### D-2. 스크래퍼 (`lib/scrapers/types.ts`, `gmarket-purchase.ts`, `ohouse-purchase.ts`)
- `types.ts`에 `PurchasedUnit = { orderNo: string; payNo?: string; cost?: number; paymentMethod?: string }` 추가. `PurchaseResult.success/failed` 요소에 `units?: PurchasedUnit[]` 추가.
- 새 콜백 `onUnitPurchased?: (orderId, unit: PurchasedUnit, index: number, total: number) => Promise<void>|void`를 `purchaseGmarket`(:76) / `purchaseOhouse`(:45) 매개변수 끝에 추가.
- `runOrder` 루프(gmarket :195-207, ohouse :143-181): `units.push({orderNo, payNo, cost, paymentMethod})` 후 `await onUnitPurchased?.(...)` (try/catch, 실패는 warn만). `result.success/failed`에 `units` 포함. `lastOrderNo`는 그대로 두되 `result.success.purchaseOrderNo`는 **units[0].orderNo**(첫 구매)로 바꾼다(대표 = 첫 번째).

### D-3. 자동구매 route (`app/api/orders/auto-purchase/route.ts`)
- `onUnitPurchased`: `orders`에서 `purchase_orders, delivery_status` 읽고 `delivery_status === purchaseLockStatus`일 때만 `upsertEntry`로 append → `update({ purchase_orders }).eq(id).eq(user_id).eq("delivery_status", purchaseLockStatus)`. `purchase_logs`에 **단위별** insert(status success, purchase_order_no=unit.orderNo). 기존 완료 시점의 purchase_logs insert는 units가 있으면 생략(중복 방지).
- `onOrderComplete`(:246): `updateData`에 `purchase_orders`(최종 units 전체, 완료 시 재기록해 콜백 누락 보정)와 `purchase_detail_url`(첫 엔트리)까지 한 번에 포함. 기존 잠금 조건(`.eq(delivery_status, lock).or(purchase_order_no.is.null,…)`)과 `existingPurchaseNo` 차단 로직은 그대로.
- 부분구매 경로(:604-673): `purchase_orders`·`purchase_detail_url`도 함께 기록(현재 상세링크 누락 버그 해결).
- `assertOrderStillLockedForPurchase`(:226)의 `loggedNos.length >= expectedQty` 판단은 단위별 로그가 되면 정확해진다. 재시도 시 이미 산 단위 수만큼 건너뛰는 로직은 추가하지 않는다(현재도 부분구매는 재시도 안 함, :232).

---

## E. 목록 기준 파이프라인

### E-1. 운송장 수집
- `lib/tracking/collect-all.ts:42-66`: select에 `purchase_orders, quantity` 추가. 대상 조건을 "대표 tracking_no 비어 있음" 대신 "`getPurchaseOrders` 중 tracking_no 없는 엔트리가 하나라도 있음"으로. `orderNos` = 그 엔트리들의 order_no 전체.
- `lib/tracking/apply.ts:31`: 행 조회를 두 단계로 — ① `.eq("purchase_order_no", no)` ② `.contains("purchase_orders", [{ order_no: no }])`, id로 합집합. 각 행에서 `upsertEntry`로 엔트리 courier/tracking_no 채우고, **대표 `tracking_no`가 비어 있을 때만** `courier/tracking_no` 세팅(첫 수집 운송장 유지). 배송완료 전환·`shipped_to_marketplace_at` 초기화 규칙은 대표 운송장이 바뀔 때만 적용(기존 :46-49).
- `app/api/orders/collect-tracking/route.ts`는 `orderNos`를 그대로 넘기므로 변경 없음. 클라이언트에서 넘기는 목록을 만드는 곳(수집 모달)은 `allOrderNos`를 쓰도록 수정(`components/workspace/orders/*tracking*` — 구현 시 grep `orderNos`).
- `saveTrackingLogs`(:61)의 `.in("purchase_order_no", orderNos)`도 ②와 같은 contains 조회를 합친다.

### E-2. 지마켓 반품신청 (`app/api/marketplace-api/returns/gmarket/route.ts`)
- `fetchTargets`: select에 `purchase_orders, claim_quantity` 추가, 필터를 `.or("purchase_detail_url.ilike.%gmarket%,purchase_orders.neq.[]")`로 넓히고 코드에서 `getPurchaseOrders`로 지마켓 detail_url이 있는 엔트리만 남긴다. `purchase_return_requested_at is null` 조건은 유지(행 단위 완료 플래그).
- 실행: 신청 대상 엔트리 = `return_requested_at`이 없는 엔트리를 목록 순서대로, 누적 quantity가 `claim_quantity ?? 전체수량`에 도달할 때까지. 엔트리마다 `requestGmarketReturn(ctx, { detailUrl: e.detail_url, claimReason, dryRun })`. 성공 시 엔트리 `return_requested_at` 기록 후 `purchase_orders` update. 대상 엔트리를 전부 마쳤을 때 행의 `purchase_return_requested_at`·`delivery_memo`·`delivery_status(반품준비→반품접수)`를 지금처럼 기록. 일부만 성공하면 행 플래그는 비워 두어 다음 실행에서 남은 엔트리를 이어서 처리한다.
- 엔트리 quantity ≥ 2(수동 묶음구매)는 그대로 신청하되 결과 줄에 `묶음 {n}개` 표기. 지마켓 모달의 수량 선택 여부는 드라이런 때 확인해 보고(범위 밖).
- 미리보기/결과 row와 `gmarket-return-modal.tsx`에 `orderNos: string[]`·`entryCount` 표시("주문 2건").
- 드라이런 시 반품 모달 본문 텍스트에서 `연락처|휴대폰|전화` 입력칸 유무를 `hasContactField`로 보고(후속 작업 판단용).

### E-3. 반품 상태 추적 (`lib/tracking/gmarket-return-track.ts`)
- select에 `purchase_orders` 추가, 필터를 E-2와 같이 넓힘. `return_requested_at`이 있는 엔트리마다 `readGmarketReturnStatus(ctx, e.detail_url)` → 엔트리 `return_status` 저장.
- 행 상태: 신청한 엔트리가 **모두** 완료 → 반품완료, 하나라도 접수 이상 → 반품접수. 기존 rank 전진 규칙·guard 유지.

### E-4. 자동구매 단계 (`lib/marketplace/auto-purchase-stage.ts:181-193`)
select에 `purchase_orders` 추가, "이미 구매" 판정에 `getPurchaseOrders(o).length > 0` 포함.

---

## F. 화면·엑셀

- `order-side-panel.tsx` 주문 정보 블록: "구매 주문" 섹션 — 엔트리별 한 줄(`주문번호 · 수량 · 운송장 · [상세]링크 · 반품신청/완료 배지`), 삭제 버튼, 하단에 `주문번호 / 결제번호 / 수량` 입력으로 추가(`consultation_logs` 추가 UI 패턴 :36-53 재사용, `sanitizeText`). 저장은 `onUpdate(order.id, { purchase_orders, ...representativePatch(entries) })`. 첫 엔트리 삭제 시 대표값도 재계산.
- 반품·교환 정보: `claim_reason`, `claim_quantity`("요청 수량 1/3"), `claim_contact_updated_at`이 있으면 연락처 옆에 "반품 시 갱신됨" 표기.
- `table-utils.ts` `formatCell`: `purchase_order_no` 셀에 엔트리 2건 이상이면 ` 외 N건` 접미어. `purchase_detail_url` 셀은 그대로.
- 인라인 편집: 표에서 `purchase_order_no`를 직접 고치면 `use-orders.ts updateOrder`에서 첫 엔트리 order_no도 같이 바꾼다(엔트리가 있을 때). `purchase_orders`가 비어 있으면 종전과 동일.
- `hooks/use-orders.ts:234-254` 중복 경고: `purchaseNos`가 모두 `purchase_orders`에 있으면 경고 없음, `purchase_orders` 밖의 번호가 있을 때만 warning/danger. `hasPurchaseEvidence`(page.tsx:138, use-orders.ts:98)에 `purchase_orders.length` 추가.
- 엑셀 내보내기(`excel-export.ts:40-45`): `주문번호`=대표, `주문상세링크`=대표 유지. 새 컬럼 `구매주문목록` = `주문번호(결제번호)×수량 | …` 문자열. `page.tsx:1336` 표 내보내기도 동일.
- 엑셀 가져오기(`excel-parser.ts`): `주문번호` 값에 `,` `/` `|` 구분자가 있으면 분리해 `purchase_orders`(quantity 1씩, source manual) 생성, 대표는 첫 번째. `구매주문목록` 컬럼은 읽지 않는다(내보내기 전용).

---

## 재사용하는 기존 코드
- `splitAddress`, `sanitizeAddressDetail`, `mapNaverProductOrder` (`order-sync.ts:85-180`)
- `appendMemo` (`lib/marketplace/order-claims.ts`)
- `purchaseDetailUrl` (`lib/scrapers/types.ts:32`)
- `returnRank`, `CLAIM_STATUSES`, `TERMINAL_STATUSES` (`lib/constants.ts`)
- `sanitizeText` (`lib/sanitize`), consultation_logs 추가 UI 패턴

## 구현 순서
A → D(헬퍼·스크래퍼·route) → E → F → B → C. D~F는 자동구매 실검증이 필요하므로 먼저 붙이고, B·C는 API 응답 확인이 필요해 마지막.

## 검증
1. `npm run verify` (lint + typecheck). `scripts/*.mts`는 tsc 대상이 아니므로 `tracking-and-ship.mts`·`marketplace-order-sync.mts`는 `npx tsx --check` 대신 드라이런 실행으로 확인.
2. 마이그레이션 적용 후 `select purchase_orders, claim_quantity from orders limit 1`.
3. 자동구매: 개발 worktree에서 수량 2 주문 1건을 자동구매(실결제) → `purchase_orders` 2건, 대표=첫 주문, `purchase_logs` 2행, 상세링크가 첫 결제번호인지 확인. 부분구매 시나리오는 두 번째 결제 직전 중단으로 확인.
4. 운송장: `npx tsx scripts/tracking-and-ship.mts --dry`로 두 주문번호가 모두 조회 대상에 들어가는지 로그 확인 → 실제 실행 후 엔트리별 tracking_no·대표 운송장(첫 수집) 확인.
5. 반품: 자동화 페이지에서 지마켓 반품 드라이런 → 결과에 "주문 2건", 사유 매핑, `hasContactField` 보고 확인. 실행 후 엔트리별 `return_requested_at`, 행 `purchase_return_requested_at`, 상태 반품접수.
6. 쿠팡·스마트스토어 클레임: 자동화 PC에서 `npx tsx scripts/marketplace-order-sync.mts --dry --days 7` 로그에서 반품 건의 requesterPhoneNumber / collectAddress.tel1 값이 찍히는지 확인 → 실행 후 `recipient_phone`, `claim_quantity`, `claim_contact_updated_at` 확인. 교환 응답 키 목록 로그로 B-1 필드 확정.
7. 스마트스토어 배송지 변경: 테스트 주문에서 배송지 변경 → 다음 수집에서 주소 갱신·디스코드 "배송지 변경 1건" 확인.
8. 화면: 사이드패널에서 엔트리 추가/삭제, 표 "외 1건" 표시, 엑셀 내보내기 `구매주문목록` 컬럼, `A, B` 형식 가져오기.

## 주의
- 노트북 IP는 마켓 API가 차단되므로 6·7은 자동화 PC에서 실행(메모리: project_laptop_market_api_ip).
- 커밋·배포는 사용자 승인 후.
- 대표 컬럼(`purchase_order_no` 등)의 의미를 바꾸지 않으므로 송장 전송(`order-ship`), ESM 엑셀, 정산 대조는 수정 대상이 아니다.

---

## G. 반품신청 후 고객 안내 문자 (추가, 2026-09-03)

- 설정 `app_settings.return_sms = { enabled, templateName }` (기본 꺼짐, 템플릿 "반품 신청"). 자동화 페이지 토글 `components/workspace/settings/return-sms-setting.tsx`
- `lib/sms/return-notify.ts` `sendReturnRequestedSms`: 지마켓 반품신청 route가 한 주문(반품준비 건만, 교환 제외)의 신청을 모두 마친 직후 호출. 주문자번호(없으면 수령자번호)로 휴대폰 경로 1통. 마켓 반품 접수 때 재발급된 안심번호는 order-sync `applyClaim`이 이미 반영해 둔 상태
- 중복 방지: `sms_logs` order_id + batch_id 접두어 `auto-return:` 성공 기록 있으면 skip. KT 일일 한도는 `countTodayPhoneSms` 동일 규칙. 실패는 결과 행 `sms`에만 기록하고 반품 신청 결과는 바꾸지 않는다
- 디스코드 보고·모달 결과 줄에 "안내 문자 발송/실패" 표시
