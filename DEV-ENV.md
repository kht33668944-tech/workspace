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

## 송장 전송·취소거절·반품/교환·정산·자동승인 (2026-08-31, 2단계)
- 마이그레이션 `supabase/migrations/20260901_order_shipping_settlement.sql` 수동 적용 필요 (orders 컬럼 7개, marketplace_sync_runs.kind, app_settings)
- **송장 전송**: 주문 페이지 `송장 전송 (API)` (선택 없으면 미전송 전체, 미리보기→실행). 대상 = 쿠팡·스토어 판매분 중 운송장 있고 `shipped_to_marketplace_at` 비어 있는 행. 클레임 상태·택배사 코드 없음·플토 수집분(마켓번호 없음)은 제외. 운송장을 바꾸면 자동으로 재전송 대상이 된다
- **자동(3시간)** `OnliveTrackingShip`: `powershell -ExecutionPolicy Bypass -File scripts\register-tracking-ship-task.ps1` (`-Remove` 해제, `-IntervalHours N`). 흐름 = 구매처(지마켓·옥션·오늘의집) 운송장 수집(브라우저) → 쿠팡·스토어 송장 전송 → ESM(지마켓·옥션·11번가 판매분) 플토 운송장 엑셀을 `바탕화면\ESM운송장\`에 저장(`TRACKING_EXPORT_DIR`로 변경). 로그 `logs/tracking-ship.log`. 주문수집 작업과는 `logs/.marketplace.lock`으로 동시 실행 방지
- 수동 실행/검증: `npx tsx scripts/tracking-and-ship.mts --dry` (`--skip-collect`, `--skip-ship`, `--skip-esm`)
- 택배사 코드: `lib/marketplace/courier-codes.ts` (CJ대한통운=CJGLS, 롯데=HYUNDAI, 한진=HANJIN, 우체국=EPOST, 로젠=KGB, 경동=KDEXP …). 없는 택배사는 여기 추가
- **취소요청 거절**: 주문 수집 모달 → 취소요청 목록 → `선택 거절(발송)` — 운송장 필수. 스토어는 발송처리가 곧 거절, 쿠팡은 "이미출고 처리"
- **반품/교환**: 주문 사이드패널(반품준비/교환준비 상태)에 단계 버튼. 쿠팡 반품 = 입고 확인 → 반품 완료(환불), 거절은 윙에서만. 스토어 반품 = 반품 완료(환불) / 거절(사유). 교환 = 수거 완료 → 재배송 송장 등록 / 거절
- **정산**: 주문 수집 모달 `정산 반영 (최근 35일)` 또는 자동 수집 때 하루 1회. 쿠팡 revenue-history(orderId+vendorItemId), 스토어 settle/case(productOrderId). `settlement`을 실정산액으로 덮어쓰고 `settlement_source='api'`
- **취소요청 자동 승인**: 설정 페이지 토글(기본 꺼짐). 운송장 없고 구매(발주) 전인 취소요청만 자동, 나머지는 디스코드 알림 후 사람이 처리

## 디스코드 채널별 알림 (2026-08-31)
`.env.local`에 채널별 웹훅을 넣으면 알림 종류별로 분리 전송(없으면 `DISCORD_WEBHOOK_URL`로 통합):
`DISCORD_WEBHOOK_ORDERS`(주문 수집·취소요청·정산) · `DISCORD_WEBHOOK_TRACKING`(운송장 수집·송장 전송·ESM 엑셀) · `DISCORD_WEBHOOK_PURCHASE`(자동구매) · `DISCORD_WEBHOOK_PRICE`(가격/재고 수집) · `DISCORD_WEBHOOK_AI`(AI 상세페이지). 채널은 `notifyAutomationResult({channel})` 또는 제목으로 추론(`inferDiscordChannel`).

## 최저가 자동 갱신 (2026-08-31)
- `OnliveAutoPrice` 4시간마다(:15): `powershell -ExecutionPolicy Bypass -File scripts\register-auto-price-task.ps1` (`-Remove` 해제). 매 실행마다 당일 전일대비 이력 초기화(`--reset`) 후 전체 상품 최저가 수집·변동가 적용·품절/재입고 마진 복원·엑셀(`바탕화면\가격수정엑셀`)·디스코드(`#가격재고-자동화`)
- 대상 서버는 `.env.local` `AUTO_BASE_URL`(현재 3001 개발 서버). 로그 `logs/auto-price-task.log`, `scripts/logs/auto-price-YYYY-MM-DD.log`
- 수동: `node scripts/auto-price-refresh.mjs --label 테스트 --reset --limit 3`

## 등록상태 '판매종료' (2026-08-31)
- 판매중지 = 일시(품절 등). 자동화가 최저가 수집·가격 반영은 하지만 **마켓 판매재개는 보내지 않음** → 사람이 등록완료로 바꾼 뒤 재개
- 판매종료 = 영구(상품정보 오류·완전 품절). 최저가 수집·가격 반영·마진 복원·마켓 API 전부 제외. 2026-08-31 기존 판매중지 37개를 판매종료로 이동
- 규칙 상수: `lib/constants.ts` `AUTOMATION_EXCLUDED_STATUSES`, `NO_AUTO_RESUME_STATUSES`
