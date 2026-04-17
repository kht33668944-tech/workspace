# Gemini API 사용량 추적 및 비용 대시보드 — Implementation Plan

> **For agentic workers:** This plan is structured as bite-sized tasks. The codebase does NOT have a test framework set up — verification is via `npx tsc --noEmit`, `npm run lint`, `npm run build`, and manual UI inspection. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정 페이지에 Gemini API 토큰 사용량/추정 비용을 자동 추적하여 표시한다.

**Architecture:** `lib/gemini.ts` 단일 지점에서 모든 호출 후 `gemini_usage` Supabase 테이블에 fire-and-forget INSERT. 단가는 `lib/gemini-pricing.ts` 상수로 관리. 대시보드는 `/api/gemini-usage/summary`를 호출해 월간/기능별/일별 집계를 표시.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Supabase (PostgreSQL + RLS), Tailwind CSS 4, Lucide React.

**Spec:** `docs/superpowers/specs/2026-04-17-gemini-usage-tracking-design.md`

---

## File Structure

| Path | 역할 | 신규/수정 |
|---|---|---|
| `supabase/migrations/gemini_usage.sql` | DB 테이블/RLS 정의 | 신규 |
| `lib/gemini-pricing.ts` | 모델별 단가 상수 + 비용 계산 함수 | 신규 |
| `lib/gemini.ts` | 모든 export 함수에 사용량 추적 주입 | 수정 |
| `app/api/gemini-usage/summary/route.ts` | 집계 API 엔드포인트 | 신규 |
| `components/workspace/settings/gemini-usage-dashboard.tsx` | 설정 페이지 카드 UI | 신규 |
| `app/workspace/settings/page.tsx` | 대시보드 카드 추가 | 수정 |

---

## Task 1: DB 마이그레이션 작성

**Files:**
- Create: `supabase/migrations/gemini_usage.sql`

- [ ] **Step 1: SQL 작성**

`supabase/migrations/gemini_usage.sql`:

```sql
-- Gemini API 호출 사용량 추적
create table if not exists public.gemini_usage (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  call_source text not null default 'unknown',
  model text not null,
  prompt_tokens int not null default 0,
  candidate_tokens int not null default 0,
  total_tokens int generated always as (prompt_tokens + candidate_tokens) stored,
  is_image boolean not null default false,
  image_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists gemini_usage_user_created_idx
  on public.gemini_usage (user_id, created_at desc);

create index if not exists gemini_usage_user_source_created_idx
  on public.gemini_usage (user_id, call_source, created_at desc);

alter table public.gemini_usage enable row level security;

-- 본인 행만 SELECT
drop policy if exists "gemini_usage_select" on public.gemini_usage;
create policy "gemini_usage_select" on public.gemini_usage
  for select to authenticated using (auth.uid() = user_id);

-- INSERT는 service_role만 (서버 코드에서 기록)
-- service_role은 RLS를 자동 우회하므로 별도 정책 불필요
```

- [ ] **Step 2: Supabase 콘솔에서 마이그레이션 적용**

이 프로젝트는 자동 마이그레이션 도구를 사용하지 않으므로, 사용자가 직접 Supabase Dashboard SQL Editor에서 위 SQL을 실행해야 한다.

**사용자에게 안내할 메시지:**
> Supabase 콘솔(`https://supabase.com/dashboard/project/ygunjfbtyowsumtxkukr/sql/new`)에서 `supabase/migrations/gemini_usage.sql` 내용을 복붙하여 실행해주세요.

- [ ] **Step 3: 커밋 (사용자 승인 후)**

```bash
git add supabase/migrations/gemini_usage.sql
git commit -m "feat: Gemini API 사용량 추적 테이블 추가"
```

---

## Task 2: 단가 모듈 작성

**Files:**
- Create: `lib/gemini-pricing.ts`

- [ ] **Step 1: 단가 상수 + 계산 함수 작성**

`lib/gemini-pricing.ts`:

```ts
/**
 * Gemini API 공식 단가 (2026년 4월 기준)
 * 출처: https://ai.google.dev/gemini-api/docs/pricing
 *
 * 단가 변경 시 이 파일만 수정하면 됨 (DB에는 토큰 수만 저장).
 */

export interface ModelPrice {
  inputPerMillion: number;   // USD per 1M input tokens
  outputPerMillion: number;  // USD per 1M output tokens
  perImage?: number;         // USD per generated image (optional)
}

export const GEMINI_PRICING: Record<string, ModelPrice> = {
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

export const FALLBACK_MODEL = "gemini-2.5-flash";
export const USD_TO_KRW = 1380;

export function getModelPrice(model: string): ModelPrice {
  return GEMINI_PRICING[model] ?? GEMINI_PRICING[FALLBACK_MODEL];
}

export function calcCostUsd(params: {
  model: string;
  promptTokens: number;
  candidateTokens: number;
  imageCount?: number;
}): number {
  const p = getModelPrice(params.model);
  const text =
    (params.promptTokens * p.inputPerMillion +
      params.candidateTokens * p.outputPerMillion) /
    1_000_000;
  const image = (params.imageCount ?? 0) * (p.perImage ?? 0);
  return text + image;
}

export function usdToKrw(usd: number): number {
  return Math.round(usd * USD_TO_KRW);
}
```

- [ ] **Step 2: 타입 체크**

```bash
npx tsc --noEmit
```

Expected: 에러 없음.

---

## Task 3: lib/gemini.ts에 사용량 추적 주입

**Files:**
- Modify: `lib/gemini.ts`

- [ ] **Step 1: import 추가 + recordUsage 헬퍼 작성**

`lib/gemini.ts` 상단(import 블록) 수정 — 기존:

```ts
import { GoogleGenerativeAI, type GenerateContentResult, type Part } from "@google/generative-ai";
import { COUPANG_OPTION_IDS, getCoupangCategoryByCode, buildCategoryListForPrompt, type CoupangRequiredOption } from "./coupang-category-options";
```

다음으로 변경:

```ts
import { GoogleGenerativeAI, type GenerateContentResult, type Part } from "@google/generative-ai";
import { COUPANG_OPTION_IDS, getCoupangCategoryByCode, buildCategoryListForPrompt, type CoupangRequiredOption } from "./coupang-category-options";
import { getServiceSupabaseClient } from "./api-helpers";

// ── 사용량 추적 옵션 ──────────────────────────────────────────────────────────
export interface GeminiCallOptions {
  /** 호출처 식별 태그 (예: "product_name_normalize", "thumbnail_gen") */
  callSource?: string;
  /** 호출한 사용자 ID (RLS용) */
  userId?: string;
  /** 모델 오버라이드 */
  modelOverride?: string;
}

/**
 * Gemini 호출 결과를 Supabase에 비동기 기록 (fire-and-forget)
 * 실패는 로그만 남기고 본 작업에 영향 없음
 */
function recordUsage(params: {
  callSource?: string;
  userId?: string;
  model: string;
  result?: GenerateContentResult;
  imageCount?: number;
  isImage?: boolean;
}): void {
  // fire-and-forget — await 하지 않음
  void (async () => {
    try {
      const usage = params.result?.response.usageMetadata;
      const supabase = getServiceSupabaseClient();
      await supabase.from("gemini_usage").insert({
        user_id: params.userId ?? null,
        call_source: params.callSource ?? "unknown",
        model: params.model,
        prompt_tokens: usage?.promptTokenCount ?? 0,
        candidate_tokens: usage?.candidatesTokenCount ?? 0,
        is_image: params.isImage ?? false,
        image_count: params.imageCount ?? 0,
      });
    } catch (e) {
      console.error("[gemini-usage]", e instanceof Error ? e.message : String(e));
    }
  })();
}

function resolveModelName(modelOverride?: string): string {
  return modelOverride ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
}
```

- [ ] **Step 2: `generateText` 시그니처 변경 + 추적 추가**

`lib/gemini.ts:96-109` 기존:

```ts
export async function generateText(
  prompt: string,
  modelOverride?: string
): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const model = getModel(modelOverride);
    const result = await model.generateContent(prompt);
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] generateText 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

다음으로 변경 (하위 호환을 위해 두 번째 인자가 string이면 기존 modelOverride로 처리):

```ts
export async function generateText(
  prompt: string,
  optionsOrModel?: GeminiCallOptions | string
): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const options: GeminiCallOptions =
    typeof optionsOrModel === "string"
      ? { modelOverride: optionsOrModel }
      : (optionsOrModel ?? {});
  const modelName = resolveModelName(options.modelOverride);
  try {
    const model = getModel(options.modelOverride);
    const result = await model.generateContent(prompt);
    recordUsage({
      callSource: options.callSource,
      userId: options.userId,
      model: modelName,
      result,
    });
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] generateText 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

- [ ] **Step 3: `generateContent` 시그니처 변경 + 추적 추가**

`lib/gemini.ts:115-128` 기존:

```ts
export async function generateContent(
  prompt: string,
  modelOverride?: string
): Promise<GeminiResponse | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const model = getModel(modelOverride);
    const result = await model.generateContent(prompt);
    return parseResponse(result);
  } catch (e) {
    console.warn("[gemini] generateContent 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

다음으로 변경:

```ts
export async function generateContent(
  prompt: string,
  optionsOrModel?: GeminiCallOptions | string
): Promise<GeminiResponse | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const options: GeminiCallOptions =
    typeof optionsOrModel === "string"
      ? { modelOverride: optionsOrModel }
      : (optionsOrModel ?? {});
  const modelName = resolveModelName(options.modelOverride);
  try {
    const model = getModel(options.modelOverride);
    const result = await model.generateContent(prompt);
    const parsed = parseResponse(result);
    recordUsage({
      callSource: options.callSource,
      userId: options.userId,
      model: modelName,
      result,
      imageCount: parsed.images.length,
      isImage: parsed.images.length > 0,
    });
    return parsed;
  } catch (e) {
    console.warn("[gemini] generateContent 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

- [ ] **Step 4: `analyzeImageFromUrl` 시그니처 변경 + 추적 추가**

`lib/gemini.ts:168-193` 기존:

```ts
export async function analyzeImageFromUrl(
  imageUrl: string,
  prompt: string,
  modelOverride?: string
): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];

    const model = getModel(modelOverride);
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      { text: prompt },
    ]);
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] analyzeImageFromUrl 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

다음으로 변경:

```ts
export async function analyzeImageFromUrl(
  imageUrl: string,
  prompt: string,
  optionsOrModel?: GeminiCallOptions | string
): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const options: GeminiCallOptions =
    typeof optionsOrModel === "string"
      ? { modelOverride: optionsOrModel }
      : (optionsOrModel ?? {});
  const modelName = resolveModelName(options.modelOverride);
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];

    const model = getModel(options.modelOverride);
    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType } },
      { text: prompt },
    ]);
    recordUsage({
      callSource: options.callSource,
      userId: options.userId,
      model: modelName,
      result,
    });
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] analyzeImageFromUrl 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

- [ ] **Step 5: `generateImageFromPrompt` 추적 추가**

`lib/gemini.ts:199-229` 기존 함수 시그니처는 유지하고 (`referenceImageBase64`, `mimeType` 파라미터가 있어 옵션 추가 위치 애매), 새 옵션 파라미터를 4번째에 추가:

```ts
export async function generateImageFromPrompt(
  prompt: string,
  referenceImageBase64?: string,
  mimeType = "image/jpeg",
  options?: GeminiCallOptions
): Promise<GeminiImageResult | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const IMAGE_GEN_MODEL =
    process.env.GEMINI_IMAGE_GEN_MODEL ?? "gemini-2.5-flash-image";
  try {
    const genAI = new (await import("@google/generative-ai")).GoogleGenerativeAI(
      process.env.GEMINI_API_KEY
    );
    const model = genAI.getGenerativeModel({
      model: IMAGE_GEN_MODEL,
      // @ts-expect-error: responseModalities is supported by this model
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    });

    const parts: Part[] = [{ text: prompt }];
    if (referenceImageBase64) {
      parts.unshift({ inlineData: { data: referenceImageBase64, mimeType } });
    }

    const result = await model.generateContent(parts);
    const parsed = parseResponse(result);
    recordUsage({
      callSource: options?.callSource,
      userId: options?.userId,
      model: IMAGE_GEN_MODEL,
      result,
      isImage: true,
      imageCount: parsed.images.length,
    });
    return parsed.images[0] ?? null;
  } catch (e) {
    console.warn("[gemini] generateImageFromPrompt 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

- [ ] **Step 6: `groundedSearch` 시그니처 변경 + 추적 추가**

`lib/gemini.ts:235-252` 기존:

```ts
export async function groundedSearch(prompt: string): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const genAI = new (await import("@google/generative-ai")).GoogleGenerativeAI(
      process.env.GEMINI_API_KEY
    );
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL ?? DEFAULT_MODEL,
      // @ts-expect-error: googleSearch tool supported
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent(prompt);
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] groundedSearch 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

다음으로 변경:

```ts
export async function groundedSearch(
  prompt: string,
  options?: GeminiCallOptions
): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const modelName = resolveModelName(options?.modelOverride);
  try {
    const genAI = new (await import("@google/generative-ai")).GoogleGenerativeAI(
      process.env.GEMINI_API_KEY
    );
    const model = genAI.getGenerativeModel({
      model: modelName,
      // @ts-expect-error: googleSearch tool supported
      tools: [{ googleSearch: {} }],
    });
    const result = await model.generateContent(prompt);
    recordUsage({
      callSource: options?.callSource,
      userId: options?.userId,
      model: modelName,
      result,
    });
    return parseResponse(result).text || null;
  } catch (e) {
    console.warn("[gemini] groundedSearch 실패:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
```

- [ ] **Step 7: 타입 체크**

```bash
npx tsc --noEmit
```

Expected: 에러 없음.

`classifyCategory`, `normalizeProductName`, `extractProductMetadataBatch`, `extractUnitPriceInfo`, `suggestPlayautoCategories`, `suggestSmartStoreCategoryCodes`, `extractCoupangPurchaseOptions`는 내부적으로 `generateText`를 호출하므로 자동으로 추적된다 (callSource 미지정 시 "unknown"). 점진 마이그레이션은 별도 후속 작업.

---

## Task 4: 집계 API 작성

**Files:**
- Create: `app/api/gemini-usage/summary/route.ts`

- [ ] **Step 1: API 라우트 작성**

`app/api/gemini-usage/summary/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { calcCostUsd, usdToKrw, FALLBACK_MODEL } from "@/lib/gemini-pricing";

export const revalidate = 60;

interface UsageRow {
  call_source: string;
  model: string;
  prompt_tokens: number;
  candidate_tokens: number;
  is_image: boolean;
  image_count: number;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const supabase = getSupabaseClient(token);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 이번 달 전체 행 조회 (사용자 ID는 RLS에서 자동 필터)
    const { data: rows, error } = await supabase
      .from("gemini_usage")
      .select("call_source, model, prompt_tokens, candidate_tokens, is_image, image_count, created_at")
      .gte("created_at", monthStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(50000);

    if (error) {
      console.error("[gemini-usage-summary]", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const list: UsageRow[] = (rows ?? []) as UsageRow[];

    // 1) 월간 합계
    let totalPromptTokens = 0;
    let totalCandidateTokens = 0;
    let totalImageCount = 0;
    let monthCostUsd = 0;
    for (const r of list) {
      totalPromptTokens += r.prompt_tokens;
      totalCandidateTokens += r.candidate_tokens;
      totalImageCount += r.image_count;
      monthCostUsd += calcCostUsd({
        model: r.model || FALLBACK_MODEL,
        promptTokens: r.prompt_tokens,
        candidateTokens: r.candidate_tokens,
        imageCount: r.image_count,
      });
    }

    // 2) 기능별 집계
    const sourceMap = new Map<string, {
      promptTokens: number;
      candidateTokens: number;
      imageCount: number;
      costUsd: number;
    }>();
    for (const r of list) {
      const key = r.call_source || "unknown";
      const acc = sourceMap.get(key) ?? {
        promptTokens: 0,
        candidateTokens: 0,
        imageCount: 0,
        costUsd: 0,
      };
      acc.promptTokens += r.prompt_tokens;
      acc.candidateTokens += r.candidate_tokens;
      acc.imageCount += r.image_count;
      acc.costUsd += calcCostUsd({
        model: r.model || FALLBACK_MODEL,
        promptTokens: r.prompt_tokens,
        candidateTokens: r.candidate_tokens,
        imageCount: r.image_count,
      });
      sourceMap.set(key, acc);
    }
    const bySource = Array.from(sourceMap.entries())
      .map(([callSource, v]) => ({
        callSource,
        promptTokens: v.promptTokens,
        candidateTokens: v.candidateTokens,
        imageCount: v.imageCount,
        costUsd: Number(v.costUsd.toFixed(4)),
        costKrw: usdToKrw(v.costUsd),
      }))
      .sort((a, b) => b.costUsd - a.costUsd);

    // 3) 최근 7일 일별 (오늘 포함)
    const dayMap = new Map<string, number>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dayMap.set(d.toISOString().slice(0, 10), 0);
    }
    for (const r of list) {
      const created = new Date(r.created_at);
      if (created < sevenDaysAgo) continue;
      const key = created.toISOString().slice(0, 10);
      if (!dayMap.has(key)) continue;
      const cost = calcCostUsd({
        model: r.model || FALLBACK_MODEL,
        promptTokens: r.prompt_tokens,
        candidateTokens: r.candidate_tokens,
        imageCount: r.image_count,
      });
      dayMap.set(key, (dayMap.get(key) ?? 0) + cost);
    }
    const last7Days = Array.from(dayMap.entries())
      .map(([date, costUsd]) => ({ date, costKrw: usdToKrw(costUsd) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({
      month: {
        from: monthStart.toISOString().slice(0, 10),
        to: now.toISOString().slice(0, 10),
        totalPromptTokens,
        totalCandidateTokens,
        totalImageCount,
        estimatedCostUsd: Number(monthCostUsd.toFixed(4)),
        estimatedCostKrw: usdToKrw(monthCostUsd),
      },
      bySource,
      last7Days,
    });
  } catch (e) {
    console.error("[gemini-usage-summary]", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
}
```

- [ ] **Step 2: 타입 체크 + lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: 에러 없음.

---

## Task 5: 대시보드 컴포넌트 작성

**Files:**
- Create: `components/workspace/settings/gemini-usage-dashboard.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`components/workspace/settings/gemini-usage-dashboard.tsx`:

```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw, Sparkles, ExternalLink } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface SourceRow {
  callSource: string;
  promptTokens: number;
  candidateTokens: number;
  imageCount: number;
  costUsd: number;
  costKrw: number;
}

interface DaySummary {
  date: string;
  costKrw: number;
}

interface UsageSummary {
  month: {
    from: string;
    to: string;
    totalPromptTokens: number;
    totalCandidateTokens: number;
    totalImageCount: number;
    estimatedCostUsd: number;
    estimatedCostKrw: number;
  };
  bySource: SourceRow[];
  last7Days: DaySummary[];
}

const SOURCE_LABELS: Record<string, string> = {
  product_name_normalize: "상품명 정규화",
  thumbnail_gen: "썸네일 생성",
  detail_html: "상세페이지 생성",
  category_classify: "카테고리 분류",
  ohouse_purchase: "오늘의집 자동구매",
  unknown: "미분류",
};

function labelOf(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function formatNumber(n: number): string {
  return n.toLocaleString("ko-KR");
}

export default function GeminiUsageDashboard() {
  const { session } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gemini-usage/summary", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "조회 실패");
        setData(null);
      } else {
        const json = (await res.json()) as UsageSummary;
        setData(json);
      }
    } catch (e) {
      console.error("[gemini-usage-dashboard]", e instanceof Error ? e.message : String(e));
      setError("네트워크 오류");
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (expanded && !initialized) {
      fetchSummary();
    }
  }, [expanded, initialized, fetchSummary]);

  const maxSourceCost = data?.bySource.reduce((m, s) => Math.max(m, s.costKrw), 0) ?? 0;
  const max7DayCost = data?.last7Days.reduce((m, d) => Math.max(m, d.costKrw), 0) ?? 0;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 min-h-[44px] hover:bg-[var(--bg-subtle)] transition-colors rounded-2xl"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-emerald-400" />
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Gemini API 사용량</h2>
          <span className="text-xs text-[var(--text-muted)] ml-1">이번 달 토큰/예상 비용</span>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-[var(--text-muted)]" />
        ) : (
          <ChevronDown className="w-5 h-5 text-[var(--text-muted)]" />
        )}
      </button>

      {expanded && (
        <div className="px-6 pb-6 space-y-5 border-t border-[var(--border)] pt-5">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-[var(--text-muted)] animate-spin" />
            </div>
          )}

          {!loading && error && (
            <div className="text-xs text-red-400 py-4">
              {error}
              <button
                onClick={fetchSummary}
                className="ml-2 underline text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                다시 시도
              </button>
            </div>
          )}

          {!loading && !error && data && (
            <>
              {/* 1) 이번 달 예상 비용 */}
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">이번 달 예상 비용</div>
                <div className="flex items-baseline gap-3">
                  <span className="text-3xl font-bold text-[var(--text-primary)]">
                    ₩{formatNumber(data.month.estimatedCostKrw)}
                  </span>
                  <span className="text-sm text-[var(--text-muted)]">
                    ${data.month.estimatedCostUsd.toFixed(2)}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--text-disabled)] mt-1">
                  {data.month.from} ~ {data.month.to} · 환율 1,380원 가정 · 실제 청구액과 다를 수 있음
                </div>
              </div>

              {/* 2) 토큰 사용량 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-[var(--bg-hover)] rounded-lg p-3">
                  <div className="text-[11px] text-[var(--text-muted)]">입력 토큰</div>
                  <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">
                    {formatNumber(data.month.totalPromptTokens)}
                  </div>
                </div>
                <div className="bg-[var(--bg-hover)] rounded-lg p-3">
                  <div className="text-[11px] text-[var(--text-muted)]">출력 토큰</div>
                  <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">
                    {formatNumber(data.month.totalCandidateTokens)}
                  </div>
                </div>
                <div className="bg-[var(--bg-hover)] rounded-lg p-3">
                  <div className="text-[11px] text-[var(--text-muted)]">생성 이미지</div>
                  <div className="text-sm font-semibold text-[var(--text-primary)] mt-0.5">
                    {formatNumber(data.month.totalImageCount)}장
                  </div>
                </div>
              </div>

              {/* 3) 기능별 비용 */}
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-2">기능별 비용 (이번 달)</div>
                {data.bySource.length === 0 ? (
                  <div className="text-xs text-[var(--text-disabled)] py-3">
                    이번 달 사용 내역이 없습니다.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {data.bySource.map((s) => {
                      const pct = maxSourceCost > 0 ? (s.costKrw / maxSourceCost) * 100 : 0;
                      const totalPct = data.month.estimatedCostKrw > 0
                        ? Math.round((s.costKrw / data.month.estimatedCostKrw) * 100)
                        : 0;
                      return (
                        <div key={s.callSource} className="text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[var(--text-secondary)]">{labelOf(s.callSource)}</span>
                            <span className="text-[var(--text-muted)]">
                              ₩{formatNumber(s.costKrw)} <span className="text-[var(--text-disabled)]">({totalPct}%)</span>
                            </span>
                          </div>
                          <div className="h-1.5 bg-[var(--bg-hover)] rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-500/70"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 4) 최근 7일 추이 */}
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-2">최근 7일 추이</div>
                <div className="flex items-end gap-1 h-24">
                  {data.last7Days.map((d) => {
                    const h = max7DayCost > 0 ? (d.costKrw / max7DayCost) * 100 : 0;
                    return (
                      <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full flex-1 flex items-end">
                          <div
                            className="w-full bg-emerald-500/60 rounded-t"
                            style={{ height: `${Math.max(h, 2)}%` }}
                            title={`${d.date}: ₩${formatNumber(d.costKrw)}`}
                          />
                        </div>
                        <div className="text-[10px] text-[var(--text-disabled)]">
                          {d.date.slice(5)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 5) GCP 콘솔 링크 + 새로고침 */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--border)]">
                <a
                  href="https://console.cloud.google.com/billing"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 min-h-[36px] bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  GCP 콘솔에서 실제 청구액 확인
                </a>
                <a
                  href="https://console.cloud.google.com/billing/payment-methods"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 min-h-[36px] bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  결제 수단 관리
                </a>
                <button
                  onClick={fetchSummary}
                  disabled={loading}
                  className="ml-auto flex items-center gap-1.5 px-3 min-h-[36px] bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                  새로고침
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크**

```bash
npx tsc --noEmit
```

Expected: 에러 없음.

---

## Task 6: 설정 페이지에 카드 추가

**Files:**
- Modify: `app/workspace/settings/page.tsx`

- [ ] **Step 1: import + 카드 추가**

`app/workspace/settings/page.tsx` 전체를 다음으로 변경:

```tsx
"use client";

import CredentialManager from "@/components/workspace/settings/credential-manager";
import CourierCodeManager from "@/components/workspace/settings/courier-code-manager";
import GeminiUsageDashboard from "@/components/workspace/settings/gemini-usage-dashboard";

export default function SettingsPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[var(--text-primary)]">설정</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">구매처 계정 관리 및 환경 설정</p>
      </div>

      <CredentialManager />
      <CourierCodeManager />
      <GeminiUsageDashboard />
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크**

```bash
npx tsc --noEmit
```

Expected: 에러 없음.

---

## Task 7: 빌드 검증

- [ ] **Step 1: 전체 빌드**

```bash
npm run build
```

Expected: 빌드 성공, `app/api/gemini-usage/summary` 라우트가 컴파일 결과에 포함됨.

- [ ] **Step 2: lint 통과 확인**

```bash
npm run lint
```

Expected: 경고/에러 없음 (또는 기존 수준).

---

## Task 8: 커밋 (사용자 승인 후)

- [ ] **Step 1: 변경 파일 확인**

```bash
git status
git diff --stat
```

기대 변경 파일:
- `supabase/migrations/gemini_usage.sql` (신규)
- `lib/gemini-pricing.ts` (신규)
- `lib/gemini.ts` (수정)
- `app/api/gemini-usage/summary/route.ts` (신규)
- `components/workspace/settings/gemini-usage-dashboard.tsx` (신규)
- `app/workspace/settings/page.tsx` (수정)
- `docs/superpowers/specs/2026-04-17-gemini-usage-tracking-design.md` (신규)
- `docs/superpowers/plans/2026-04-17-gemini-usage-tracking.md` (신규)

- [ ] **Step 2: 커밋**

```bash
git add supabase/migrations/gemini_usage.sql \
        lib/gemini-pricing.ts \
        lib/gemini.ts \
        app/api/gemini-usage/summary/route.ts \
        components/workspace/settings/gemini-usage-dashboard.tsx \
        app/workspace/settings/page.tsx \
        docs/superpowers/specs/2026-04-17-gemini-usage-tracking-design.md \
        docs/superpowers/plans/2026-04-17-gemini-usage-tracking.md

git commit -m "$(cat <<'EOF'
feat: 설정 페이지에 Gemini API 사용량/비용 대시보드 추가

- gemini_usage 테이블 추가 (토큰/모델/호출처 추적)
- lib/gemini.ts 모든 호출에서 fire-and-forget 사용량 기록
- lib/gemini-pricing.ts 모델별 단가 + USD/KRW 변환
- /api/gemini-usage/summary 월간/기능별/일별 집계
- 설정 페이지 대시보드: 이번 달 예상 비용, 기능별 분포, 7일 추이, GCP 콘솔 딥링크

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ 데이터 모델 → Task 1
- ✅ 추적 주입 → Task 3
- ✅ 단가 모듈 → Task 2
- ✅ 대시보드 UI → Task 5, 6
- ✅ API Route → Task 4

**2. Placeholder scan:** TBD/TODO 없음. 모든 코드 블록은 실제 동작하는 코드.

**3. Type consistency:**
- `GeminiCallOptions` 인터페이스 (Task 3) — 모든 함수 시그니처에서 일관 사용
- `UsageSummary` (Task 5)와 API 응답 스키마 (Task 4) 필드명 일치 확인됨
- `calcCostUsd`, `usdToKrw`, `FALLBACK_MODEL` (Task 2) — Task 4에서 동일 이름으로 import

**4. 후속 작업 (이 계획 범위 외):**
- 각 Gemini 호출처에 `callSource` / `userId` 태그 추가 (점진 마이그레이션)
- 환율 자동 갱신
- 한도 알림

---

## 실행 방식

이 계획은 **인라인 실행**(현재 세션에서 순차 실행)을 권장한다 — 모든 task가 단일 feature로 묶여 있고 task 간 의존성이 강함.
