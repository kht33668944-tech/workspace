# Workspace 리셀러 대시보드

리셀러 업무용 주문/상품 관리 대시보드입니다. 엑셀 발주서 업로드, 주문 관리, 자동구매, 운송장 수집, 가격/재고 동기화, AI 상품 정보 생성 기능을 한곳에서 처리합니다.

## 처음 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다.

## 기본 점검

작업 후에는 아래 명령 하나로 기본 검사를 합니다.

```bash
npm run verify
```

이 명령은 `npm run lint`와 `npm run typecheck`를 순서대로 실행합니다. 현재 별도 테스트 프레임워크는 없어서, 중요한 화면 변경은 브라우저에서 직접 확인해야 합니다.

## 자주 쓰는 명령

```bash
npm run dev        # 개발 서버 실행
npm run build      # 배포용 빌드 확인
npm run start      # 빌드 결과 실행
npm run lint       # 코드 규칙 검사
npm run typecheck  # TypeScript 타입 검사
npm run verify     # lint + typecheck
```

## 중요한 로컬 설정

`.env.local`에는 Supabase, Gemini, 암호화 키 같은 비밀값이 들어갑니다. 이 파일은 절대 커밋하지 않습니다.

필수 환경변수:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
CREDENTIAL_ENCRYPTION_KEY
GEMINI_API_KEY
```

로컬 스크래핑/자동구매 확인에 자주 쓰는 선택값:

```text
BROWSER_HEADLESS=false
BROWSER_CHANNEL=chrome
BROWSER_START_MINIMIZED=true
MAX_BROWSER_INSTANCES=2
```

`BROWSER_START_MINIMIZED`는 자동구매/운송장 수집용 브라우저를 작업표시줄에 최소화해서 시작할지 정합니다. 기본값은 최소화이며, 디버깅할 때만 `false`로 바꾸면 일반 창으로 뜹니다.

## Codex 작업 원칙

- 프로젝트 규칙은 [AGENTS.md](./AGENTS.md)를 기준으로 합니다.
- Claude Code용 [CLAUDE.md](./CLAUDE.md)는 과거 호환용으로 남겨둘 수 있지만, 앞으로의 기준 문서는 `AGENTS.md`입니다.
- 결제, 삭제, 외부 전송, 권한 변경처럼 되돌리기 어려운 작업은 실행 직전에 확인합니다.
- 사용자는 비개발자이므로 결과 설명은 쉬운 말로 짧게 정리합니다.

## 배포

- Railway Docker 배포를 사용합니다.
- Next.js는 `output: "standalone"` 설정입니다.
- Playwright, patchright, sharp, tesseract.js, impit 같은 서버 런타임 의존성은 `next.config.ts`의 `serverExternalPackages`에 등록되어 있습니다.
