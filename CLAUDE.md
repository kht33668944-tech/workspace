# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

리셀러용 주문/상품 관리 대시보드. 엑셀 업로드, 자동구매, 운송장 수집, AI 상세페이지 생성.

## 명령어

```bash
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드
npm run start    # 프로덕션 서버
npm run lint     # ESLint
npx tsc --noEmit # 타입 체크
```

## 기술 스택

- **Next.js 16** App Router (standalone output), **React 19**, **TypeScript 5** (strict)
- **Tailwind CSS 4**, **Lucide React** (아이콘)
- **Supabase** (DB, Auth, Storage, RLS)
- **Playwright** (스크래핑/자동구매), **Tesseract.js** (CAPTCHA OCR)
- **Gemini API** (상품명 정규화, 썸네일, 상세페이지, 카테고리 분류)
- **XLSX** (엑셀 파싱/내보내기), **Sharp** (이미지 처리)

## 아키텍처

### 이중 Supabase 클라이언트 (lib/api-helpers.ts)
- `getSupabaseClient(token)` — 사용자 JWT 기반 (RLS 적용)
- `getServiceSupabaseClient()` — service_role 키 (RLS 우회, 장시간 작업용)
- API route에서는 반드시 이 헬퍼 사용

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

## 배포

- **Railway** (Docker, asia-southeast1) — git push 자동 배포, Dockerfile 멀티스테이지 빌드
- **Supabase** (ap-northeast-2) — project: `ygunjfbtyowsumtxkukr`

## 환경변수 (`.env.local`)

**필수:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `GEMINI_API_KEY`

**선택 (로컬 개발):** `BROWSER_HEADLESS=false`, `BROWSER_CHANNEL=chrome`, `MAX_BROWSER_INSTANCES=2`

## MCP 규칙

- 코드 작성 → context7 최신 문서 참고
- 복잡한 오류 → sequential-thinking
- UI 오류 → chrome-devtools
- 스크래핑 → playwright

## 코딩 규칙

- TypeScript strict, `app/` 폴더 구조
- `.env.local` 절대 커밋 금지
- `eng.traineddata` (루트 OCR 모델) 삭제 금지
- API route 헬퍼는 `lib/api-helpers.ts`의 공용 함수 사용
- 에러 로깅 시 bare error 객체 금지 → `e instanceof Error ? e.message : String(e)` 패턴 사용
- console.log/error/warn에 `[컴포넌트명]` 접두어 필수
- LLM 필요 시 항상 Gemini API 사용 (비용 절감)
- 상품명: 특수문자 금지, 한글/영문/숫자/공백만 허용
