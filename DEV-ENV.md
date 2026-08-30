# workspace-dev — 개발 전용 환경

- 운영: `../workspace` (main 브랜치, Railway 자동 배포)
- 개발: 이 폴더 (`feature/marketplace-api-v2` 브랜치, 배포 안 됨)
- DB: 운영 Supabase **공유** — 새 테이블/컬럼 추가 시 운영 DB에도 반영됨. 기존 컬럼 변경·삭제 금지
- 실행: `npm run dev:3001` → http://localhost:3001 (운영 dev 서버 3000과 동시 실행 가능)
- `.env.local`의 `MARKETPLACE_API_DRY_RUN=true` — 마켓 API 쓰기 작업은 미리보기만. 실반영 테스트 시에만 false
- 취소 자동화 크롬 프로필(`.browser-profiles`)은 운영 폴더 것만 사용
- 완성 후: 이 브랜치를 main에 병합하면 운영에 반영

## 마켓 API 직접 연동 (2026-08-30)
- 클라이언트: `lib/coupang-api.ts`, `lib/naver-commerce-api.ts`, 공용 `lib/marketplace/common.ts`
- `MARKETPLACE_API_DRY_RUN=true` 이면 쓰기(가격/재고/판매상태/취소)는 실제 전송 없이 성공 처리되고 로그 action 에 `:dry` 접미가 붙는다. 읽기(연결확인·상품 동기화·주문 대조)는 항상 실제 호출.
- 설정 > 공식 API 연동: 쿠팡/스마트스토어 계정 등록 → 연결 확인 → (스토어) 상품 동기화(원상품번호 채움)
- 상품 페이지: 선택 후 "쿠팡 API 반영" / "스토어 API 반영"
- 주문 페이지: "마켓 취소 (API)" — 취소준비 건을 마켓 주문과 대조 후 체크한 건만 판매자 취소
- 대조 로직 검증: `npx tsx scripts/dev/test-cancel-match.mts coupang|smartstore [days]` (발주서 변경 없음)
- DB 마이그레이션 `supabase/migrations/20260830_smartstore_api_columns.sql` 을 Supabase SQL 에디터에서 수동 적용해야 스토어 가격/재고 반영·취소 로그가 동작한다
