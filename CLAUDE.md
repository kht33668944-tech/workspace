# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

리셀러용 주문/상품 관리 대시보드. 엑셀 업로드, 자동구매, 운송장 수집, AI 상세페이지 생성.

## 명령어

```bash
npm run dev       # 개발 서버 (운영 체크아웃, 3000)
npm run dev:3001  # 개발 worktree용 (workspace-dev — DEV-ENV.md 참조)
npm run build     # 프로덕션 빌드
npm run lint      # ESLint
npm run typecheck # 타입 체크 (tsc --noEmit)
npm run verify    # lint + typecheck
npm run coupang:cancel / esm:cancel / ss:cancel  # 취소 자동화 (드라이런 먼저 — .claude/skills/*-cancel/SKILL.md)
```

테스트 프레임워크 없음(jest/vitest/playwright test 설정 없음). 검증은 수동/E2E.
`tsc`는 `**/*.ts`만 검사 — `scripts/*.mts`는 프로젝트 타입체크에 안 잡힌다(검증하려면 임시 tsconfig extends 필요).
개발은 git worktree `workspace-dev`(브랜치 feature/*)에서, 운영 DB 공유 — 상세 규칙은 `DEV-ENV.md`.

## 기술 스택

- **Next.js 16** App Router (standalone output), **React 19**, **TypeScript 5** (strict)
- **Tailwind CSS 4**, **Lucide React** (아이콘)
- **Supabase** (DB, Auth, Storage, RLS)
- **Playwright** + **patchright** (스크래핑/자동구매, 봇 감지 우회), **Tesseract.js** (CAPTCHA OCR), **impit** (가격비교 fetch)
- **Gemini API** (상품명 정규화, 썸네일, 상세페이지, 카테고리 분류)
- **XLSX** (엑셀 파싱/내보내기), **Sharp** (이미지 처리)

## 아키텍처

### 이중 Supabase 클라이언트 (lib/api-helpers.ts)
- `getSupabaseClient(token)` — 사용자 JWT 기반 (RLS 적용)
- `getServiceSupabaseClient()` — service_role 키 (RLS 우회, 장시간 작업용)
- API route에서는 반드시 이 헬퍼 사용

### API route 인증 (middleware.ts 없음)
- 인증은 미들웨어가 아니라 각 route에서 처리. 클라이언트는 `Authorization: Bearer <JWT>` 헤더 전송
- route에서 `getAccessToken(request)`로 토큰 추출 → 위 헬퍼에 전달
- RLS 정책은 `user_id = auth.uid()` 기준, service_role은 우회

### 스크래퍼 구조 (lib/scrapers/)
- `browser.ts` — Playwright 런치 + 스텔스 컨텍스트 (봇 감지 우회)
- `browser-pool.ts` — 세마포어 기반 동시 실행 제한 (`MAX_BROWSER_INSTANCES`, 기본 2)
- `session-manager.ts` — 로그인 세션 DB 캐시 (재로그인 최소화)
- 플랫폼별: `gmarket.ts`, `auction.ts`, `ohouse.ts` (운송장 수집), `gmarket-purchase.ts`, `ohouse-purchase.ts` (자동구매)

### 마켓 공식 API 직접 연동 (lib/marketplace/)
- 클라이언트: `lib/coupang-api.ts`(HMAC 서명), `lib/naver-commerce-api.ts`(OAuth, 초당 2회·form-urlencoded). 계정은 `marketplace_api_credentials`(암호화), 조립 헬퍼는 `lib/marketplace-api-helpers.ts`
- 도메인 로직: `lib/marketplace/` — `order-sync`(수집·발주확인·클레임·취소요청 승인), `order-ship`(송장 전송), `order-cancel`, `order-claims`(반품/교환), `settlement-sync`(정산), `inquiry-sync`+`inquiry-ai`(문의 수집·Gemini 답변 초안), `daily-summary`, `sync-run`(실행 기록 공용 헬퍼)
- `MARKETPLACE_API_DRY_RUN=true`면 쓰기(가격/재고/취소/송장)는 미리보기만, 읽기는 항상 실호출. 로그 action에 `:dry` 접미
- 실행 기록은 `marketplace_sync_runs`(kind: orders/shipping/price/inquiries/settlement/...) → `/workspace/automation` 페이지 타임라인이 읽는다. 기록 실패는 warn만 — 본작업을 막지 않는다
- **쿠팡 ID 함정**: 가격/재고 API 키(vendorItemId)는 `coupang_price_inventory.option_id` 컬럼. `vendor_item_id` 컬럼은 sellerProductId라 다른 값
- **날짜는 반드시 KST 기준**(`lib/date-utils.ts`의 `toKstDateKey`): UTC로 자르면 KST 새벽 주문·정산이 조회에서 빠진다 (2026-08-31 실제 버그)
- 방향 규칙: 마켓→발주서는 클레임·배송 상태만, 발주서→마켓은 발주확인·취소승인·판매자취소·송장만

### 자동화 크론 (Windows 작업 스케줄러 — 로컬 전용, Railway 미사용)
- 4종: `OnliveOrderSync`(매시 :00, `scripts/marketplace-order-sync.mts` — 주문·문의·정산 1회/일·21시 하루요약·헬스체크), `OnliveTrackingShip`(3시간, 02:30 앵커, `scripts/tracking-and-ship.mts` — 운송장 수집→송장 전송→ESM 엑셀), `OnliveAutoPrice`(4시간, 00:15 앵커, `scripts/auto-price-refresh.mjs` — 최저가 수집→가격 적용→마켓 반영+검산), `OnliveNightlyAudit`(매일 23:00, `scripts/nightly-audit.mts` — 12개 항목 총점검+장부 디스코드 보고, 웹훅 `DISCORD_WEBHOOK_AUDIT`)
- 등록/해제: `scripts/register-*-task.ps1` (`-Remove`). **시작 앵커는 `lib/automation-schedule.ts`와 일치가 계약** — 자동화 페이지 타임라인·헬스체크가 이 앵커를 가정하므로 임의 변경 금지
- 주문수집과 운송장 작업은 `logs/.marketplace.lock`으로 동시 실행 방지(쿠팡 API 초당 한도 합산). 스크립트 전용 env `SYNC_USER_ID`
- 디스코드 알림: `lib/discord-notifier.ts` — 채널별 웹훅 `DISCORD_WEBHOOK_ORDERS/TRACKING/PURCHASE/PRICE/AI/INQUIRY` (없으면 `DISCORD_WEBHOOK_URL`로 통합)

### 셀러센터 브라우저 자동화 (취소 처리 등)
- 전용 크롬을 CDP(포트 9222)로 제어: 프로필 `.browser-profiles/coupang-wing`(운영 체크아웃 폴더의 것만 사용, 로그인 세션 유지)
- 취소 파이프라인: `.claude/skills/{coupang,esm,smartstore}-cancel/SKILL.md` — 반드시 드라이런 → 보고 → 승인 → `--go`

### SSE 스트리밍 패턴
자동구매/가격수집 등 장시간 API는 `ReadableStream` + `text/event-stream` 사용:
- `maxDuration: 300` (5분)
- `AbortController`로 클라이언트 연결 끊김 감지 → 작업 중단
- 이벤트 타입: `progress`, `db_updated`, `done`, `error`, `cancelled`

### 암호화 (lib/crypto.ts)
- AES-256-GCM, `CREDENTIAL_ENCRYPTION_KEY` 환경변수 기반
- 구매 계정 비밀번호 저장/복호화에 사용

### 엑셀 파싱 (lib/excel-parser.ts)
- 스마트 헤더 탐지: 2개 이상 알려진 헤더 매칭 시 해당 행을 헤더로 인식
- 헤더 별칭 (수취인명/수취인/받는분 → `recipient_name`)
- 자동 정산예정금액 계산 (판매처별 수수료율)
- 주소 자동 분리 (기본주소 + 상세주소)

### AI 통합 (lib/gemini.ts)
- 기본 모델: `gemini-2.5-flash` (`GEMINI_MODEL` 환경변수로 변경 가능)
- `GEMINI_API_KEY` 없으면 graceful fallback (null 반환)
- 주요 함수: `generateText`, `analyzeImageFromUrl`, `generateImageFromPrompt`, `groundedSearch`, `classifyCategory`, `normalizeProductName`

### 가격·재고 동기화 (lib/*-price-inventory.ts)
- 쿠팡/스마트스토어/ESM(11번가)별 대량 엑셀 템플릿 import/export
- API: `app/api/{coupang,smartstore,esm}-price-inventory/{import,export,status}/route.ts`
- 셀러센터 원본 양식(JSONB)을 DB에 캐시 후, 우리 가격으로 재작성해 재업로드용 파일 생성
- 카테고리/필수옵션 정의: `lib/coupang-category-options.ts`, `lib/playauto-schema.ts`

### DB 스키마 (supabase/migrations/)
- 마이그레이션 SQL은 `supabase/migrations/`에 위치 (수동 적용)
- 핵심 테이블: `products`, `orders`, `purchase_credentials`(암호화), `purchase_logs`, `tracking_logs`, `finance`, `gemini_usage`(AI 토큰 비용 추적), `*_price_inventory`, `forbidden_words`, `marketplace_api_credentials`(마켓 API 키, 암호화), `marketplace_sync_runs`(자동화 실행 기록), `marketplace_inquiries`(문의), `app_settings`(자동승인 등 토글)
- Gemini 호출은 `gemini_usage`에 fire-and-forget으로 사용량 기록

### Next 빌드 설정 (next.config.ts)
- `output: "standalone"` (Docker), 네이티브/대형 패키지는 `serverExternalPackages`에 등록 (playwright, patchright, sharp, tesseract.js, impit) — 새 네이티브 의존성 추가 시 여기에 등록 필요

## 배포

- **Railway** (Docker, asia-southeast1) — git push 자동 배포, Dockerfile 멀티스테이지 빌드
- **Supabase** (ap-northeast-2) — project: `ygunjfbtyowsumtxkukr`

## 환경변수 (`.env.local`)

**필수:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `GEMINI_API_KEY`

**마켓 API·자동화:** `MARKETPLACE_API_DRY_RUN`(true=쓰기 미리보기), `SYNC_USER_ID`(크론 스크립트용 사용자 UUID), `AUTO_BASE_URL`(가격 자동화가 호출할 서버), `MFDS_API_KEY`(식약처), `DISCORD_WEBHOOK_*`

**선택 (로컬 개발):** `BROWSER_HEADLESS=false`, `BROWSER_CHANNEL=chrome`, `MAX_BROWSER_INSTANCES=2`

**선택 (단체문자 KT 한도):** `SMS_DAILY_LIMIT=500` (초과 시 발송 차단), `SMS_DAILY_WARN=300` (초과 시 경고 표시). KT는 일 300건 초과 시 경고 문자, 일 500건 도달 시 당일 발송을 차단한다. 차단 상태에서도 게이트웨이는 요청을 정상 접수하고 `sms_logs`에 `success`로 남기지만 실제로는 발송되지 않고 TTL 만료로 소멸하므로, 사전 차단이 필요하다.

## MCP 규칙

- 코드 작성 → context7 최신 문서 참고
- 복잡한 오류 → sequential-thinking
- UI 오류 → chrome-devtools
- 스크래핑 → playwright

## 플레이오토/마켓 등록 규격 (2026-08 검증 완료 — 위반 시 등록 반려됨)

- **쿠팡 GTIN(UID 의무화)**: 유명 브랜드 상품은 바코드 필수. 플레이오토 엑셀의 **"옵션바코드" 컬럼**이 쿠팡 GTIN으로 전송됨 (마스터 "바코드"/"표준상품코드"만으로는 반려). 바코드는 식약처 C005 API(품목보고번호→BAR_CD)로 확보, `products.item_info.바코드`에 저장
- **스마트스토어 고시 Y/N 필드**: "유전자변형식품 표시", "수입신고를 필함의 문구"는 **Y 또는 N만 허용** ("해당없음" 반려). `lib/excel-export.ts`의 `buildItemInfoNotice`가 자동 변환
- **스마트스토어 단위가격** (2026-04 가격표시제): 표시 여부 Y면 "구성 방식"(팩/낱개)·"팩 수량"·"팩당 수량"·"개당 용량" 필수. 구 "총 용량" 컬럼은 폐지
- **플레이오토 재업로드**: 같은 판매자관리코드 엑셀 재업로드 시 "이미 존재" 오류 → 플레이오토에서 기존 상품 삭제 후 업로드
- **식약처 API** (`MFDS_API_KEY`, 동시접속 1개 — INFO-500 시 재시도 필수): C002=품목제조보고, C005=바코드연계. 한글 뒤 정규식 `\b` 동작 안 함 → `(?=\s|$)` 사용
- **카테고리·필수옵션 결정**: `scripts/build-playauto-excel.mjs`가 AI 없이 규칙으로 채운다. 카테고리는 `smartstore_category_codes`에 실제 등록된 코드만 사용(콜라 6373132·사이다 6373129·캔커피 6373110 등 세부 카테고리 필수 — 상위/유사 카테고리로 보내면 쿠팡 필수옵션이 달라져 반려). 쿠팡 필수옵션은 `lib/coupang-category-options.ts`에서 해당 경로의 옵션 세트를 확인해 `[총 수량=개당 용량]` / `[총 수량=개당 중량]` / `[총 수량]` / `[수량=개당 수량=최소 중량]` 중 하나로 생성
- **쿠팡 GTIN은 상품 1개당 유일해야 함**: 같은 제품의 묶음수량 변형(210ml 30개/60개)은 단품 바코드가 같아 두 번째부터 "GTIN/MPN이 이미 등록된 상품과 중복" 반려. 식약처에는 박스 바코드가 없으므로 ①묶음수량을 한 상품의 옵션으로 합치거나 ②쿠팡엔 한 용량만 등록해야 함
- **쿠팡 수량 단위**: 대부분 카테고리는 "30개"를 받지만 에너지/비타민음료·녹차티백·커피믹스는 **"30개입"만** 허용 (`GAEIP_CATS`)
- **모델명**: 특수문자(•, ·, - 등) 포함 시 쿠팡 "모델명을 정확하게 입력해주세요" 반려 → 한글/영문/숫자/공백만 허용
- **브랜드 ≠ 제조사**: 브랜드 칸에는 소비자 브랜드(상품명 첫 단어 — 코카콜라, 환타, 웰치스)를 넣는다. 판매원/제조원(코카콜라음료, 세림향료 등)을 브랜드에 넣으면 쿠팡윙이 "브랜드 정보 수정" 대상으로 잡는다 (2026-09-01 319건 일괄 정정, `scripts/dev/wing-brand-fix.mjs`). `build-playauto-excel.mjs`는 브랜드=상품명 첫 단어, 제조사=판매원으로 분리됨. 등록 후 쿠팡윙 상품관리 대시보드 BRAND 필터로 잔여 제안 주기 확인
- **기본이미지**: 플레이오토 S3(`s3-ap-northeast-2.amazonaws.com/gmp01/...`) 썸네일은 만료되어 403이 날 수 있다. 업로드 전 HEAD 체크 필수
- **등록 전 검수**: `node scripts/rebuild-qa-check.mjs` 실행해 반려 요인 사전 확인. item_info의 `[검수필요]` 태그는 내보내기 시 자동 제거됨

## 코딩 규칙

- TypeScript strict, `app/` 폴더 구조
- `.env.local` 절대 커밋 금지
- `eng.traineddata` (루트 OCR 모델) 삭제 금지
- API route 헬퍼는 `lib/api-helpers.ts`의 공용 함수 사용
- 에러 로깅 시 bare error 객체 금지 → `e instanceof Error ? e.message : String(e)` 패턴 사용
- console.log/error/warn에 `[컴포넌트명]` 접두어 필수
- LLM 필요 시 항상 Gemini API 사용 (비용 절감)
- 상품명: 특수문자 금지, 한글/영문/숫자/공백만 허용
