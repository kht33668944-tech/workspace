# 리셀 매니저 프로젝트

## 기술 스택
- Next.js 16 App Router (standalone 빌드)
- TypeScript (strict)
- Tailwind CSS 4
- Supabase (DB, Auth, 세션 저장)
- Playwright (스크래핑, headless Chromium)
- Tesseract.js (CAPTCHA OCR — `eng.traineddata` 루트에 필요)

## 배포 환경
- **Railway** (Docker, asia-southeast1) — git push → 자동 배포
- **Supabase** (ap-northeast-2 서울) — project ID: `ygunjfbtyowsumtxkukr`
- URL: https://resell-manager-production.up.railway.app

## 환경변수
| 변수명 | 설명 |
|--------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (public) 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role 키 (서버 전용) |
| `CREDENTIAL_ENCRYPTION_KEY` | 자격증명 암호화 키 (고정값 사용, Railway에서 확인) |
| `BROWSER_HEADLESS` | 로컬 개발 시 `false` 설정 |
| `BROWSER_CHANNEL` | 로컬 개발 시 `chrome` 설정 |
| `GEMINI_API_KEY` | Gemini API 키 (상품명 LLM 정규화 + 썸네일 생성용) |

> 로컬 개발 시 `.env.local` 파일에 위 변수 모두 설정 필요 (`.gitignore`에 포함됨)

## MCP 사용 규칙 (항상 적용)
- 코드 작성 시 항상 context7로 최신 공식 문서 참고
- 복잡한 오류 분석 시 sequential-thinking 사용
- 브라우저/UI 오류 발생 시 chrome-devtools로 직접 확인
- 스크래핑 관련 작업은 playwright 사용

## 코딩 규칙
- TypeScript 엄격하게 사용
- 컴포넌트는 app/ 폴더 구조 따르기
- 오류 수정 시 원인 분석 먼저, 수정 후 반드시 테스트
- `.env.local`은 절대 커밋하지 않음
- Prettier 기본 포맷터 설정 (`.vscode/settings.json` — 저장 시 자동 포맷)

## 주요 파일 위치

### 페이지
- 로그인: `app/page.tsx`
- 회원가입: `app/signup/page.tsx`
- 대시보드: `app/workspace/page.tsx`
- 발주서: `app/workspace/orders/page.tsx`
- 상품 소싱: `app/workspace/products/page.tsx`
- 아카이브: `app/workspace/archive/page.tsx`
- 설정: `app/workspace/settings/page.tsx`

### API Routes
- AI 썸네일 분석: `app/api/ai/thumbnail/route.ts`
- AI 썸네일 생성: `app/api/ai/thumbnail-gen/route.ts`
- AI 상세페이지 생성: `app/api/ai/detail/route.ts`
- G마켓 상품 스크래핑: `app/api/scrape/gmarket-product/route.ts`
- 운송장 수집: `app/api/orders/collect-tracking/route.ts`
- 자동구매: `app/api/orders/auto-purchase/route.ts`
- 자격증명 관리: `app/api/credentials/route.ts`

### 컴포넌트
- 주문 테이블: `components/workspace/orders/table/` (분리됨)
- 주문 사이드패널: `components/workspace/orders/order-side-panel.tsx`
- 주문 일괄편집 툴바: `components/workspace/orders/bulk-edit-bar.tsx`
- 상품 테이블: `components/workspace/products/table/`
- 상품 이미지 관리: `components/workspace/products/image-tab.tsx`
- 상품 수수료 설정: `components/workspace/products/commission-tab.tsx`
- G마켓 가져오기 모달: `components/workspace/products/gmarket-import-modal.tsx`
- 상세페이지 일괄생성 모달: `components/workspace/products/batch-detail-modal.tsx`
- 사이드바: `components/workspace/sidebar.tsx`
- 헤더: `components/workspace/header.tsx`

### 대시보드
- 대시보드 데이터 훅: `hooks/use-dashboard.ts`
- KPI 카드: `components/workspace/dashboard/kpi-cards.tsx`
- 활동 로그 위젯: `components/workspace/dashboard/activity-log.tsx`
- 최근 주문 위젯: `components/workspace/dashboard/recent-orders.tsx`

### Context
- 인증: `context/AuthContext.tsx`
- 테마: `context/ThemeContext.tsx`
- 토스트 알림: `context/ToastContext.tsx`
- AI 배치 작업: `context/AiTaskContext.tsx`

### Hooks
- 주문 데이터: `hooks/use-orders.ts`
- 상품 데이터: `hooks/use-products.ts`
- 수수료 데이터: `hooks/use-commissions.ts`
- 대시보드 데이터: `hooks/use-dashboard.ts`
- 알림: `hooks/use-notifications.ts`
- 구매 로그: `hooks/use-purchase-logs.ts`
- 운송장 로그: `hooks/use-tracking-logs.ts`

### 라이브러리
- 엑셀 파서: `lib/excel-parser.ts`
- 엑셀 내보내기: `lib/excel-export.ts`
- 상품 계산: `lib/product-calculations.ts`
- 암호화: `lib/crypto.ts`
- API 헬퍼: `lib/api-helpers.ts`
- Supabase 클라이언트: `lib/supabase.ts`
- Gemini API: `lib/gemini.ts`
- 택배사 코드: `lib/courier-codes.ts`
- 대시보드 필터: `lib/dashboard-filters.ts`
- HTML 새니타이즈: `lib/sanitize.ts`
- 활동로그 포맷: `lib/log-format.ts`
- DB 타입: `types/database.ts`

### 스크래퍼
- 브라우저 팩토리: `lib/scrapers/browser.ts`
- 동시성 제어: `lib/scrapers/browser-pool.ts`
- 세션 관리: `lib/scrapers/session-manager.ts` (Supabase DB)
- 택배사 상수: `lib/scrapers/constants.ts` (COURIER_MAP)
- 스크래퍼 타입: `lib/scrapers/types.ts`
- G마켓 운송장: `lib/scrapers/gmarket.ts`
- G마켓 자동구매: `lib/scrapers/gmarket-purchase.ts`
- 오늘의집 운송장: `lib/scrapers/ohouse.ts`
- 오늘의집 자동구매: `lib/scrapers/ohouse-purchase.ts`
- 옥션 운송장: `lib/scrapers/auction.ts`

### 인프라
- Docker: `Dockerfile`
- Railway 설정: `railway.json`
- OCR 모델: `eng.traineddata` (루트, 5.2MB — 삭제 금지)

## 프로젝트 설명
플레이오토/지마켓/오늘의집/옥션 등 쇼핑몰 주문을 관리하는 리셀러용 대시보드.
엑셀 업로드로 주문 데이터 가져오기, 발주서 관리, 자동구매, 운송장 수집, 상품 소싱/수수료 관리,
AI 상세페이지 일괄생성 기능 포함.
