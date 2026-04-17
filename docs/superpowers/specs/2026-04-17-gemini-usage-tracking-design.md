# Gemini API 사용량 추적 및 비용 대시보드

**작성일:** 2026-04-17
**상태:** 설계 승인 완료
**작성자:** brainstorming session

## 배경

프로젝트 전반에서 Gemini API를 다양한 기능(상품명 정규화, 썸네일 생성, 상세페이지 생성, 카테고리 분류, 오늘의집 자동구매 등)에 사용하고 있으나, 현재 사용량 추적이 전무하다. `lib/gemini.ts`에서 `usageMetadata`를 캡처하지 않아 어느 기능이 얼마나 토큰을 소비하는지 알 수 없다.

사용자는 설정 페이지에서 "이번 달 얼마를 쓰고 있는지" 직관적으로 확인하고 싶어 하며, GCP 콘솔로 직접 이동할 수 있는 링크도 원한다.

## 채택 방안: 자체 토큰 추적 + 단가 계산 (Option A)

GCP Billing 데이터는 본질적으로 24~48시간 지연이 있어 실시간 조회가 불가능하다. 따라서 자체적으로 토큰을 기록하고 공식 단가로 비용을 추정하는 방식을 채택한다.

**대안으로 검토했으나 채택하지 않은 방안:**
- Cloud Billing BigQuery Export — 인프라 복잡도 대비 가치 낮음
- 결제 버튼 직접 연동 — Google Cloud는 외부 앱에서 결제 트리거를 지원하지 않음

## 설계

### 1. 데이터 모델

**Supabase 테이블 `gemini_usage`:**

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | bigserial PK | |
| `user_id` | uuid (FK auth.users) | RLS용 |
| `call_source` | text | 호출처 태그 |
| `model` | text | `gemini-2.5-flash` 등 |
| `prompt_tokens` | int | `usageMetadata.promptTokenCount` |
| `candidate_tokens` | int | `usageMetadata.candidatesTokenCount` |
| `total_tokens` | int generated | `prompt_tokens + candidate_tokens` |
| `is_image` | boolean | 이미지 생성 호출 여부 |
| `image_count` | int default 0 | 생성된 이미지 수 |
| `created_at` | timestamptz default now() | |

**call_source 태그 예시:**
- `product_name_normalize` — 상품명 정규화
- `thumbnail_gen` — 썸네일 생성
- `detail_html` — 상세페이지 HTML 생성
- `category_classify` — 카테고리 분류
- `ohouse_purchase` — 오늘의집 자동구매 보조
- `unknown` — 태그 미지정 (점진 마이그레이션용)

**인덱스:**
- `(user_id, created_at desc)` — 최근 사용 내역 조회
- `(user_id, call_source, created_at)` — 기능별 집계

**RLS 정책:**
- SELECT: 본인 행만 (`auth.uid() = user_id`)
- INSERT: service_role만 허용 (서버 코드에서만 기록)

### 2. 추적 주입 위치

**위치:** `lib/gemini.ts` — 모든 Gemini 호출이 통과하는 단일 지점.

**구현 방식:**

```ts
async function recordUsage(params: {
  callSource: string;
  model: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  isImage?: boolean;
  imageCount?: number;
  userId?: string;
}) {
  try {
    const supabase = getServiceSupabaseClient();
    await supabase.from("gemini_usage").insert({
      user_id: params.userId ?? null,
      call_source: params.callSource ?? "unknown",
      model: params.model,
      prompt_tokens: params.usageMetadata?.promptTokenCount ?? 0,
      candidate_tokens: params.usageMetadata?.candidatesTokenCount ?? 0,
      is_image: params.isImage ?? false,
      image_count: params.imageCount ?? 0,
    });
  } catch (e) {
    console.error("[gemini-usage]", e instanceof Error ? e.message : String(e));
  }
}
```

**호출 시그니처 변경:**

기존 export 함수들에 선택 파라미터 `options?: { callSource?: string; userId?: string }`를 추가한다:

- `generateText(prompt, options?)`
- `analyzeImageFromUrl(url, prompt, options?)`
- `generateImageFromPrompt(prompt, options?)`
- `groundedSearch(query, options?)`
- `classifyCategory(...args, options?)`
- `normalizeProductName(...args, options?)`

`callSource`/`userId` 미지정 시 각각 `"unknown"`/`null`로 기록 — 점진 마이그레이션 가능.

**Fire-and-forget 정책:** Gemini 호출 자체가 1~10초 소요되므로 DB INSERT 대기는 추가하지 않는다. INSERT 실패는 로그로만 남기고 본 작업에 영향 없게 한다.

### 3. 단가 모듈

**신규 파일:** `lib/gemini-pricing.ts`

```ts
// 2026년 4월 기준 Gemini API 공식 단가 (USD per 1M tokens)
export const GEMINI_PRICING: Record<string, {
  inputPerMillion: number;
  outputPerMillion: number;
  perImage?: number;
}> = {
  "gemini-2.5-flash": {
    inputPerMillion: 0.30,
    outputPerMillion: 2.50,
  },
  "gemini-2.5-flash-lite": {
    inputPerMillion: 0.10,
    outputPerMillion: 0.40,
  },
  "gemini-2.5-pro": {
    inputPerMillion: 1.25,
    outputPerMillion: 10.00,
  },
  "gemini-2.5-flash-image": {
    inputPerMillion: 0.30,
    outputPerMillion: 2.50,
    perImage: 0.039,
  },
};

export const USD_TO_KRW = 1380; // 수동 갱신 (월 1회)

export function calcCostUsd(params: {
  model: string;
  promptTokens: number;
  candidateTokens: number;
  imageCount?: number;
}): number {
  const p = GEMINI_PRICING[params.model] ?? GEMINI_PRICING["gemini-2.5-flash"];
  const text = (params.promptTokens * p.inputPerMillion + params.candidateTokens * p.outputPerMillion) / 1_000_000;
  const image = (params.imageCount ?? 0) * (p.perImage ?? 0);
  return text + image;
}

export function usdToKrw(usd: number): number {
  return Math.round(usd * USD_TO_KRW);
}
```

**설계 결정:**
- DB에는 토큰 수만 저장. 비용은 조회 시 계산 → 단가 변경 시 마이그레이션 불필요
- 환율은 상수로 시작 (변동 ±1~2%, 비용 추정 정확도에 거의 무영향)
- 미등록 모델은 `gemini-2.5-flash` 단가로 fallback (보수적 추정)

### 4. 대시보드 UI

**신규 컴포넌트:** `components/workspace/settings/gemini-usage-dashboard.tsx`

설정 페이지(`app/workspace/settings/page.tsx`)에 `<GeminiUsageDashboard />` 카드 추가.

**표시 항목 (위→아래):**

1. **이번 달 예상 비용** — 큰 글씨, 원화 우선 + USD 보조 (예: `₩4,230 / $3.06`)
2. **기간 표시** (예: `2026-04-01 ~ 2026-04-17`)
3. **토큰 사용량** — 입력/출력 분리
4. **기능별 비용 분포** — 가로 막대 (call_source별 정렬, 비용 내림차순)
5. **최근 7일 추이** — 일별 막대 차트
6. **GCP 콘솔 딥링크 2개:**
   - 실제 청구액: `https://console.cloud.google.com/billing`
   - 결제 수단: `https://console.cloud.google.com/billing/payment-methods`
7. **새로고침 버튼** (수동, 자동 폴링 없음)

**기술 사항:**
- 클라이언트 컴포넌트 (`"use client"`)
- `useEffect` 마운트 시 `/api/gemini-usage/summary` 호출
- 차트는 외부 라이브러리 없이 div + width % 구현
- 데이터 없을 때 placeholder: "이번 달 사용 내역이 없습니다"
- 로딩 중 skeleton 표시

### 5. API Route

**신규 파일:** `app/api/gemini-usage/summary/route.ts`

**역할:** 대시보드가 호출하는 단일 집계 엔드포인트.

**응답 형태:**

```ts
GET /api/gemini-usage/summary

{
  "month": {
    "from": "2026-04-01",
    "to": "2026-04-17",
    "totalPromptTokens": 8420000,
    "totalCandidateTokens": 1205000,
    "totalImageCount": 12,
    "estimatedCostUsd": 3.06,
    "estimatedCostKrw": 4230
  },
  "bySource": [
    {
      "callSource": "product_name_normalize",
      "promptTokens": 5200000,
      "candidateTokens": 800000,
      "imageCount": 0,
      "costUsd": 1.30,
      "costKrw": 1800
    }
  ],
  "last7Days": [
    { "date": "2026-04-11", "costKrw": 320 }
  ]
}
```

**구현:**
- 인증: JWT에서 `userId` 추출 (`getSupabaseClient(token)` 사용 → RLS로 자기 데이터만 조회)
- 쿼리 3개 (병렬 실행):
  1. 이번 달 합계 (전체 SUM)
  2. 이번 달 기능별 합계 (group by `call_source`)
  3. 최근 7일 일별 합계 (group by `date_trunc('day', created_at)`)
- 비용 계산은 서버에서 (`lib/gemini-pricing.ts` 사용)
- 캐시: `revalidate = 60` (1분)

**에러 처리:**
- 인증 실패 → 401
- DB 에러 → 500 + `[gemini-usage-summary]` 접두어 로그

## 데이터 흐름

```
[Gemini API 호출]
    ↓
lib/gemini.ts (parseResponse + recordUsage)
    ↓ (fire-and-forget INSERT)
[Supabase: gemini_usage 테이블]
    ↑ (SELECT + 집계)
app/api/gemini-usage/summary
    ↑ (fetch)
components/workspace/settings/gemini-usage-dashboard.tsx
    ↑ (렌더)
[설정 페이지]
```

## 에러 처리 정책

| 시나리오 | 처리 |
|---|---|
| `usageMetadata` 누락 (Gemini 응답 이상) | 0으로 기록, 본 작업 정상 진행 |
| Supabase INSERT 실패 | 로그만 남기고 본 작업 정상 진행 |
| Supabase 다운 시 대시보드 호출 | 500 응답, UI에 "사용량 조회 실패" 표시 |
| 미등록 모델 호출 | `gemini-2.5-flash` 단가로 추정 |

## 마이그레이션 전략

1. 테이블 생성 + RLS 정책
2. `lib/gemini.ts`에 `recordUsage` 추가 (모든 함수에서 자동 호출, callSource는 "unknown")
3. 단가 모듈 + API route + 대시보드 컴포넌트 작성
4. 설정 페이지에 카드 노출
5. **이후 점진적으로** 각 호출처에 `callSource` 태그 추가 (한 번에 다 안 해도 됨)

## 향후 확장 고려사항

- 일/월 한도 알림 (예: "이번 달 ₩50,000 초과")
- CSV 다운로드 기능
- 환율 자동 갱신
- BigQuery Export 연동 (실제 청구액 비교용)

이런 항목은 현재 범위에서 제외 — 필요해지면 별도 설계.
