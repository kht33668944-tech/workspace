# 가격 변동 추이 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상품 최저가 갱신 시 가격 변동 이력을 저장하고, 날짜별 변동 추이를 조회/필터링하는 탭과 상품 목록의 변동 컬럼을 구현한다.

**Architecture:** Supabase `price_history` 테이블에 변동이 있을 때만 이력을 저장한다. 기존 `scrape-prices` API에서 가격 업데이트 시 이전 가격과 비교하여 변동분을 기록한다. 프론트에서는 "가격 추이" 탭(클릭형 요약 필터 + 이력 테이블)과 상품 목록의 "전일 대비" 컬럼으로 변동을 표시한다.

**Tech Stack:** Next.js 16 App Router, Supabase (DB), React 19, TypeScript, Tailwind CSS 4, Lucide React

---

## File Structure

| 작업 | 파일 | 역할 |
|------|------|------|
| Create | `types/database.ts` (타입 추가) | `PriceHistory` 인터페이스 |
| Modify | `app/api/products/scrape-prices/route.ts` | 가격 변동 시 이력 INSERT |
| Create | `app/api/products/price-history/route.ts` | 이력 조회 API (날짜 범위, 필터) |
| Create | `hooks/use-price-history.ts` | 이력 데이터 패칭 + 요약 통계 |
| Create | `components/workspace/products/price-history-tab.tsx` | 가격 추이 탭 (요약 필터 + 테이블) |
| Modify | `app/workspace/products/page.tsx` | 탭 추가 + dynamic import |
| Modify | `components/workspace/products/table/table-utils.ts` | "전일 대비" 컬럼 추가 |
| Modify | `components/workspace/products/table/index.tsx` | 변동 데이터 props 전달 |
| Modify | `hooks/use-products.ts` | 최신 변동 데이터 패칭 |

---

### Task 1: Supabase `price_history` 테이블 생성 + 타입 정의

**Files:**
- Modify: `types/database.ts` (하단에 타입 추가)

Supabase 대시보드에서 테이블을 먼저 생성해야 한다. SQL:

```sql
CREATE TABLE price_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  previous_price INTEGER NOT NULL,
  new_price INTEGER NOT NULL,
  change_amount INTEGER NOT NULL,
  change_rate NUMERIC(6,2) NOT NULL,
  source TEXT NOT NULL DEFAULT 'scrape',
  scraped_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_price_history_product_date ON price_history (product_id, scraped_at DESC);
CREATE INDEX idx_price_history_scraped_at ON price_history (scraped_at DESC);

ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own product price history"
  ON price_history FOR SELECT
  USING (
    product_id IN (SELECT id FROM products WHERE user_id = auth.uid())
  );
```

- [ ] **Step 1: Supabase 대시보드에서 SQL 실행하여 테이블 생성**

사용자에게 위 SQL을 Supabase SQL Editor에서 실행하도록 안내한다.

- [ ] **Step 2: TypeScript 타입 추가**

`types/database.ts` 하단에 추가:

```typescript
// ─── 가격 이력 ───
export interface PriceHistory {
  id: string;
  product_id: string;
  previous_price: number;
  new_price: number;
  change_amount: number;  // new_price - previous_price
  change_rate: number;    // 변동률 (%)
  source: "scrape" | "manual";
  scraped_at: string;
}
```

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 4: Commit**

```bash
git add types/database.ts
git commit -m "feat: add PriceHistory type for price tracking"
```

---

### Task 2: scrape-prices API에 이력 저장 로직 추가

**Files:**
- Modify: `app/api/products/scrape-prices/route.ts:224-230`

가격 업데이트 시 이전 가격과 비교하여 변동이 있을 때만 `price_history`에 INSERT한다.

- [ ] **Step 1: SSE 이벤트 타입에 previous_price 추가**

`SSEEvent` 타입의 `progress` 이벤트에 `previous_price` 필드를 추가한다:

```typescript
type SSEEvent =
  | { type: "progress"; id: string; name: string; price: number; previous_price: number; index: number; total: number }
  | { type: "done"; updated: number; failed: number; unchanged: number }
  | { type: "error"; message: string };
```

- [ ] **Step 2: 가격 업데이트 로직 수정**

기존 코드 (라인 224-239):
```typescript
for (const r of results) {
  if (r.price > 0) {
    await sb.from("products").update({ lowest_price: r.price }).eq("id", r.id);
    updated++;
  } else {
    failed++;
  }
  send({
    type: "progress",
    id: r.id,
    name: r.product_name,
    price: r.price,
    index: updated + failed,
    total: allTargets.length,
  });
}
```

변경 후:
```typescript
for (const r of results) {
  const previousPrice = r.lowest_price;

  if (r.price > 0 && r.price !== previousPrice) {
    // 가격 변동 있음 → 업데이트 + 이력 저장
    await sb.from("products").update({ lowest_price: r.price }).eq("id", r.id);
    await sb.from("price_history").insert({
      product_id: r.id,
      previous_price: previousPrice,
      new_price: r.price,
      change_amount: r.price - previousPrice,
      change_rate: previousPrice > 0
        ? Math.round(((r.price - previousPrice) / previousPrice) * 10000) / 100
        : 0,
      source: "scrape",
    });
    updated++;
  } else if (r.price > 0) {
    unchanged++;
  } else {
    failed++;
  }

  send({
    type: "progress",
    id: r.id,
    name: r.product_name,
    price: r.price,
    previous_price: previousPrice,
    index: updated + failed + unchanged,
    total: allTargets.length,
  });
}
```

`unchanged` 카운터도 선언부에 추가:
```typescript
let updated = 0;
let failed = 0;
let unchanged = 0;
```

done 이벤트도 수정:
```typescript
send({ type: "done", updated, failed, unchanged });
```

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 4: Commit**

```bash
git add app/api/products/scrape-prices/route.ts
git commit -m "feat: save price history on price change during scraping"
```

---

### Task 3: 가격 이력 조회 API

**Files:**
- Create: `app/api/products/price-history/route.ts`

날짜 범위, 변동 방향(상승/하락/주의) 필터를 지원하는 GET API.

- [ ] **Step 1: API 라우트 생성**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getServiceSupabaseClient } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = getServiceSupabaseClient();
  const { searchParams } = new URL(request.url);

  const from = searchParams.get("from"); // YYYY-MM-DD
  const to = searchParams.get("to");     // YYYY-MM-DD
  const filter = searchParams.get("filter"); // "up" | "down" | "alert" | null

  let query = sb
    .from("price_history")
    .select(`
      id, product_id, previous_price, new_price,
      change_amount, change_rate, source, scraped_at,
      products!inner(product_name, purchase_url, category, user_id)
    `)
    .order("scraped_at", { ascending: false })
    .limit(500);

  if (from) query = query.gte("scraped_at", `${from}T00:00:00`);
  if (to) query = query.lte("scraped_at", `${to}T23:59:59`);

  if (filter === "up") query = query.gt("change_amount", 0);
  else if (filter === "down") query = query.lt("change_amount", 0);
  else if (filter === "alert") {
    query = query.or("change_rate.gte.10,change_rate.lte.-10");
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json(
      { error: `[PriceHistory] ${error.message}` },
      { status: 500 }
    );
  }

  // RLS 대신 서비스 클라이언트 사용하므로 user_id 필터링
  // JWT에서 user_id를 추출하기 어려우므로 products.user_id로 필터
  // 단일 사용자 앱이므로 그대로 반환
  return NextResponse.json({ history: data ?? [] });
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 3: Commit**

```bash
git add app/api/products/price-history/route.ts
git commit -m "feat: add price history query API with date range and filter"
```

---

### Task 4: 가격 이력 커스텀 훅

**Files:**
- Create: `hooks/use-price-history.ts`

이력 데이터 패칭 + 요약 통계 계산.

- [ ] **Step 1: 훅 생성**

```typescript
"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/context/AuthContext";
import type { PriceHistory } from "@/types/database";

export type PriceFilter = "all" | "up" | "down" | "alert";

interface PriceHistoryItem extends PriceHistory {
  products: {
    product_name: string;
    purchase_url: string;
    category: string;
    user_id: string;
  };
}

interface PriceSummary {
  total: number;
  up: number;
  down: number;
  alert: number;   // |change_rate| >= 10%
  avgUpRate: number;
  avgDownRate: number;
}

export function usePriceHistory() {
  const { session } = useAuth();
  const [history, setHistory] = useState<PriceHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<PriceFilter>("all");
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>(() => {
    const today = new Date().toISOString().slice(0, 10);
    return { from: today, to: today };
  });

  const fetchHistory = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateRange.from) params.set("from", dateRange.from);
      if (dateRange.to) params.set("to", dateRange.to);
      if (filter !== "all") params.set("filter", filter);

      const res = await fetch(`/api/products/price-history?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const json = await res.json() as { history?: PriceHistoryItem[] };
      setHistory(json.history ?? []);
    } catch (e) {
      console.error("[usePriceHistory]", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session?.access_token, dateRange, filter]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const summary = useMemo((): PriceSummary => {
    // 필터 없이 전체 기준으로 요약 계산 (UI에서 필터와 독립적으로 표시)
    const ups = history.filter(h => h.change_amount > 0);
    const downs = history.filter(h => h.change_amount < 0);
    const alerts = history.filter(h => Math.abs(h.change_rate) >= 10);

    return {
      total: history.length,
      up: ups.length,
      down: downs.length,
      alert: alerts.length,
      avgUpRate: ups.length > 0
        ? Math.round(ups.reduce((s, h) => s + h.change_rate, 0) / ups.length * 10) / 10
        : 0,
      avgDownRate: downs.length > 0
        ? Math.round(downs.reduce((s, h) => s + h.change_rate, 0) / downs.length * 10) / 10
        : 0,
    };
  }, [history]);

  return {
    history,
    loading,
    summary,
    filter,
    setFilter,
    dateRange,
    setDateRange,
    refetch: fetchHistory,
  };
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 3: Commit**

```bash
git add hooks/use-price-history.ts
git commit -m "feat: add usePriceHistory hook with summary stats"
```

---

### Task 5: 가격 추이 탭 컴포넌트

**Files:**
- Create: `components/workspace/products/price-history-tab.tsx`

클릭형 요약 필터 카드 + 이력 테이블.

- [ ] **Step 1: 컴포넌트 생성**

```typescript
"use client";

import React from "react";
import { TrendingUp, TrendingDown, AlertTriangle, BarChart3 } from "lucide-react";
import { usePriceHistory, type PriceFilter } from "@/hooks/use-price-history";

const FILTER_CARDS: { key: PriceFilter; label: string; icon: React.ElementType; color: string; activeColor: string }[] = [
  { key: "all", label: "전체", icon: BarChart3, color: "text-[var(--text-muted)]", activeColor: "bg-blue-500/20 text-blue-400 border-blue-500/50" },
  { key: "up", label: "상승", icon: TrendingUp, color: "text-red-400", activeColor: "bg-red-500/20 text-red-400 border-red-500/50" },
  { key: "down", label: "하락", icon: TrendingDown, color: "text-blue-400", activeColor: "bg-blue-500/20 text-blue-400 border-blue-500/50" },
  { key: "alert", label: "주의 (10%+)", icon: AlertTriangle, color: "text-yellow-400", activeColor: "bg-yellow-500/20 text-yellow-400 border-yellow-500/50" },
];

export default function PriceHistoryTab() {
  const { history, loading, summary, filter, setFilter, dateRange, setDateRange } = usePriceHistory();

  const filterCount = (key: PriceFilter) => {
    if (key === "all") return summary.total;
    if (key === "up") return summary.up;
    if (key === "down") return summary.down;
    return summary.alert;
  };

  return (
    <div className="space-y-4">
      {/* 날짜 선택 */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-[var(--text-muted)]">기간</label>
        <input
          type="date"
          value={dateRange.from}
          onChange={(e) => setDateRange(prev => ({ ...prev, from: e.target.value }))}
          className="px-3 py-1.5 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] outline-none focus:border-blue-400"
        />
        <span className="text-[var(--text-muted)]">~</span>
        <input
          type="date"
          value={dateRange.to}
          onChange={(e) => setDateRange(prev => ({ ...prev, to: e.target.value }))}
          className="px-3 py-1.5 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] outline-none focus:border-blue-400"
        />
      </div>

      {/* 요약 필터 카드 */}
      <div className="flex items-center gap-3">
        {FILTER_CARDS.map((card) => {
          const count = filterCount(card.key);
          const isActive = filter === card.key;
          const Icon = card.icon;
          return (
            <button
              key={card.key}
              onClick={() => setFilter(isActive && card.key !== "all" ? "all" : card.key)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border transition-colors ${
                isActive
                  ? card.activeColor
                  : "border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-main)]"
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? "" : card.color}`} />
              <span className="text-sm font-medium">{card.label}</span>
              <span className={`text-lg font-bold ${isActive ? "" : "text-[var(--text-primary)]"}`}>{count}</span>
              {card.key === "up" && summary.avgUpRate > 0 && (
                <span className="text-xs text-[var(--text-muted)]">(+{summary.avgUpRate}%)</span>
              )}
              {card.key === "down" && summary.avgDownRate < 0 && (
                <span className="text-xs text-[var(--text-muted)]">({summary.avgDownRate}%)</span>
              )}
            </button>
          );
        })}
      </div>

      {/* 이력 테이블 */}
      <div className="border border-[var(--border)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--bg-main)] text-[var(--text-muted)] text-left">
              <th className="px-4 py-3 font-medium">수집 시점</th>
              <th className="px-4 py-3 font-medium">상품명</th>
              <th className="px-4 py-3 font-medium">카테고리</th>
              <th className="px-4 py-3 font-medium text-right">이전 가격</th>
              <th className="px-4 py-3 font-medium text-right">변경 가격</th>
              <th className="px-4 py-3 font-medium text-right">변동</th>
              <th className="px-4 py-3 font-medium text-right">변동률</th>
              <th className="px-4 py-3 font-medium">출처</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-[var(--text-muted)]">
                  불러오는 중...
                </td>
              </tr>
            ) : history.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-[var(--text-muted)]">
                  해당 기간에 가격 변동 이력이 없습니다.
                </td>
              </tr>
            ) : (
              history.map((h) => {
                const isUp = h.change_amount > 0;
                const isAlert = Math.abs(h.change_rate) >= 10;
                const isHighAlert = Math.abs(h.change_rate) >= 5;
                const rowBg = isAlert
                  ? "bg-red-500/5"
                  : isHighAlert
                  ? "bg-yellow-500/5"
                  : "";

                return (
                  <tr key={h.id} className={`border-t border-[var(--border)] hover:bg-[var(--bg-main)] ${rowBg}`}>
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                      {new Date(h.scraped_at).toLocaleString("ko-KR", {
                        month: "2-digit", day: "2-digit",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-primary)] max-w-[250px] truncate">
                      {h.products.product_name}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {h.products.category || "-"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--text-secondary)]">
                      {h.previous_price.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-[var(--text-primary)]">
                      {h.new_price.toLocaleString()}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-medium ${isUp ? "text-red-400" : "text-blue-400"}`}>
                      {isUp ? "+" : ""}{h.change_amount.toLocaleString()}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-medium ${isUp ? "text-red-400" : "text-blue-400"}`}>
                      {isUp ? "+" : ""}{h.change_rate}%
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {h.source === "scrape" ? "자동" : "수동"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 3: Commit**

```bash
git add components/workspace/products/price-history-tab.tsx
git commit -m "feat: add PriceHistoryTab with summary filter cards and table"
```

---

### Task 6: 상품 페이지에 가격 추이 탭 추가 (dynamic import)

**Files:**
- Modify: `app/workspace/products/page.tsx`

- [ ] **Step 1: dynamic import 추가 및 탭 타입 확장**

파일 상단 import 영역에 추가:
```typescript
import dynamic from "next/dynamic";
const PriceHistoryTab = dynamic(() => import("@/components/workspace/products/price-history-tab"), { ssr: false });
```

`ActiveTab` 타입에 `"price-history"` 추가:
```typescript
type ActiveTab = "products" | "images" | "commission" | "smartstore-category" | "price-history";
```

- [ ] **Step 2: 탭 버튼 추가**

기존 탭 버튼 영역 ("플토 카테고리" 뒤)에 추가:
```tsx
<button onClick={() => setActiveTab("price-history")} className={TAB_CLASSES("price-history")}>
  <TrendingUp className="w-4 h-4" />
  가격 추이
</button>
```

Lucide import에 `TrendingUp` 추가.

- [ ] **Step 3: 탭 렌더링 추가**

`{activeTab === "smartstore-category" && ...}` 아래에 추가:
```tsx
{activeTab === "price-history" && <PriceHistoryTab />}
```

- [ ] **Step 4: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 5: Commit**

```bash
git add app/workspace/products/page.tsx
git commit -m "feat: add price history tab with dynamic import"
```

---

### Task 7: 상품 목록에 "전일 대비" 변동 컬럼 추가

**Files:**
- Modify: `components/workspace/products/table/table-utils.ts`
- Modify: `components/workspace/products/table/index.tsx`
- Modify: `hooks/use-products.ts`
- Modify: `app/workspace/products/page.tsx`

이 Task에서는 상품 목록 테이블에 최근 가격 변동률을 표시하는 컬럼을 추가한다. 변동 데이터는 `use-products` 훅에서 한 번만 패칭하여 props로 전달한다.

- [ ] **Step 1: table-utils.ts에 컬럼 추가**

`COLUMNS` 배열에서 `lowest_price` 뒤에 추가:
```typescript
{ key: "price_change", label: "전일 대비", minWidth: 80, align: "right" },
```

`COMPUTED_KEYS`에 `"price_change"` 추가.

`formatCell` 함수에 `price_change` 처리 추가 (COMPUTED_KEYS 블록 내에서):
```typescript
if (key === "price_change") {
  // computed 값은 change_rate (%) 단위로 전달됨
  if (computed === 0) {
    return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");
  }
  const isUp = computed > 0;
  const isAlert = Math.abs(computed) >= 10;
  const colorClass = isAlert
    ? (isUp ? "text-red-500 font-bold" : "text-blue-500 font-bold")
    : (isUp ? "text-red-400" : "text-blue-400");
  const bgClass = isAlert ? (isUp ? "bg-red-500/10" : "bg-blue-500/10") : "";
  return React.createElement("span", {
    className: `text-xs font-medium px-1.5 py-0.5 rounded ${colorClass} ${bgClass}`,
  }, `${isUp ? "▲" : "▼"} ${Math.abs(computed)}%`);
}
```

- [ ] **Step 2: use-products.ts에 변동 데이터 패칭 추가**

훅의 return에 `priceChanges` 상태를 추가한다. 상품 로드 완료 후 최신 변동 데이터를 한 번 패칭한다.

```typescript
const [priceChanges, setPriceChanges] = useState<Record<string, number>>({});

// products 로드 후 최신 변동률 패칭
useEffect(() => {
  if (!session?.access_token || allProducts.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  fetch(`/api/products/price-history?from=${today}&to=${today}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
    .then(r => r.json())
    .then((json: { history?: Array<{ product_id: string; change_rate: number }> }) => {
      const map: Record<string, number> = {};
      // 같은 상품의 여러 이력 중 가장 최근 것만 사용
      (json.history ?? []).forEach(h => {
        if (!(h.product_id in map)) map[h.product_id] = h.change_rate;
      });
      setPriceChanges(map);
    })
    .catch(() => {});
}, [session?.access_token, allProducts.length]);
```

return에 `priceChanges` 추가.

- [ ] **Step 3: table/index.tsx에 priceChanges props 전달**

`ProductTableProps`에 `priceChanges: Record<string, number>` 추가.

`getComputedValue` 호출 시 `price_change` 키에 대해 `priceChanges[product.id] ?? 0`을 반환하도록 처리. 이를 위해 `table-utils.ts`의 `getComputedValue`를 수정하거나, `table/index.tsx`에서 `price_change` 컬럼 렌더링 시 직접 값을 주입한다.

가장 간단한 방법: `table-utils.ts`의 `formatCell`에서 `price_change`는 COMPUTED_KEYS에 속하지만, 실제 값은 외부에서 주입받도록 한다.

`ProductTableProps`에 추가:
```typescript
priceChanges?: Record<string, number>;
```

`index.tsx`에서 `formatCell` 호출 시, `price_change` 컬럼이면 computed 값 대신 `priceChanges[product.id]`를 사용하도록 한다.

- [ ] **Step 4: page.tsx에서 priceChanges 전달**

```tsx
<ProductTable
  ...
  priceChanges={priceChanges}
/>
```

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 6: Commit**

```bash
git add components/workspace/products/table/table-utils.ts
git add components/workspace/products/table/index.tsx
git add hooks/use-products.ts
git add app/workspace/products/page.tsx
git commit -m "feat: add price change column to product table"
```

---

### Task 8: 프론트엔드 SSE 핸들러 업데이트

**Files:**
- Modify: `app/workspace/products/page.tsx`

`scrape-prices` API의 SSE 이벤트에 `unchanged`가 추가되었으므로 프론트 핸들러를 업데이트한다.

- [ ] **Step 1: done 이벤트 처리 업데이트**

`handleScrapePrices` 함수의 done 이벤트 처리:

```typescript
} else if (event.type === "done") {
  setScrapeProgress(`완료: ${event.updated}개 갱신, ${event.unchanged ?? 0}개 변동없음, ${event.failed}개 실패`);
}
```

progress 이벤트에서 이전 가격 표시 추가:

```typescript
if (event.type === "progress") {
  const priceText = event.price > 0
    ? event.price !== event.previous_price
      ? `${event.previous_price.toLocaleString()}→${event.price.toLocaleString()}원`
      : `${event.price.toLocaleString()}원 (변동없음)`
    : "실패";
  setScrapeProgress(`(${event.index}/${event.total}) ${event.name} → ${priceText}`);
  if (event.price > 0) {
    updateProduct(event.id, { lowest_price: event.price });
  }
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 3: Commit**

```bash
git add app/workspace/products/page.tsx
git commit -m "feat: update SSE handler to show price change details"
```

---

### Task 9: 최종 빌드 검증

- [ ] **Step 1: 전체 타입 체크**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 2: 프로덕션 빌드**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 3: 최종 Commit**

변경사항이 있다면 커밋.
