# 단체문자 일일 발송량 카운터 + KT 한도 차단 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 휴대폰(SMS Gate) 경로 발송 시 오늘 누적 발송량을 모달에 표시하고, KT 일일 한도(500건)를 넘기는 발송을 서버에서 실제로 차단한다.

**Architecture:** `sms_logs`에서 오늘(KST) + `provider='phone'` 행 수를 세어 사용량으로 삼는다. 신규 `GET /api/sms/daily-usage`가 이 값을 모달에 제공해 배너·버튼 상태를 만들고, 동일한 집계 함수를 `POST /api/sms/send`가 SSE 스트림을 열기 전에 재실행해 한도 초과를 400으로 거부한다. 클라이언트 차단은 안내용이고 실제 방어는 서버가 한다.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Supabase(service_role 집계), React 19, Tailwind CSS 4, Lucide React

## Global Constraints

- 테스트 프레임워크가 없다(jest/vitest/playwright test 미설정). **본 계획의 검증 단계는 자동 테스트 대신 `npx tsc --noEmit` + 브라우저 수동 검증으로 대체한다.** 검증 없는 완료 선언 금지.
- `console.log/error/warn`에는 `[컴포넌트명]` 접두어 필수. 본 기능은 `[sms-daily-limit]`, `[sms-send]`, `[bulk-sms-modal]`을 쓴다.
- 에러 로깅 시 bare error 객체 금지 → `e instanceof Error ? e.message : String(e)` 패턴 사용.
- API route는 `lib/api-helpers.ts`의 `getAccessToken` / `getSupabaseClient` / `getServiceSupabaseClient`만 사용.
- 한도 기본값: `SMS_DAILY_LIMIT=500`, `SMS_DAILY_WARN=300` (KT 안내 문구 그대로).
- `.env.local`은 절대 커밋하지 않는다.
- 커밋은 사용자 승인 후에만 수행한다. 각 Task의 커밋 단계는 승인 전까지 보류한다.

---

## File Structure

| 파일 | 책임 | 작업 |
|---|---|---|
| `lib/sms-daily-limit.ts` | KST 자정 계산 + 오늘 사용량 집계 + 한도 상수. 서버 전용 단일 진실 공급원 | 생성 |
| `app/api/sms/daily-usage/route.ts` | 모달용 사용량 조회 엔드포인트 | 생성 |
| `app/api/sms/send/route.ts` | 발송 직전 서버 측 한도 검사 추가 | 수정 |
| `components/workspace/orders/bulk-sms-modal.tsx` | 사용량 배너 + 발송 버튼 차단 | 수정 |
| `CLAUDE.md` | 신규 환경변수 문서화 | 수정 |

집계 로직을 `lib/sms-daily-limit.ts` 한 곳에 두는 이유: 조회용 엔드포인트와 발송 검사가 **반드시 같은 기준으로 세야** 한다. 두 곳에 복사하면 한쪽만 고쳐져 표시와 차단이 어긋난다.

---

### Task 1: 집계 모듈 `lib/sms-daily-limit.ts`

**Files:**
- Create: `lib/sms-daily-limit.ts`

**Interfaces:**
- Consumes: `SupabaseClient` (`@supabase/supabase-js`)
- Produces:
  - `SMS_DAILY_LIMIT: number` — 기본 500
  - `SMS_DAILY_WARN: number` — 기본 300
  - `getKstMidnightUtc(now?: Date): Date` — 오늘 KST 자정을 UTC Date로 반환
  - `countTodayPhoneSms(supabase: SupabaseClient, userId: string): Promise<number | null>` — 실패 시 `null`

- [ ] **Step 1: 파일 생성**

```typescript
// KT 일일 문자 발송 한도 대응.
// KT는 일 300건 초과 시 경고 문자, 일 500건 도달 시 당일 발송을 차단한다.
// 차단 상태에서도 SMS Gate는 요청을 정상 접수하고 sms_logs에 success로 남기지만
// 통신사가 실제 발송을 막아, TTL(6시간) 만료로 조용히 소멸한다.
// → 화면상 전건 성공인데 고객에겐 한 통도 안 가는 사태를 막기 위한 사전 차단 로직.
import type { SupabaseClient } from "@supabase/supabase-js";

/** 이 값을 초과하는 발송은 차단한다. */
export const SMS_DAILY_LIMIT = Number(process.env.SMS_DAILY_LIMIT) || 500;
/** 이 값을 초과하면 경고를 표시한다(발송은 허용). */
export const SMS_DAILY_WARN = Number(process.env.SMS_DAILY_WARN) || 300;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 오늘(KST) 자정을 UTC Date로 반환.
 * 서버 타임존에 의존하지 않도록 UTC 기준으로 명시 계산한다.
 * (Railway 컨테이너는 UTC라 로컬 날짜를 쓰면 KST 날짜 경계와 최대 9시간 어긋난다.)
 */
export function getKstMidnightUtc(now: Date = new Date()): Date {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const midnightKstAsUtc = Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate()
  );
  return new Date(midnightKstAsUtc - KST_OFFSET_MS);
}

/**
 * 오늘(KST) 휴대폰 경로로 접수한 문자 건수.
 * SOLAPI는 KT 회선을 쓰지 않으므로 제외한다.
 * 실제 발송(Sent) 기준이 아니라 큐 접수 기준이라 실제보다 크거나 같게 잡히는데,
 * 한도 판단에서는 보수적인 방향이라 의도된 동작이다.
 * 집계 실패 시 null을 반환한다(카운터는 보조 장치이므로 발송을 막지 않는다).
 */
export async function countTodayPhoneSms(
  supabase: SupabaseClient,
  userId: string
): Promise<number | null> {
  try {
    const since = getKstMidnightUtc().toISOString();
    const { count, error } = await supabase
      .from("sms_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("provider", "phone")
      .gte("created_at", since);

    if (error) {
      console.warn(`[sms-daily-limit] 사용량 집계 실패: ${error.message}`);
      return null;
    }
    return count ?? 0;
  } catch (e) {
    console.warn(
      `[sms-daily-limit] 사용량 집계 예외: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`

Expected: 에러 없이 종료(exit 0). 이 파일 관련 에러가 나오면 안 된다.

- [ ] **Step 3: KST 자정 계산 검증**

Run:

```bash
node -e "
const KST=9*3600000;
function getKstMidnightUtc(now){const k=new Date(now.getTime()+KST);
 return new Date(Date.UTC(k.getUTCFullYear(),k.getUTCMonth(),k.getUTCDate())-KST);}
console.log(getKstMidnightUtc(new Date('2026-08-18T15:30:00Z')).toISOString());
console.log(getKstMidnightUtc(new Date('2026-08-18T14:59:00Z')).toISOString());
"
```

Expected: 정확히 아래 두 줄

```
2026-08-18T15:00:00.000Z
2026-08-17T15:00:00.000Z
```

첫 줄은 KST 8/19 00:30 시점의 자정이 8/19 00:00 KST(= 8/18 15:00 UTC)임을, 둘째 줄은 그 31분 전인 KST 8/18 23:59 시점에는 아직 8/18 00:00 KST(= 8/17 15:00 UTC)임을 확인한다. **날짜 경계가 정확히 갈리는지가 이 함수의 전부다.**

- [ ] **Step 4: 커밋 (사용자 승인 후)**

```bash
git add lib/sms-daily-limit.ts
git commit -m "feat: 단체문자 일일 발송량 집계 모듈 추가 (KST 자정 기준)"
```

---

### Task 2: 조회 API `GET /api/sms/daily-usage`

**Files:**
- Create: `app/api/sms/daily-usage/route.ts`

**Interfaces:**
- Consumes: `countTodayPhoneSms`, `SMS_DAILY_LIMIT`, `SMS_DAILY_WARN` (Task 1)
- Produces: `GET /api/sms/daily-usage` → `{ used: number | null, limit: number, warnAt: number }`
  - `used`가 `null`이면 집계 실패. 클라이언트는 이 경우 차단하지 않는다.

- [ ] **Step 1: 파일 생성**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { countTodayPhoneSms, SMS_DAILY_LIMIT, SMS_DAILY_WARN } from "@/lib/sms-daily-limit";

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const userSupabase = getSupabaseClient(token);
  const { data: { user } } = await userSupabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const used = await countTodayPhoneSms(getServiceSupabaseClient(), user.id);

  return NextResponse.json({
    used,
    limit: SMS_DAILY_LIMIT,
    warnAt: SMS_DAILY_WARN,
  });
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`

Expected: 에러 없이 종료(exit 0)

- [ ] **Step 3: 인증 없이 호출해 401 확인**

개발 서버를 띄운다: `npm run dev`

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/sms/daily-usage`

Expected: `401`

- [ ] **Step 4: 로그인 상태에서 실제 값 확인**

브라우저에서 워크스페이스에 로그인한 뒤, 개발자도구 콘솔에서 실행:

```javascript
const t = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes('auth-token')))).access_token;
await (await fetch('/api/sms/daily-usage', { headers: { Authorization: `Bearer ${t}` } })).json();
```

Expected: `{ used: <숫자>, limit: 500, warnAt: 300 }`

`used`는 오늘 휴대폰 경로로 접수한 건수와 일치해야 한다. 2026-08-18 기준으로는 329가 나온다(오전 배치 76건 + 저녁 배치 253건).

- [ ] **Step 5: 커밋 (사용자 승인 후)**

```bash
git add app/api/sms/daily-usage/route.ts
git commit -m "feat: 단체문자 오늘 발송량 조회 API 추가"
```

---

### Task 3: 서버 측 한도 차단 (`app/api/sms/send/route.ts`)

**Files:**
- Modify: `app/api/sms/send/route.ts` — import 블록 끝, 그리고 `validOrders` 확정 직후(현재 66-69행의 `if (validOrders.length === 0)` 블록 바로 다음)

**Interfaces:**
- Consumes: `countTodayPhoneSms`, `SMS_DAILY_LIMIT` (Task 1)
- Produces: 한도 초과 시 `400 { error: string, used: number, limit: number, allowed: number }`
  - `allowed` = 지금 보낼 수 있는 최대 건수. 클라이언트가 안내 문구에 쓴다.

**이 검사가 SSE 스트림을 열기 전에 있어야 하는 이유:** 스트림이 열린 뒤에는 `NextResponse.json`으로 에러를 돌려줄 수 없고, 클라이언트는 이미 "발송 중" 화면으로 전환된 상태다.

**클라이언트 검사만으로 부족한 이유:** 오래 열어둔 탭의 구(舊) 번들에는 새 차단 코드가 없어 그대로 우회한다. 발송은 되돌릴 수 없으므로 서버가 최종 방어선이다.

- [ ] **Step 1: import 추가**

파일 상단 import 블록의 마지막 줄(`import type { Order } from "@/types/database";`) 다음에 추가:

```typescript
import { countTodayPhoneSms, SMS_DAILY_LIMIT } from "@/lib/sms-daily-limit";
```

- [ ] **Step 2: 한도 검사 삽입**

아래 기존 코드를 찾는다:

```typescript
  if (validOrders.length === 0) {
    return NextResponse.json({ error: "유효한 전화번호가 있는 주문이 없습니다." }, { status: 400 });
  }
```

바로 다음에 아래를 삽입한다:

```typescript
  // ── KT 일일 한도 검사 (휴대폰 경로만) ──
  // 한도 초과 상태에서 발송하면 게이트웨이는 정상 접수하고 sms_logs에도 success로 남지만
  // 통신사가 실제 발송을 막아 TTL 만료로 조용히 소멸한다. 그 전에 끊는다.
  // 클라이언트에도 같은 검사가 있으나, 구번들 탭 우회를 막기 위해 서버에서 강제한다.
  if (provider === "phone") {
    const used = await countTodayPhoneSms(serviceSupabase, user.id);
    if (used !== null && used + validOrders.length > SMS_DAILY_LIMIT) {
      const allowed = Math.max(0, SMS_DAILY_LIMIT - used);
      console.warn(
        `[sms-send] 일일 한도 초과로 발송 거부: 오늘 ${used}건 + 요청 ${validOrders.length}건 > 한도 ${SMS_DAILY_LIMIT}건`
      );
      return NextResponse.json(
        {
          error: `KT 일일 발송 한도(${SMS_DAILY_LIMIT}건)를 초과합니다. 오늘 ${used}건 발송했고, 지금은 최대 ${allowed}건까지만 가능합니다.`,
          used,
          limit: SMS_DAILY_LIMIT,
          allowed,
        },
        { status: 400 }
      );
    }
  }
```

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`

Expected: 에러 없이 종료(exit 0)

- [ ] **Step 4: 한도를 1로 낮춰 차단 동작 확인**

`.env.local`에 임시로 아래를 추가한 뒤 개발 서버를 재시작한다:

```
SMS_DAILY_LIMIT=1
```

브라우저 콘솔에서 **클라이언트 UI를 거치지 않고** API를 직접 호출한다. 이것이 구번들 우회 방어 검증이다.

```javascript
const t = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.includes('auth-token')))).access_token;
const r = await fetch('/api/sms/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
  body: JSON.stringify({
    orderIds: ['<유효한 주문 UUID 1개>'],
    templateContent: '테스트',
    phoneField: 'orderer_phone',
    provider: 'phone',
  }),
});
console.log(r.status, await r.json());
```

Expected: `400` + `error`에 "KT 일일 발송 한도(1건)를 초과합니다..." 문구. **문자가 실제로 나가면 안 된다.**

- [ ] **Step 5: SOLAPI 경로는 차단되지 않는지 확인**

Step 4와 같은 호출에서 `provider`만 `'solapi'`로 바꿔 실행한다.

Expected: 400 한도 에러가 **나오지 않는다**. (SOLAPI 잔액이나 설정에 따른 다른 응답은 무관 — 확인 대상은 "한도 에러가 아닌 것"뿐이다.) KT 회선을 쓰지 않으므로 한도 대상이 아니다.

- [ ] **Step 6: `.env.local` 원복**

`SMS_DAILY_LIMIT=1` 줄을 삭제하거나 `SMS_DAILY_LIMIT=500`으로 되돌리고 개발 서버를 재시작한다. **이 단계를 빠뜨리면 실제 발송이 전부 막힌다.**

Run: `grep -n "SMS_DAILY_LIMIT" .env.local`

Expected: 출력이 없거나 `SMS_DAILY_LIMIT=500`

- [ ] **Step 7: 커밋 (사용자 승인 후)**

```bash
git add app/api/sms/send/route.ts
git commit -m "feat: 단체문자 발송 시 KT 일일 한도 서버 검사 추가"
```

---

### Task 4: 모달 사용량 배너 + 버튼 차단

**Files:**
- Modify: `components/workspace/orders/bulk-sms-modal.tsx`
  - 상태 선언부 (`templatesLoading` 다음, 39행 부근)
  - 파생값 계산 (`estimatedCost` 다음, 81행 부근)
  - `fetchTemplates` effect 다음 (105행 부근)
  - `handleSend` 진입 가드 (177행)
  - `handleSend`의 `finally` 블록 (268행 부근)
  - 발송 버튼 영역 (485-493행)

**Interfaces:**
- Consumes: `GET /api/sms/daily-usage` (Task 2), `POST /api/sms/send`의 400 응답 (Task 3)
- Produces: 없음 (최종 소비자)

기존 `handleSend`는 `!res.ok`일 때 이미 `err.error`를 토스트로 띄우므로, Task 3의 400 메시지가 그대로 사용자에게 보인다. 추가 처리는 필요 없다.

- [ ] **Step 1: 상태 추가**

`const [templatesLoading, setTemplatesLoading] = useState(true);` 다음 줄에 추가:

```typescript
  const [dailyUsage, setDailyUsage] = useState<{ used: number | null; limit: number; warnAt: number } | null>(null);
```

- [ ] **Step 2: 파생값 계산 추가**

`const estimatedCost = provider === "phone" ? 0 : recipients.length * costPerMessage;` 다음 줄에 추가:

```typescript
  // KT 일일 한도 판정. 휴대폰 경로에만 적용(SOLAPI는 KT 회선을 쓰지 않음).
  // 집계 실패(used === null) 시에는 차단하지 않는다 — 서버가 최종 방어선이다.
  const limitState = useMemo(() => {
    if (provider !== "phone" || !dailyUsage || dailyUsage.used === null) return null;
    const { used, limit, warnAt } = dailyUsage;
    const total = used + recipients.length;
    return {
      used,
      limit,
      warnAt,
      total,
      allowed: Math.max(0, limit - used),
      exceeded: total > limit,
      warning: total > warnAt && total <= limit,
    };
  }, [provider, dailyUsage, recipients.length]);

  const sendBlocked = limitState?.exceeded ?? false;
```

- [ ] **Step 3: 사용량 조회 함수와 effect 추가**

`useEffect(() => { fetchTemplates(); }, [fetchTemplates]);` 다음에 추가:

```typescript
  const fetchDailyUsage = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/sms/daily-usage", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) setDailyUsage(await res.json());
    } catch (e) {
      console.warn(`[bulk-sms-modal] 사용량 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [session?.access_token]);

  useEffect(() => { fetchDailyUsage(); }, [fetchDailyUsage]);
```

- [ ] **Step 4: `handleSend` 진입 가드 추가**

기존 첫 줄:

```typescript
    if (!session?.access_token || recipients.length === 0 || !templateContent.trim()) return;
```

을 아래로 교체:

```typescript
    if (!session?.access_token || recipients.length === 0 || !templateContent.trim()) return;
    if (sendBlocked) return;
```

- [ ] **Step 5: 발송 후 사용량 갱신**

`handleSend` 안의 아래 기존 `finally` 블록을 찾는다:

```typescript
      } finally {
        reader.releaseLock();
      }
```

아래로 교체한다:

```typescript
      } finally {
        reader.releaseLock();
        fetchDailyUsage();
      }
```

- [ ] **Step 6: 사용량 배너 추가**

`{/* 발송 버튼 */}` 주석 바로 위에 삽입:

```tsx
              {/* KT 일일 발송 한도 현황 */}
              {limitState && (
                <div
                  className={`px-3 py-2.5 rounded-lg border text-xs space-y-1 ${
                    limitState.exceeded
                      ? "bg-red-600/10 border-red-600/30 text-red-300"
                      : limitState.warning
                      ? "bg-orange-600/10 border-orange-600/30 text-orange-300"
                      : "bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-muted)]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span>오늘 발송</span>
                    <span className="font-mono">
                      {limitState.used} / {limitState.limit}건
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>이번 발송</span>
                    <span className="font-mono">
                      {recipients.length}건 → 합계 {limitState.total}건
                    </span>
                  </div>
                  {limitState.exceeded && (
                    <div className="pt-1 font-medium">
                      ⚠ {limitState.total - limitState.limit}건 초과. 최대 {limitState.allowed}건까지만 선택 가능합니다.
                    </div>
                  )}
                  {limitState.warning && (
                    <div className="pt-1">
                      KT 경고 문자가 올 수 있습니다 (일 {limitState.warnAt}건 초과). 발송은 가능합니다.
                    </div>
                  )}
                </div>
              )}
```

- [ ] **Step 7: 발송 버튼에 차단 반영**

기존 버튼:

```tsx
              <button
                onClick={handleSend}
                disabled={recipients.length === 0 || !templateContent.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                <Send className="w-4 h-4" />
                발송하기 ({recipients.length}건)
              </button>
```

를 아래로 교체:

```tsx
              <button
                onClick={handleSend}
                disabled={recipients.length === 0 || !templateContent.trim() || sendBlocked}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                <Send className="w-4 h-4" />
                {sendBlocked ? "일일 한도 초과로 발송 불가" : `발송하기 (${recipients.length}건)`}
              </button>
```

- [ ] **Step 8: 타입 체크와 린트**

Run: `npx tsc --noEmit`

Expected: 에러 없이 종료(exit 0)

Run: `npm run lint`

Expected: 이 파일 관련 에러 없음. `useMemo`/`useCallback` 의존성 경고가 뜨면 의존성 배열을 맞춰 해소한다.

- [ ] **Step 9: 브라우저 수동 검증**

`npm run dev`로 개발 서버를 띄우고 주문 페이지에서 확인한다.

1. 주문 몇 건 선택 → 자동화 → 단체문자 → **휴대폰** 선택
   Expected: 회색 배너에 `오늘 발송 N / 500건`이 뜬다
2. **SOLAPI**로 전환
   Expected: 배너가 사라진다
3. `.env.local`에 `SMS_DAILY_WARN=1` 추가 후 서버 재시작, 모달 재진입
   Expected: 배너가 주황색으로 바뀌고 "KT 경고 문자가 올 수 있습니다" 문구가 뜬다. **발송 버튼은 여전히 활성**
4. `.env.local`에 `SMS_DAILY_LIMIT=1` 추가 후 서버 재시작, 모달 재진입
   Expected: 배너가 빨간색, "N건 초과. 최대 0건까지만 선택 가능합니다.", 버튼 문구가 "일일 한도 초과로 발송 불가"로 바뀌고 **비활성화**
5. `.env.local`에서 `SMS_DAILY_WARN`, `SMS_DAILY_LIMIT` 임시값 제거 후 재시작

Run: `grep -n "SMS_DAILY" .env.local`

Expected: 출력 없음(기본값 500/300 사용), 또는 `SMS_DAILY_LIMIT=500` / `SMS_DAILY_WARN=300`

- [ ] **Step 10: 커밋 (사용자 승인 후)**

```bash
git add components/workspace/orders/bulk-sms-modal.tsx
git commit -m "feat: 단체문자 모달에 KT 일일 발송량 표시 및 한도 초과 차단"
```

---

### Task 5: 환경변수 문서화

**Files:**
- Modify: `CLAUDE.md` — "환경변수 (`.env.local`)" 섹션

**Interfaces:**
- Consumes: Task 1이 정의한 `SMS_DAILY_LIMIT`, `SMS_DAILY_WARN`
- Produces: 없음

- [ ] **Step 1: CLAUDE.md 갱신**

아래 기존 줄을 찾는다:

```markdown
**선택 (로컬 개발):** `BROWSER_HEADLESS=false`, `BROWSER_CHANNEL=chrome`, `MAX_BROWSER_INSTANCES=2`
```

그 아래에 다음 줄을 추가한다:

```markdown
**선택 (단체문자 KT 한도):** `SMS_DAILY_LIMIT=500` (초과 시 발송 차단), `SMS_DAILY_WARN=300` (초과 시 경고 표시). KT는 일 300건 초과 시 경고 문자, 일 500건 도달 시 당일 발송을 차단한다. 차단 상태에서도 게이트웨이는 요청을 정상 접수하고 `sms_logs`에 `success`로 남기지만 실제로는 발송되지 않고 TTL 만료로 소멸하므로, 사전 차단이 필요하다.
```

- [ ] **Step 2: 반영 확인**

Run: `grep -n "SMS_DAILY" CLAUDE.md`

Expected: 위에서 추가한 줄이 출력된다

- [ ] **Step 3: 커밋 (사용자 승인 후)**

```bash
git add CLAUDE.md
git commit -m "docs: 단체문자 KT 일일 한도 환경변수 문서화"
```

---

## 완료 기준

아래를 모두 만족해야 완료다. 하나라도 미확인이면 완료라고 말하지 않는다.

- [ ] `npx tsc --noEmit` 통과
- [ ] `npm run lint` 통과
- [ ] KST 자정 계산이 Task 1 Step 3의 두 줄과 정확히 일치
- [ ] 모달에서 휴대폰 선택 시 `오늘 발송 N / 500건` 표시 확인
- [ ] SOLAPI 선택 시 배너 숨김 확인
- [ ] `SMS_DAILY_WARN=1`에서 주황 경고 + 발송 버튼 활성 확인
- [ ] `SMS_DAILY_LIMIT=1`에서 빨강 차단 + 발송 버튼 비활성 확인
- [ ] `SMS_DAILY_LIMIT=1`에서 **API 직접 호출 시 400** 확인 (구번들 우회 방어)
- [ ] `.env.local`의 임시 테스트값 원복 확인
