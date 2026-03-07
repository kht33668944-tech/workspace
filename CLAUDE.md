# 리셀 매니저 프로젝트

## 기술 스택
- Next.js App Router
- TypeScript
- Tailwind CSS
- Supabase (DB)
- Playwright (스크래핑)

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
- 엑셀 파서: lib/excel-parser.ts
- 엑셀 가져오기: app/workspace/orders/ 내 excel-import 관련 파일

## 프로젝트 설명
플레이오토/지마켓 등 쇼핑몰 주문을 관리하는 리셀러용 대시보드.
엑셀 업로드로 주문 데이터 가져오기, 발주서 관리, 상품 소싱 기능 포함.