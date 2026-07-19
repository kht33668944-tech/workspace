# 판매처 공식 API 전환 주말 인수인계

작성일: 2026-07-02

## 현재 상태

- 작업 브랜치: `feature/marketplace-api-stage1`
- 작업 시작 전 스냅샷: `pre-marketplace-api-stage1 before API work`
- 기존 `main` 기준으로 바로 작업하지 않기 위해 별도 브랜치에서 진행 중이다.
- Supabase 원격 프로젝트 `ygunjfbtyowsumtxkukr`에 `marketplace_api_credentials` 마이그레이션 적용 완료.
- 생성된 원격 테이블:
  - `marketplace_api_credentials`
  - `marketplace_api_logs`

## 구현된 내용

- 설정 화면에 `공식 API 연동` 섹션 추가
- 쿠팡 API 키 저장/수정/삭제/연결 확인 추가
- 쿠팡 API 키는 `CREDENTIAL_ENCRYPTION_KEY` 기반 기존 AES-256-GCM 암호화 재사용
- 상품 목록에서 선택 상품 대상 `쿠팡 API 반영` 모달 추가
- 쿠팡 API 반영 모달 기능:
  - 가격 반영
  - 재고 반영
  - 판매중지
  - 판매재개
  - 실행 전 미리보기
  - 성공/실패 결과 표시
  - 실행 로그 저장
- 기존 쿠팡 엑셀 가격수정 방식은 그대로 유지

## 주요 파일

- `supabase/migrations/marketplace_api_credentials.sql`
- `types/database.ts`
- `lib/coupang-api.ts`
- `lib/marketplace-api-helpers.ts`
- `app/api/marketplace-api/credentials/route.ts`
- `app/api/marketplace-api/credentials/[id]/route.ts`
- `app/api/marketplace-api/coupang/test/route.ts`
- `app/api/marketplace-api/coupang/preview/route.ts`
- `app/api/marketplace-api/coupang/apply/route.ts`
- `components/workspace/settings/marketplace-api-manager.tsx`
- `components/workspace/products/coupang-api-modal.tsx`
- `app/workspace/settings/page.tsx`
- `app/workspace/products/page.tsx`

## 검증 완료

- `npm run typecheck` 통과
- `npm run lint` 통과
- `npm run build` 통과

## 중요한 운영 판단

사용자가 현재 플레이오토를 사용 중이므로 쿠팡 직접 API 기능은 바로 실사용하지 않는 것이 안전하다.

이유:

- 쿠팡 OpenAPI 키는 판매자ID/업체코드별 1개만 발급 가능하다.
- 쿠팡 공식 안내상 `연동업체 선택: 플레이오토`와 `자체개발: 우리 앱`을 동시에 등록할 수 없다.
- 플레이오토가 쿠팡 API 키를 이미 쓰고 있으면, 우리 앱 직접 호출을 켜는 순간 플레이오토 연동과 충돌할 수 있다.

따라서 다음 작업 전 기본 원칙:

- 쿠팡 API 기능은 준비 상태로만 둔다.
- 플레이오토 연동을 유지한다.
- 쿠팡 직접 API는 고정 IP/연동 방식이 정리될 때까지 테스트 상품에도 바로 쓰지 않는다.

## 주말에 이어서 할 일

1. 현재 브랜치 확인

   ```bash
   git status --short --branch
   ```

2. 변경 검증

   ```bash
   npm run verify
   npm run build
   ```

3. 플레이오토 API 베타 확인

   - 플레이오토 공식 개발자 문서: `https://developers.playauto.io/`
   - 플레이오토 API 안내: `https://www.plto.com/additional/API/`
   - 목표는 쿠팡 직접 API가 아니라 `우리 앱 -> 플레이오토 API -> 쿠팡/스마트스토어/ESM` 구조가 가능한지 확인하는 것.

4. 우선 확인할 질문

   - 플레이오토 API로 상품 가격/재고 수정이 가능한가?
   - 플레이오토 API로 주문 수집 또는 쇼핑몰 작업 실행이 가능한가?
   - 플레이오토 API가 쿠팡 OpenAPI 키 충돌 없이 동작하는가?
   - API 베타 신청/승인/요금/제한이 있는가?
   - 우리 앱 서버 IP 등록이 필요한가?

5. 다음 구현 방향 후보

   - 후보 A: 쿠팡 직접 API는 보류하고 플레이오토 API 연동으로 전환
   - 후보 B: 쿠팡은 기존 엑셀/플레이오토 유지, 네이버 스마트스토어 직접 API부터 진행
   - 후보 C: 쿠팡 직접 API는 고정 IP 준비 후 별도 실험 브랜치에서만 테스트

## 다음 세션 시작 문장

사용자가 “다음에 뭐 하면 되지”라고 물으면:

1. `feature/marketplace-api-stage1` 브랜치인지 확인한다.
2. 이 문서와 Obsidian의 `workspace 판매처 공식 API 전환 계획` 노트를 읽는다.
3. 쿠팡 직접 API 실사용은 보류하고, 플레이오토 API 베타 가능성부터 조사한다.
4. 플레이오토 API가 상품 가격/재고/주문/송장 처리를 제공하면, 기존 `marketplace_api_credentials` 구조를 `playauto` 플랫폼까지 확장하는 계획을 세운다.

## 비밀정보 주의

- 쿠팡 Access Key, Secret Key, Vendor ID 실제 값은 문서에 적지 않는다.
- 플레이오토 API 키, 토큰, 로그인 정보도 문서에 적지 않는다.
- 실제 키는 앱 설정 화면 또는 환경변수/암호화 DB에만 저장한다.
