# 5,000+ 상품 성능 최적화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상품 5,000개 이상에서도 빠른 응답을 유지하도록 불필요한 네트워크 요청, 과도한 state 업데이트, 비효율적 비교 로직을 제거한다.

**Architecture:** (1) insertProducts/deleteProducts 후 전체 재패칭을 낙관적 업데이트로 교체, (2) SSE 수집 시 개별 setState를 배치로 묶어 리렌더 횟수 감소, (3) JSON.stringify 비교를 단순 키 비교로 교체.

**Tech Stack:** React 19, TypeScript, Next.js 16

---

## File Structure

| 작업 | 파일 | 역할 |
|------|------|------|
| Modify | `hooks/use-products.ts` | 낙관적 insert/delete, JSON.stringify 제거 |
| Modify | `app/workspace/products/page.tsx` | SSE 배치 업데이트 |

---

### Task 1: insertProducts 낙관적 업데이트

**Files:**
- Modify: `hooks/use-products.ts:146-159`

현재 `insertProducts`는 DB 삽입 후 `fetchProducts()`를 호출하여 5,000개 전체를 다시 로드한다. DB 삽입 결과를 로컬 state에 바로 추가하도록 변경.

- [ ] **Step 1: insertProducts 수정**

현재 코드:
```typescript
const insertProducts = async (rows: Omit<Product, "id" | "created_at" | "updated_at">[]) => {
  if (!user) return { error: "Not authenticated" };
  const withUserId = rows.map((row) => ({ ...row, user_id: user.id }));

  const BATCH_SIZE = 500;
  for (let i = 0; i < withUserId.length; i += BATCH_SIZE) {
    const batch = withUserId.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from("products").insert(batch);
    if (error) return { error: error.message };
  }

  await fetchProducts();
  return { error: null };
};
```

변경:
```typescript
const insertProducts = async (rows: Omit<Product, "id" | "created_at" | "updated_at">[]) => {
  if (!user) return { error: "Not authenticated" };
  const withUserId = rows.map((row) => ({ ...row, user_id: user.id }));

  const inserted: Product[] = [];
  const BATCH_SIZE = 500;
  for (let i = 0; i < withUserId.length; i += BATCH_SIZE) {
    const batch = withUserId.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase.from("products").insert(batch).select();
    if (error) return { error: error.message };
    if (data) inserted.push(...(data as Product[]));
  }

  setProducts((prev) => [...prev, ...inserted]);
  nextSortOrderRef.current += inserted.length;
  fetchGenRef.current++;
  return { error: null };
};
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

---

### Task 2: deleteProducts 낙관적 업데이트

**Files:**
- Modify: `hooks/use-products.ts:271-301`

현재 `deleteProducts`는 DB 삭제 후 `fetchProducts()`를 호출. 로컬 state에서 바로 제거하도록 변경.

- [ ] **Step 1: deleteProducts 수정**

현재 코드 끝부분:
```typescript
  // DB 레코드 삭제
  const BATCH_SIZE = 100;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from("products").delete().in("id", batch);
    if (error) return { error: error.message };
  }
  await fetchProducts();
  return { error: null };
```

변경:
```typescript
  // DB 레코드 삭제
  const BATCH_SIZE = 100;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from("products").delete().in("id", batch);
    if (error) return { error: error.message };
  }

  const idSet = new Set(ids);
  setProducts((prev) => prev.filter((p) => !idSet.has(p.id)));
  fetchGenRef.current++;
  return { error: null };
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

---

### Task 3: JSON.stringify 비교 제거

**Files:**
- Modify: `hooks/use-products.ts:113-116`

`JSON.stringify` 비교는 대규모 객체에서 느리다. 단순 키 수 + 값 비교로 교체.

- [ ] **Step 1: 비교 로직 수정**

현재:
```typescript
setPriceChanges(prev => {
  if (JSON.stringify(prev) === JSON.stringify(map)) return prev;
  return map;
});
```

변경:
```typescript
setPriceChanges(prev => {
  const prevKeys = Object.keys(prev);
  const mapKeys = Object.keys(map);
  if (prevKeys.length === mapKeys.length && mapKeys.every(k => prev[k] === map[k])) return prev;
  return map;
});
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

---

### Task 4: SSE 최저가 수집 배치 업데이트

**Files:**
- Modify: `app/workspace/products/page.tsx` (`handleScrapePrices` 함수)

현재 SSE 이벤트마다 `updateProduct()`를 호출하여 5,000개 상품 수집 시 5,000회 state 업데이트가 발생한다. 200ms 간격으로 모아서 한 번에 업데이트하도록 변경.

- [ ] **Step 1: handleScrapePrices SSE 처리 수정**

현재 progress 이벤트 처리:
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

변경: SSE 루프 시작 전에 배치 버퍼와 flush 함수를 선언하고, progress 이벤트에서 버퍼에 쌓은 뒤 200ms 디바운스로 flush한다.

SSE 루프 바로 전 (`const reader = ...` 앞)에 추가:
```typescript
const pendingUpdates: Array<{ id: string; price: number }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const flushUpdates = () => {
  if (pendingUpdates.length === 0) return;
  startBatchUndo?.();
  for (const u of pendingUpdates) {
    updateProduct(u.id, { lowest_price: u.price });
  }
  endBatchUndo?.();
  pendingUpdates.length = 0;
};
```

progress 이벤트 처리를 변경:
```typescript
if (event.type === "progress") {
  const priceText = event.price > 0
    ? event.price !== event.previous_price
      ? `${event.previous_price.toLocaleString()}→${event.price.toLocaleString()}원`
      : `${event.price.toLocaleString()}원 (변동없음)`
    : "실패";
  setScrapeProgress(`(${event.index}/${event.total}) ${event.name} → ${priceText}`);
  if (event.price > 0) {
    pendingUpdates.push({ id: event.id, price: event.price });
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushUpdates, 200);
  }
}
```

done/error 이벤트 앞에 남은 버퍼를 flush:
```typescript
} else if (event.type === "done") {
  flushUpdates();
  setScrapeProgress(`완료: ${event.updated}개 갱신, ${event.unchanged ?? 0}개 변동없음, ${event.failed}개 실패`);
} else if (event.type === "error") {
  flushUpdates();
  setScrapeProgress(`오류: ${event.message}`);
}
```

그리고 SSE 루프 후(finally 블록 앞)에도 flush 호출:
```typescript
// while loop 종료 후
flushUpdates();
```

참고: `startBatchUndo`와 `endBatchUndo`는 `useProducts`에서 가져와야 한다. 현재 `page.tsx`에서 이미 destructure하고 있으므로 사용 가능.

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

---

### Task 5: 최종 빌드 검증

- [ ] **Step 1: 타입 체크**

Run: `npx tsc --noEmit`

- [ ] **Step 2: 프로덕션 빌드**

Run: `npm run build`
