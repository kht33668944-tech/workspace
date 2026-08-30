---
name: smartstore-cancel
description: 발주서에서 "취소준비 + 판매처=스마트스토어"인 주문을 스마트스토어센터에서 판매자 직접취소하고 발주서를 취소완료로 바꾼다. 사용자가 "스마트스토어 취소", "스토어 취소해줘", "취소준비 스마트스토어건 처리" 등을 요청할 때 사용.
---

# 스마트스토어 판매자 직접취소 자동화

발주서의 `취소준비` + `판매처=스마트스토어` 주문을 발주(주문)확인/발송관리에서 일괄 판매취소한다.

화면: <https://sell.smartstore.naver.com/#/naverpay/sale/delivery?summaryInfoType=NEW_ORDERS_DELIVERY_OPERATED_AFTER>

## 화면 구조 — 여기서 헤맨다

- 본문은 **iframe** 안에 있다: `sell.smartstore.naver.com/o/v3/n/sale/delivery`. 최상위 document에는 버튼도 목록도 없다.
- 목록은 **TOAST UI Grid**다. `<table>`을 헤더 기준으로 찾으면 못 찾는다.
  - 헤더: `.tui-grid-{l|r}side-area .tui-grid-head-area th`
  - 본문: `.tui-grid-{l|r}side-area .tui-grid-body-area tbody tr`
  - 좌측 고정영역(체크박스·상품주문번호·주문번호…)과 우측(수취인명·상품명·수량…)이 컬럼을 나눠 갖는다. **좌우 헤더를 각각 읽어 인덱스를 맞춘 뒤 같은 순번끼리 합쳐야 한다.** 좌측은 맨 앞에 체크박스 열이 하나 더 있어 오프셋 보정이 필요하다.
- 조회기간 기본값은 1주일이다. 오래된 취소준비 건이 빠지므로 **3개월**로 넓히고 검색한다.

## 취소 절차 — 확인만 누르면 끝이 아니다

1. 대상 행 체크 → **[판매자 직접취소 처리]** 클릭
2. 브라우저 **네이티브 confirm**: "선택하신 N개 주문 건 중 N개 판매취소 가능합니다…" → `dialog` 이벤트로 수락
3. **별도 팝업창**(`/o/n/sale/delivery/pop/cancelSaleBySelection`)이 열린다 — 여기서 확정해야 실제로 취소된다
   - `select[name=claimRequestReasonType]` → `DELAYED_DELIVERY` (배송지연)
   - `textarea[name=reqDetailContent]` → **필수**. 비우면 "구매고객에게 노출 할 판매취소 사유를 입력해주세요" 알림만 뜨고 처리되지 않는다
   - **[판매취소 처리]** 클릭 → "총 N개의 주문 건 …사유로 판매취소 처리 완료되었습니다" 알림 후 팝업이 스스로 닫힌다

2단계 confirm만 수락하고 끝내면 **아무것도 취소되지 않는다.** 목록에는 그대로 남는다.

## 실행 절차

```bash
npm run ss:cancel            # 크롬 실행 + 대조 + 확인창까지만
npm run ss:cancel -- --go    # 전건 판매취소
node scripts/_ss-collect.mjs && node scripts/ss-cancel-apply.mjs   # 목록에서 빠진 것 확인 후 발주서 반영
```

**발주서 반영은 반드시 목록 재수집으로 검증한 뒤에 한다.** 스크립트가 "처리 완료"를 찍어도 실제로는 취소되지 않았을 수 있다(위 3단계 누락이 그 사례였다).

## 매칭 규칙

목록에는 취소하면 안 되는 주문이 섞여 있다. 수취인명·구매자명·상품명·수량이 모두 일치할 때만 대상으로 삼고, 같은 조합이 여러 건이면 발주서에 있는 개수만큼만 소비한다.

## 안전장치 (하나라도 어긋나면 중단)

1. 상품주문번호로 행을 식별한 뒤, 수취인명·상품명·수량을 화면에서 **다시** 대조한다
2. 화면에서 실제 체크된 개수가 기대 개수와 같은지 확인한다
3. 확인창의 "N개 판매취소 가능" 숫자가 체크 수와 같은지 확인한다 — 다르면 수락하지 않는다
4. 처리 후 팝업이 닫히지 않으면 중단한다

## 주의사항

- 취소 사유는 `배송지연`, 상세 문구는 `배송 장기 지연`. 이 문구는 **구매고객에게 노출된다**.
- 팝업 경고: 상품 품절 사유로 취소 시 판매관리 페널티가 부과되고 해당 주문 상품도 품절 처리된다.
- 처리 성공 시 팝업이 스스로 닫히므로, `pop.waitForTimeout`으로 기다리면 예외가 난다. 메인 페이지 기준으로 기다린다.

## 구성 파일

| 파일 | 역할 |
|---|---|
| `scripts/ss-cancel-run.mjs` | 전체 파이프라인 러너 (`npm run ss:cancel`) |
| `scripts/_ss-list.mjs` | 발주서에서 취소준비 스마트스토어 추출 |
| `scripts/_ss-collect.mjs` | 발주/발송관리 목록 수집 (3개월 조회) |
| `scripts/_ss-match.mjs` | 4개 키 대조 |
| `scripts/ss-cancel.mjs` | 판매취소 실행 (`--dry` / `--limit N`) |
| `scripts/ss-cancel-apply.mjs` | 발주서 취소완료 반영 |

쿠팡은 `coupang-cancel`, 지마켓·옥션은 `esm-cancel` 스킬을 쓴다. 셋 다 절차가 전혀 다르다.
