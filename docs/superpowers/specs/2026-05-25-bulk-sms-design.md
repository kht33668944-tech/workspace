# 단체문자(SMS) 발송 기능 설계

## 개요

발주서에서 주문건을 선택하여 솔라피(SOLAPI) API를 통해 단체 SMS/LMS를 발송하는 기능.
템플릿 기반으로 주문 데이터 변수를 자동 치환하여 개인화된 메시지를 대량 발송한다.

## 아키텍처

```
발주서 페이지 (체크박스 선택)
    ↓ 자동화 > "단체문자" 클릭
BulkSmsModal
    ├─ 수신자 목록 (중복번호 자동 제거)
    ├─ 발송번호 선택 (수령자번호 / 주문자번호)
    ├─ 템플릿 선택/관리 (CRUD)
    ├─ 미리보기 (변수 치환된 실제 메시지)
    └─ 발송
        ↓ POST /api/sms/send (SSE 스트리밍)
API Route
    ├─ 솔라피 REST API v4 (HMAC-SHA256 인증)
    ├─ 건별 진행 상황 스트리밍
    └─ sms_logs 테이블에 결과 저장
```

## 핵심 파일

| 파일 | 역할 |
|------|------|
| `components/workspace/orders/bulk-sms-modal.tsx` | 발송 모달 UI (수신자 목록, 템플릿 선택, 미리보기, 발송) |
| `lib/solapi.ts` | 솔라피 API 클라이언트 (HMAC 서명 + 메시지 발송) |
| `app/api/sms/send/route.ts` | 대량 발송 API (SSE 스트리밍) |
| `app/api/sms/templates/route.ts` | 템플릿 CRUD API |
| `types/database.ts` | SmsTemplate, SmsLog 타입 추가 |

## DB 스키마

### sms_templates

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PK) | |
| user_id | uuid (FK → auth.users) | RLS 적용 |
| name | text | 템플릿 이름 (예: "배송 안내") |
| content | text | 본문 (`{recipient_name}님 {product_name} 발송`) |
| is_default | boolean | 기본 템플릿 여부 |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### sms_logs

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PK) | |
| user_id | uuid (FK → auth.users) | RLS 적용 |
| batch_id | uuid | 한 번의 대량 발송을 묶는 ID |
| order_id | uuid (FK → orders, nullable) | 어떤 주문에 대한 발송인지 |
| phone | text | 발송 대상 번호 |
| message | text | 실제 발송된 메시지 내용 |
| status | text | `success` / `failed` |
| error_message | text (nullable) | 실패 시 에러 내용 |
| message_id | text (nullable) | 솔라피 응답 메시지 ID |
| created_at | timestamptz | |

## 솔라피 API 연동

### 환경변수

```
SOLAPI_API_KEY=...
SOLAPI_API_SECRET=...
SOLAPI_SENDER_PHONE=01012345678  # 솔라피에 등록된 발신번호
```

### 인증

HMAC-SHA256 서명 방식:
```
Authorization: HMAC-SHA256 apiKey={API_KEY}, date={ISO8601}, salt={random}, signature={HMAC(date+salt, API_SECRET)}
```

### 발송 엔드포인트

`POST https://api.solapi.com/messages/v4/send-many`

### 메시지 타입 자동 판별

- 90바이트 이하 → SMS (단문, ~20원)
- 90바이트 초과 → LMS (장문, ~50원)

### 발송 제한

- 한 번에 최대 1,000건
- 초과 시 배치 분할 처리

## 템플릿 변수

| 변수 | 설명 | Order 필드 |
|------|------|------------|
| `{recipient_name}` | 수취인명 | recipient_name |
| `{product_name}` | 상품명 | product_name |
| `{quantity}` | 수량 | quantity |
| `{marketplace}` | 판매처 | marketplace |
| `{courier}` | 택배사 | courier |
| `{tracking_no}` | 운송장번호 | tracking_no |
| `{order_date}` | 주문일시 | order_date |
| `{address}` | 주소 | address |
| `{delivery_memo}` | 배송메모 | delivery_memo |

## UI 설계 (BulkSmsModal)

### 진입

발주서 > 주문 체크 > 자동화 드롭다운 > "단체문자" 메뉴

### 모달 레이아웃

```
┌─────────────────────────────────────────────┐
│  단체문자 발송                            ✕  │
├─────────────────────────────────────────────┤
│  수신자: 5명 (중복번호 제거: 4명)            │
│  발송번호: ○ 수령자번호  ○ 주문자번호        │
├─────────────────────────────────────────────┤
│  템플릿: [배송 안내 ▾]  [+ 새 템플릿] [편집] │
│  ┌─────────────────────────────────────┐    │
│  │ {recipient_name}님 안녕하세요.       │    │
│  │ {product_name} 상품이 발송되었습니다.│    │
│  │ 택배사: {courier}                   │    │
│  │ 운송장: {tracking_no}              │    │
│  └─────────────────────────────────────┘    │
├─────────────────────────────────────────────┤
│  미리보기 (첫 번째 수신자 기준)              │
│  ┌─────────────────────────────────────┐    │
│  │ 안은구님 안녕하세요.                 │    │
│  │ 코카콜라 1 5L 12페트 상품이 발송...  │    │
│  │ 택배사: CJ대한통운                  │    │
│  │ 운송장: 1234567890                  │    │
│  └─────────────────────────────────────┘    │
│  SMS(42자) · 예상 비용: 약 80원 (4건×20원)   │
├─────────────────────────────────────────────┤
│              [발송하기 (4건)]                │
└─────────────────────────────────────────────┘
```

### 발송 중 상태

- 프로그레스 바 + 건별 성공/실패 카운트 실시간 표시 (SSE)
- 완료 후 결과 요약 (성공 N건, 실패 N건)

### 중복번호 처리

동일 번호가 여러 주문에 존재할 경우:
- 중복 번호 자동 감지 및 표시
- 주문별로 개별 발송 (같은 번호라도 상품이 다르면 각각 발송)

## SSE 스트리밍 이벤트

기존 프로젝트 패턴(자동구매/가격수집)을 따름:

| 이벤트 | 데이터 |
|--------|--------|
| `progress` | `{ current, total, phone, status }` |
| `done` | `{ success, failed, total }` |
| `error` | `{ message }` |

## CoolSMS/솔라피 가입 절차

1. https://solapi.com 가입
2. [발신번호 관리]에서 발신번호 등록 (본인인증 필요)
3. [개발/연동] → API Key 발급
4. `.env.local`에 환경변수 추가:
   ```
   SOLAPI_API_KEY=...
   SOLAPI_API_SECRET=...
   SOLAPI_SENDER_PHONE=01012345678
   ```
