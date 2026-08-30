# workspace-dev — 개발 전용 환경

- 운영: `../workspace` (main 브랜치, Railway 자동 배포)
- 개발: 이 폴더 (`feature/marketplace-api-v2` 브랜치, 배포 안 됨)
- DB: 운영 Supabase **공유** — 새 테이블/컬럼 추가 시 운영 DB에도 반영됨. 기존 컬럼 변경·삭제 금지
- 실행: `npm run dev:3001` → http://localhost:3001 (운영 dev 서버 3000과 동시 실행 가능)
- `.env.local`의 `MARKETPLACE_API_DRY_RUN=true` — 마켓 API 쓰기 작업은 미리보기만. 실반영 테스트 시에만 false
- 취소 자동화 크롬 프로필(`.browser-profiles`)은 운영 폴더 것만 사용
- 완성 후: 이 브랜치를 main에 병합하면 운영에 반영
