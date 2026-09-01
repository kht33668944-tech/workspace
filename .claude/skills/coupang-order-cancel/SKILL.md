---
name: coupang-order-cancel
description: 쿠팡 WING 배송관리에서 결제완료 주문을 판매자사유로 대량 취소 접수할 때 사용한다. "쿠팡 주문 취소해줘", "결제완료 N건 취소", 특정 상품 주문만 취소, workspace DB에서 뽑은 주문번호 목록 취소, 품절/입고지연으로 주문 취소해야 하는 상황에 쓴다.
---

# 쿠팡 WING 주문 취소 자동화

쿠팡 WING 배송관리(결제완료)의 주문을 건별로 취소 접수한다. 쿠팡은 **취소/반품 접수를 1건씩만** 허용하므로 일괄 처리가 불가능하고, 반드시 루프로 돌려야 한다.

## 실행 전 반드시 확인할 것

취소는 **실제 고객 주문을 되돌릴 수 없게 만드는 작업**이다. 시작 전에 사용자에게 확인한다.

1. **대상 범위** — 전체인지, 특정 상품인지, 특정 주문번호 목록인지
2. **취소사유** — 기본값은 `판매자사유 → 배송 지연`. 다른 사유면 사용자가 지정
3. **건수** — 목록에서 대상을 세어 "N건 맞습니까" 확인받은 뒤 시작

첫 1건은 반드시 시범 실행하고 결과 스크린샷을 보여준 뒤 나머지를 돌린다.

## 접근 방법 (중요)

**Claude in Chrome 확장은 `wing.coupang.com`을 차단한다.** 사이트 권한을 켜도 "This site is not allowed due to safety restrictions"가 뜬다. 확장 설정으로 못 푼다.

→ **Playwright MCP를 쓴다.** 단, 별도 프로필이라 로그인 세션이 없다.

```
mcp__playwright__browser_navigate("https://wing.coupang.com/tenants/sfl-portal/delivery/management")
```

로그인 페이지가 뜨면 **사용자에게 직접 로그인을 요청한다.** 비밀번호 입력은 대신 할 수 없다. 로그인 후 같은 URL로 재이동하면 세션이 유지된다.

## 대상 선정

### A. 상품명으로 고르는 경우

WING 상세조건 검색은 `주문번호 / 주문자명 / 수취인명`만 지원한다. **상품명 검색이 없으므로** 목록을 읽어서 직접 필터링해야 한다.

목록 테이블은 `document.querySelectorAll('table')[0]`, 컬럼 인덱스는 다음과 같다.

| idx | 내용 |
|-----|------|
| 1 | 주문번호 |
| 6 | 등록상품명/옵션/수량 |
| 9 | 배송상태 |
| 14 | **행별 `취소접수` 버튼** |

```js
// 현재 페이지의 상품별 건수 세기
const tb=document.querySelectorAll('table')[0];
[...tb.rows].slice(1).reduce((m,r)=>{
  const n=((r.cells[6]?.innerText||'').match(/등록상품명:\s*([^,]*)/)||[])[1]||'?';
  m[n]=(m[n]||0)+1; return m;
},{})
```

페이지 크기를 50으로 올려 페이지 수를 줄인다. React 컨트롤드 컴포넌트라 **native setter + change 이벤트**가 필요하다.

```js
const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.text==='50개씩 보기'));
const setS=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
setS.call(s,'50'); s.dispatchEvent(new Event('change',{bubbles:true}));
```

### B. workspace DB에서 주문번호를 가져오는 경우

`orders` 테이블에서 대상 주문번호를 뽑아 배열로 만든 뒤, 루프의 매칭 조건을 상품명 대신 주문번호 집합으로 바꾼다.

```js
window.__targets = new Set(['27102273560837', '5102273628542', ...]);
// 루프 안에서: window.__targets.has(ord)
```

DB 조회는 `getServiceSupabaseClient()` 또는 `scripts/` 하위 mjs 스크립트로 처리하고, 결과를 위 배열로 넘긴다.

## 취소 루프 (검증된 방식)

**반드시 행별 `취소접수` 버튼(cells[14])을 쓴다.** 체크박스 + 상단 "취소/반품 접수" 방식은 쓰지 말 것 — 이유는 아래 함정 참고.

`references/cancel-loop.js`의 함수를 페이지에 등록하고 배치로 호출한다.

```js
await window.__run2(6)   // 6건씩. evaluate 30초 타임아웃 안에 들어온다
// → {i, ok, already, other, done}
```

페이지의 모든 행을 소진하면 `PAGE_END`가 나온다. 그때 다음 페이지로 넘기고 `window.__i=0`으로 리셋한다.

## 함정 (전부 실제로 겪은 것)

| 증상 | 원인 / 대응 |
|---|---|
| 같은 주문이 반복 처리됨 | 취소 접수해도 **목록에서 즉시 사라지지 않는다.** 행 인덱스(`__i`)로 순차 진행하고, 모달의 수량 입력란이 `disabled`면 이미 접수된 건이므로 건너뛴다 |
| "취소/반품 접수는 1건씩만 진행할 수 있습니다" | 체크박스 선택 상태가 **페이지를 넘겨도 내부 상태에 남는다.** DOM은 1개인데 화면은 "2 선택됨". 행별 버튼 방식이면 아예 안 생긴다 |
| 경고창이 수십 개 쌓임 | 위 경고를 안 닫고 루프를 계속 돌린 결과. 매 반복 시작에 `button.alert-action-button`을 전부 닫는다 |
| `window.__done` 이 undefined | 페이지 컨텍스트가 초기화됨. `localStorage`에 백업하고 매 건 저장한다 |
| 페이지 크기가 10으로 되돌아감 | 검색/페이지 이동 후 리셋된다. 매 페이지 진입 시 50인지 확인 |
| 모달 주문번호가 선택한 행과 다름 | 반드시 `모달 주문번호 === 행 주문번호`를 검증하고, 다르면 즉시 중단 |

## 취소 접수 모달 조작

```js
// 수량: 모달 테이블의 주문 수량을 그대로 (전량 취소)
const qty = dlg.querySelector('table').rows[2].cells[3].innerText.trim();
const setV=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
setV.call(inp, qty);
inp.dispatchEvent(new Event('input',{bubbles:true}));
inp.dispatchEvent(new Event('change',{bubbles:true}));

// 사유: 판매자사유(첫 라디오, 기본 선택됨) + select
// 선택 가능: 상품오출고 / 상품 누락 / 배송 지연 / 택배사 미발송 /
//           상품 파손 / 상품 불량 / 상품 품절 / 잘못된 가격 기재 /
//           잘못된 상품명 기재 / 잘못된 상품정보 기재
```

## 완료 검증

`검색` 버튼으로 목록을 재조회한 뒤 대상 상품이 **0건**인지 확인하고 스크린샷으로 보고한다.

취소 접수된 건은 처리 도중에는 목록에 남아 있다가 재조회 시점부터 빠지므로, **처음 센 건수와 실제 접수 횟수는 일치하지 않는 게 정상이다.** 최종 잔여 0건이 기준.
