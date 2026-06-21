# 플랫폼 코드 관리 + 가격수정 내보내기 구현 계획

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 플레이오토 엑셀에서 쇼핑몰 상품번호를 가져와 DB에 저장하고, 가격수정용 엑셀 2종(일반/단일)을 내보내는 기능 구현

**Architecture:** products 테이블에 platform_codes JSON 컬럼 추가. 엑셀 업로드 시 상품명 매칭으로 코드 저장. 가격수정 내보내기는 일반상품(스마트스토어/쿠팡)과 단일상품(지마켓/옥션/11번가) 2개 엑셀로 분리 생성.

**Tech Stack:** Next.js API Routes, Supabase, xlsx-js-style, TypeScript

---

### Task 1: DB 스키마 + 타입 수정

**Files:**
- Modify: `types/database.ts:159-181`

- [ ] **Step 1: Product 인터페이스에 platform_codes 추가**

`types/database.ts`의 Product 인터페이스에 `platform_codes` 필드 추가:
```typescript
platform_codes: Record<string, string> | null; // {"옥션=redgoom00": "F445675075", ...}
```
`registration_status` 뒤에 추가.

- [ ] **Step 2: Supabase에 컬럼 추가**

Supabase 대시보드에서 products 테이블에 `platform_codes` 컬럼 추가 (jsonb, nullable, default null).

---

### Task 2: 플랫폼 코드 가져오기 API

**Files:**
- Create: `app/api/products/import-platform-codes/route.ts`

- [ ] **Step 1: API 라우트 생성**

POST 엔드포인트. 요청 body: `{ excelBase64: string }`.
처리 흐름:
1. JWT에서 사용자 인증
2. base64 → Buffer → XLSX 파싱
3. 헤더에서 `온라인 상품명`, `쇼핑몰(계정)`, `쇼핑몰 상품번호` 컬럼 찾기
4. 사용자의 products 전체 조회 → product_name으로 Map 생성
5. 엑셀 각 행: 상품명으로 매칭 → platform_codes에 {쇼핑몰(계정): 쇼핑몰 상품번호} 병합
6. DB 일괄 업데이트
7. 응답: { matched: number, unmatched: string[], total: number }

---

### Task 3: 가격수정 내보내기 API

**Files:**
- Create: `app/api/products/price-update-export/route.ts`
- Modify: `lib/excel-export.ts` (가격수정 엑셀 생성 함수 추가)

- [ ] **Step 1: excel-export.ts에 가격수정 엑셀 생성 함수 추가**

`generatePriceUpdateExcel` 함수 생성:
- 입력: products[], commissionRates[]
- 일반상품 엑셀 (스마트스토어, 쿠팡): platform_codes에서 해당 계정 코드 + calcPlatformPrice로 판매가
- 단일상품 엑셀 (옥션, 지마켓, 11번가): 동일 로직
- 각 엑셀 컬럼: `쇼핑몰 상품번호` | `판매가`
- 반환: { normal: {buffer, filename}, single: {buffer, filename} }

- [ ] **Step 2: API 라우트 생성**

POST 엔드포인트. 요청 body: `{ productIds: string[] }`.
처리: products + commission_rates 조회 → generatePriceUpdateExcel → base64 2개 반환.

---

### Task 4: 프론트엔드 UI

**Files:**
- Modify: `app/workspace/products/page.tsx`

- [ ] **Step 1: 플랫폼 코드 가져오기 버튼 + 모달**

"플랫폼 코드 가져오기" 버튼 (Upload 아이콘). 클릭 시 파일 input → 엑셀 선택 → base64 변환 → API 호출 → 결과 표시.

- [ ] **Step 2: 가격수정 내보내기 메뉴**

기존 플레이오토 내보내기 드롭다운에 구분선 + "가격수정 내보내기" 버튼 추가.
클릭 시 API 호출 → 일반/단일 2개 엑셀 동시 다운로드.
