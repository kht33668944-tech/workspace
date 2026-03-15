# 리셀 매니저 프로젝트

## 기술 스택
- Next.js 16 App Router (standalone 빌드)
- TypeScript
- Tailwind CSS 4
- Supabase (DB, Auth, 세션 저장)
- Playwright (스크래핑, headless Chromium)

## 배포 환경
- **Railway** (Docker, asia-southeast1) — git push → 자동 배포
- **Supabase** (ap-northeast-2 서울)
- URL: https://resell-manager-production.up.railway.app
- 환경변수: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, CREDENTIAL_ENCRYPTION_KEY
- 로컬 개발: BROWSER_HEADLESS=false, BROWSER_CHANNEL=chrome (.env.local)

## MCP 사용 규칙 (항상 적용)
- 코드 작성 시 항상 context7로 최신 공식 문서 참고
- 복잡한 오류 분석 시 sequential-thinking 사용
- 브라우저/UI 오류 발생 시 chrome-devtools로 직접 확인
- 스크래핑 관련 작업은 playwright 사용

## 코딩 규칙
- TypeScript 엄격하게 사용
- 컴포넌트는 app/ 폴더 구조 따르기
- 오류 수정 시 원인 분석 먼저, 수정 후 반드시 테스트

## 주요 파일 위치
- 발주서 페이지: app/workspace/orders/page.tsx
- 주문 테이블: components/workspace/orders/table/ (분리됨)
- 엑셀 파서: lib/excel-parser.ts
- 스크래퍼 공통: lib/scrapers/browser.ts (런치 팩토리), lib/scrapers/constants.ts (COURIER_MAP)
- 세션 관리: lib/scrapers/session-manager.ts (Supabase DB)
- 동시성 제어: lib/scrapers/browser-pool.ts
- API 헬퍼: lib/api-helpers.ts
- Docker: Dockerfile, railway.json

## 프로젝트 설명
플레이오토/지마켓 등 쇼핑몰 주문을 관리하는 리셀러용 대시보드.
엑셀 업로드로 주문 데이터 가져오기, 발주서 관리, 상품 소싱 기능 포함.