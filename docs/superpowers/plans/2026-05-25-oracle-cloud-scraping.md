# Oracle Cloud 스크래핑 서버 구축 계획

## 배경
- Railway 서버가 싱가포르에 있어서 지마켓 봇감지가 심함
- Dockerfile에 patchright 모듈이 누락되어 프로덕션에서 스크래핑 기능 전체 실패
- 한국 IP로 접속하면 봇감지 회피율이 크게 올라감

## 현재 문제점 (프로덕션)
1. **patchright/patchright-core** 모듈이 Dockerfile에서 복사 안 됨
2. **patchright 전용 브라우저**(chromium-1217)가 설치 안 됨 (playwright는 chromium-1208)
3. **browser.ts 맨 위에서 patchright import** → patchright 없으면 자동구매/운송장 수집 등 브라우저 기능 전부 죽음
4. 싱가포르 IP → 한국 사이트 봇감지 강화

## 해결 방안: Oracle Cloud 무료 서버 (서울 리전)

### 왜 Oracle?
- 무료 ARM 서버: 4코어 CPU, 24GB RAM (Railway보다 훨씬 좋음)
- 서울(춘천) 리전 → 한국 IP → 봇감지 대폭 감소
- 월 $0 (유료 전환 시 ~$5)

### 아키텍처
```
Railway (싱가포르)          Oracle Cloud (서울)
  Next.js 앱     ------>    SOCKS5 프록시 또는 스크래핑 서비스
  UI/API 서버    <------    한국 IP로 지마켓 접속
```

### 방법 A: 프록시 방식 (간단)
1. Oracle VM에 프록시(microsocks 또는 SSH 터널) 설치
2. `lib/scrapers/browser.ts`에 프록시 설정 추가 (2줄)
3. Railway 환경변수에 `PROXY_SERVER=socks5://오라클IP:포트` 추가

**코드 변경 (browser.ts의 launchBrowser, launchPatchedBrowser 둘 다):**
```typescript
const proxyServer = process.env.PROXY_SERVER;
chromium.launch({
  headless,
  ...(channel && { channel }),
  ...(proxyServer && { proxy: { server: proxyServer } }),
  args: [...]
})
```

### 방법 B: 스크래핑 서비스 이전 (더 좋음, 복잡)
- 스크래핑 로직(lib/scrapers/*)을 Oracle VM에서 직접 실행
- Railway에서는 API 호출로 스크래핑 요청
- 프록시 경유 없이 직접 한국 IP → 지마켓 접속 (가장 빠름)
- Oracle 24GB RAM → 브라우저 4~6개 동시 실행 가능

## Oracle Cloud 가입 절차
1. https://cloud.oracle.com 접속 → Start for free
2. 홈 영역: **South Korea (Chuncheon)** 선택
3. 주소는 전부 영문으로 입력
4. 카드 등록 (무료 티어는 과금 안 됨)
5. 가상 선불카드/일회용 카드 안 됨 → 실물 Visa/Mastercard 필요

## VM 생성 후 해야 할 것
1. ARM 인스턴스 생성 (Ampere A1, 4 OCPU, 24GB RAM)
2. Ubuntu 22.04 이미지 선택
3. SSH 키 생성 및 등록
4. 보안 목록(Security List)에서 필요한 포트만 열기
5. Playwright + patchright + Chromium 설치
6. 프록시 설정 또는 스크래핑 서비스 배포

## 병행: Dockerfile 수정 (patchright 누락 해결)
Oracle 설정과 별개로, 현재 Dockerfile도 고쳐야 함:

**deps 스테이지에 추가:**
```dockerfile
RUN npx patchright install chromium
```

**runner 스테이지에 추가:**
```dockerfile
COPY --from=deps /app/node_modules/patchright ./node_modules/patchright
COPY --from=deps /app/node_modules/patchright-core ./node_modules/patchright-core
```

**browser.ts 안전장치 (patchright 동적 import):**
```typescript
export async function launchPatchedBrowser(): Promise<Browser> {
  const { chromium: patchedChromium } = await import("patchright");
  // ...
}
```

## 보안 주의사항
- SOCKS5 프록시를 인터넷에 열어두면 해커가 악용함
- SSH 터널 방식 추천 (가장 안전)
- 또는 Oracle 보안 목록에서 Railway IP만 허용

## 비용
- Oracle 무료 티어: $0/월
- Oracle 유료 전환 시: ~$5/월
- 대안 (Vultr 서울): ~$6/월
