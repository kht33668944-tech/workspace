# 리셀 매니저 프로젝트

리셀러용 주문/상품 관리 대시보드. 엑셀 업로드, 자동구매, 운송장 수집, AI 상세페이지 생성.

## 기술 스택
- Next.js 16 App Router (standalone), TypeScript (strict), Tailwind CSS 4
- Supabase (DB, Auth, 세션), Playwright (스크래핑), Tesseract.js (CAPTCHA OCR)
- Gemini API (상품명 정규화, 썸네일, 상세페이지)

## 배포
- **Railway** (Docker, asia-southeast1) — git push 자동 배포
- **Supabase** (ap-northeast-2) — project: `ygunjfbtyowsumtxkukr`

## 환경변수 (`.env.local`)
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `GEMINI_API_KEY`
- 로컬 전용: `BROWSER_HEADLESS=false`, `BROWSER_CHANNEL=chrome`

## MCP 규칙
- 코드 작성 → context7 최신 문서 참고
- 복잡한 오류 → sequential-thinking
- UI 오류 → chrome-devtools
- 스크래핑 → playwright

## 코딩 규칙
- TypeScript strict, app/ 폴더 구조
- `.env.local` 절대 커밋 금지
- `eng.traineddata` (루트 OCR 모델) 삭제 금지
- API route 헬퍼는 `lib/api-helpers.ts`의 공용 함수 사용
