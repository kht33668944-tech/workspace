# Railway 배포 확인 절차

이 프로젝트는 Railway `resell-manager` 프로젝트의 `production` 환경, `manager` 서비스에 연결되어 있다.

## 평소 배포 순서

```bash
npm run verify
npm run build
git push origin main
npm run deploy:list
npm run deploy:check
```

## 완료 기준

- 최신 배포 상태가 `SUCCESS`다.
- 서비스 상태가 `Online`이다.
- 배포 URL이 정상 응답한다.

배포 URL:

```text
https://resell-manager-production.up.railway.app
```

## 상태 해석

- `INITIALIZING`: 배포 준비 또는 서비스 전환 중이다. 바로 실패로 보지 않는다.
- `BUILDING`: Dockerfile 빌드 중이다. Playwright Chromium 다운로드 때문에 몇 분 걸릴 수 있다.
- `SUCCESS`: 배포와 헬스체크가 끝났다.
- `REMOVED`: 새 배포가 이전 배포를 대체했을 수 있다. 같은 시간대에 여러 번 push했으면 정상적인 교체일 수 있다.
- `FAILED`: 빌드 로그와 배포 로그를 확인한다.

## 로그 확인

```bash
railway logs --latest --build --lines 200
railway logs --latest --deployment --lines 100
```

특정 배포 ID를 볼 때:

```bash
railway logs <deployment-id> --build --lines 200
railway logs <deployment-id> --deployment --lines 100
```

## 수동 배포 기준

`railway up`은 자동 배포가 실제로 실패했거나 장시간 멈춘 것을 확인한 뒤에만 사용한다.

수동 배포 전에는 `.dockerignore`에 로컬 비밀 설정이 제외되어 있는지 확인한다.

현재 제외 기준:

- `.env.local`
- `.claude`
- `.codex`
- `.mcp.json`
- `.mcp.local.json`
