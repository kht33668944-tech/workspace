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
- **쿠팡 ID 주의**: `coupang_price_inventory.vendor_item_id`(엑셀 "업체상품 ID")는 sellerProductId 이고, OpenAPI 가격/재고 키인 vendorItemId 는 `option_id`(엑셀 "옵션 ID") 컬럼이다. 미리보기/반영은 option_id 를 사용.
- 실반영 검증(2026-08-30): 쿠팡 28300→28310→28300, 스토어 24800→24810→24800 (가격 외 필드 변경 0) 성공. 스크립트 `scripts/dev/test-live-price.mts`

## 주문 수집·동기화 (2026-08-31)
- 마이그레이션 `supabase/migrations/20260831_order_api_sync.sql` 수동 적용 필요 (orders 컬럼 8개 + marketplace_sync_runs)
- 수동: 주문 페이지 `주문 수집 (API)` → 최근 N일 → 신규 등록·발주확인·클레임 반영·취소요청 승인
- 자동(1시간): `powershell -ExecutionPolicy Bypass -File scripts\register-order-sync-task.ps1` 로 작업 스케줄러 등록 (`-Remove` 로 해제). 실행 로그 `logs/order-sync.log`
- 수동 실행/검증: `npx tsx scripts/marketplace-order-sync.mts --platform all --days 7 --dry`
- `.env.local` `SYNC_USER_ID` = 발주서 소유 사용자 UUID (스크립트 전용)
- 규칙: 마켓→발주서 는 클레임·배송 상태만, 발주서→마켓 은 발주확인·취소승인·판매자취소만. `취소요청`은 사람이 승인 후 `취소완료`. 이미 플토로 들어온 행은 결제일+수취인+상품명으로 중복 제거하고 마켓 번호만 채워 넣는다
- 플레이오토 전환: 1주일 병행 후 플토의 쿠팡·스마트스토어 주문수집 OFF (ESM은 유지)
