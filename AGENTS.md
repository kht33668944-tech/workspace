# AGENTS.md

This file provides guidance to Codex when working in this repository. Keep this file short because it is read often.

## 사용자 응대 절대 규칙

- 사용자는 비개발자다. 답변은 쉬운 말로, 결과와 영향 중심으로 짧게 설명한다.
- 코드/명령어 세부사항은 필요할 때만 간단히 적는다.
- 사용자가 같이 공부해야 할 부분은 한두 문장으로 쉽게 설명한다.
- 사용자가 "알아서 해줘"라고 하면 안전한 범위에서 먼저 실행한다.
- 결제, 삭제, 외부 전송, 권한 변경, 운영 DB 변경처럼 되돌리기 어려운 일은 실행 직전에 확인한다.

## Codex 전환 원칙

- 앞으로의 기준 문서는 `AGENTS.md`다. `CLAUDE.md`는 과거 Claude Code 호환용 참고 문서로만 본다.
- Claude 전용 설정(`.claude/`)은 사용자가 요청하지 않으면 수정하거나 삭제하지 않는다.
- 로컬 Codex 설정(`.codex/`)과 MCP 비밀값은 커밋하지 않는다.
- 다시 쓸 수 있는 결정과 절차는 `obsidian-llm-wiki` skill로 `C:\Users\kht33\Documents\Obsidian Vault`에 한국어로 기록한다.

## 프로젝트 개요

리셀러용 주문/상품 관리 대시보드. 엑셀 업로드, 자동구매, 운송장 수집, AI 상세페이지 생성.

## 명령어

```bash
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드
npm run start    # 프로덕션 서버
npm run lint     # ESLint
npm run typecheck # 타입 체크
npm run verify   # lint + typecheck
```

테스트 프레임워크 없음(jest/vitest/playwright test 설정 없음). 검증은 수동/E2E.

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
- 핵심 테이블: `products`, `orders`, `purchase_credentials`(암호화), `purchase_logs`, `tracking_logs`, `finance`, `gemini_usage`(AI 토큰 비용 추적), `*_price_inventory`, `forbidden_words`
- Gemini 호출은 `gemini_usage`에 fire-and-forget으로 사용량 기록

### Next 빌드 설정 (next.config.ts)
- `output: "standalone"` (Docker), 네이티브/대형 패키지는 `serverExternalPackages`에 등록 (playwright, patchright, sharp, tesseract.js, impit) — 새 네이티브 의존성 추가 시 여기에 등록 필요

## 배포

- **Railway** (Docker, asia-southeast1) — git push 자동 배포, Dockerfile 멀티스테이지 빌드
- **Supabase** (ap-northeast-2) — project: `ygunjfbtyowsumtxkukr`

## 환경변수 (`.env.local`)

**필수:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `GEMINI_API_KEY`

**선택 (로컬 개발):** `BROWSER_HEADLESS=false`, `BROWSER_CHANNEL=chrome`, `MAX_BROWSER_INSTANCES=2`

## 도구 사용 규칙

- 코드 작성 시 현재 repo 패턴을 우선하고, 최신 외부 문서가 필요한 경우 공식 문서를 확인한다.
- 복잡한 오류는 단계별로 원인을 좁힌다.
- UI 오류는 브라우저에서 직접 확인한다.
- 스크래핑/자동구매는 Playwright/patchright 구조와 기존 `lib/scrapers/` 패턴을 따른다.

## 자동화 운영 규칙

- `AGENTS.md`는 매번 읽히므로 짧은 원칙과 포인터만 둔다. 세부 클릭 절차, 로그인 절차, 운영 워크플로우는 skill 또는 Obsidian에 둔다.
- workspace 리셀 자동화 작업은 `workspace-reseller-automation` skill을 우선 사용한다.
- 다시 쓸 수 있는 결정과 절차는 `obsidian-llm-wiki` skill로 `C:\Users\kht33\Documents\Obsidian Vault`에 한국어로 기록한다.
- Obsidian에는 비밀번호, API 키, 인증 토큰, 세션 값, 복구 코드 같은 비밀정보를 저장하지 않는다.
- 사용자는 비개발자이므로 답변은 쉬운 말로 설명하고, 코드/명령어 세부사항은 꼭 필요할 때만 짧게 언급한다.
- 사용자가 "알아서 해줘"라고 하면 먼저 안전한 범위에서 실행하고, 결제/삭제/외부 전송/권한 변경처럼 되돌리기 어려운 일은 실행 직전에 확인한다.

## 코딩 규칙

- TypeScript strict, `app/` 폴더 구조
- `.env.local` 절대 커밋 금지
- `eng.traineddata` (루트 OCR 모델) 삭제 금지
- API route 헬퍼는 `lib/api-helpers.ts`의 공용 함수 사용
- 에러 로깅 시 bare error 객체 금지 → `e instanceof Error ? e.message : String(e)` 패턴 사용
- console.log/error/warn에 `[컴포넌트명]` 접두어 필수
- LLM 필요 시 항상 Gemini API 사용 (비용 절감)
- 상품명: 특수문자 금지, 한글/영문/숫자/공백만 허용
