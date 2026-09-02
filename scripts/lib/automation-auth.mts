// 크론 스크립트 → Next API 호출용 공용 헬퍼 (auto-price-refresh.mjs 의 검증된 패턴을 이식)
// - getAutomationSession: service_role 로 매직링크 발급 → 사용자 JWT 획득
// - ensureServer: AUTO_BASE_URL 서버가 죽어 있으면 npm run dev 자동 기동
// ※ auto-price-refresh.mjs 는 아직 자체 구현을 쓴다 — 나중에 이 모듈로 교체 가능

import { spawn } from "child_process";
import path from "path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** .env.local 파싱 결과 그대로 받는다 — 필수 키는 런타임에 검증 */
export type AutomationEnv = Record<string, string | undefined>;

export function resolveBaseUrl(env: AutomationEnv): string {
  return (env.AUTO_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

async function serverAlive(base: string): Promise<boolean> {
  try {
    await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
    return true; // 상태코드와 무관하게 응답만 오면 살아있는 것
  } catch {
    return false;
  }
}

/** Next 서버가 죽어 있으면 npm run dev 로 자동 기동 (BASE 포트에 맞춰) */
export async function ensureServer(base: string, log: (msg: string) => void): Promise<void> {
  if (await serverAlive(base)) { log("서버 확인: 이미 실행 중"); return; }
  const basePort = new URL(base).port || "3000";
  log(`서버가 꺼져 있음 — npm run dev (포트 ${basePort}) 자동 기동 시도`);
  const child = spawn("cmd.exe", ["/c", basePort === "3001" ? "npm run dev:3001" : `npm run dev -- -p ${basePort}`], {
    cwd: path.resolve("."),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    if (await serverAlive(base)) { log(`서버 기동 완료 (${(i + 1) * 5}초 소요)`); await sleep(3000); return; }
  }
  throw new Error("서버 자동 기동 실패 (3분 대기 초과)");
}

/** service_role 로 매직링크를 발급해 사용자 JWT 를 얻는다 (SYNC_USER_ID 우선, 없으면 AUTOMATION_EMAIL) */
export async function getAutomationSession(
  env: AutomationEnv,
  log: (msg: string) => void,
): Promise<{ token: string; userId: string; email: string }> {
  const SUPA = env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!SUPA || !SERVICE || !ANON) throw new Error("Supabase env(URL/SERVICE_ROLE/ANON)가 .env.local 에 없습니다");
  const adminHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

  let email = env.AUTOMATION_EMAIL ?? null;
  if (!email) {
    // SYNC_USER_ID(발주서 소유 사용자)의 이메일을 조회 — 주문수집 크론과 같은 계정으로 정렬
    const targetId = env.SYNC_USER_ID;
    if (!targetId) throw new Error("SYNC_USER_ID 또는 AUTOMATION_EMAIL 이 필요합니다");
    const res = await fetch(`${SUPA}/auth/v1/admin/users/${targetId}`, { headers: adminHeaders });
    if (!res.ok) throw new Error(`사용자 조회 실패 (${res.status})`);
    const user = (await res.json()) as { email?: string };
    if (!user.email) throw new Error(`SYNC_USER_ID(${targetId}) 계정의 이메일을 찾을 수 없습니다`);
    email = user.email;
  }

  const linkRes = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!linkRes.ok) throw new Error(`매직링크 발급 실패 (${linkRes.status}): ${(await linkRes.text()).slice(0, 200)}`);
  const linkJson = (await linkRes.json()) as { hashed_token?: string; properties?: { hashed_token?: string } };
  const tokenHash = linkJson.hashed_token ?? linkJson.properties?.hashed_token;
  if (!tokenHash) throw new Error("매직링크 응답에 hashed_token 없음");

  for (const type of ["magiclink", "email"]) {
    const verifyRes = await fetch(`${SUPA}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ type, token_hash: tokenHash }),
    });
    if (verifyRes.ok) {
      const session = (await verifyRes.json()) as { access_token?: string; user?: { id?: string } };
      if (session.access_token) {
        log(`로그인 성공 (${email})`);
        return { token: session.access_token, userId: session.user?.id ?? "", email };
      }
    }
  }
  throw new Error("매직링크 검증 실패 (JWT 획득 불가)");
}
