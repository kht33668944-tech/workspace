#!/usr/bin/env node
/**
 * 최저가 자동 갱신 심부름꾼 (Windows 작업 스케줄러용)
 *
 * 사람이 브라우저에서 하던 일을 그대로 대신한다:
 *   1. (옵션 --reset) 당일 전일대비 기록 초기화 (DELETE /api/products/price-history)
 *   2. 최저가 수집 v2 (POST /api/products/scrape-prices-v2, SSE) + CF차단/실패 자동 재시도
 *   3. 변동 가격 자동 적용 (POST /api/products/apply-price-updates)
 *   4. 품절 마진 35 / 재입고 마진 7 복원 (products.margin_rate)
 *   5. 디스코드 합산 알림 1회 (POST /api/notifications/automation-result)
 *
 * 사용법:
 *   node scripts/auto-price-refresh.mjs --label 아침
 *   node scripts/auto-price-refresh.mjs --label 오후 --reset
 *   node scripts/auto-price-refresh.mjs --label 테스트 --limit 3
 *
 * 인증: .env.local의 SUPABASE_SERVICE_ROLE_KEY로 매직링크 토큰을 발급받아
 * 사용자 JWT를 얻는다. 비밀번호 저장 불필요. (단일 사용자 전제,
 * AUTOMATION_EMAIL 환경변수로 계정 지정 가능)
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kstYmd } from "./_date.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = path.join(ROOT, "scripts", "logs");

// ---------- 인자 파싱 ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const LABEL = opt("label") ?? "자동";
const DO_RESET = flag("reset");
const LIMIT = opt("limit") ? Number(opt("limit")) : null;
const MAX_RETRY = 10;

// ---------- 로그 ----------
mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `auto-price-${kstYmd()}.log`);
function log(msg) {
  const line = `[${new Date().toLocaleTimeString("ko-KR", { hour12: false })}] [auto-price:${LABEL}] ${msg}`;
  console.log(line);
  try { appendFileSync(logFile, line + "\n", "utf8"); } catch {}
}

// ---------- .env.local ----------
function loadEnv() {
  const envPath = path.join(ROOT, ".env.local");
  if (!existsSync(envPath)) throw new Error(`.env.local 없음: ${envPath}`);
  const env = {};
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnv();
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = (env.AUTO_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
if (!SUPA || !ANON || !SERVICE) throw new Error("Supabase 환경변수 누락 (.env.local 확인)");

const SOLDOUT_MARGIN = 35;
const DEFAULT_MARGIN = 8;

// ---------- 디스코드 직통 (서버가 죽어 알림 API도 못 쓸 때 최후 수단) ----------
async function discordDirect(message) {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (e) {
    log(`디스코드 직통 알림 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- 실행 기록 (marketplace_sync_runs, kind="price" — 자동화 페이지 타임라인·진행중 카드용) ----------
// 기록 실패는 log만 남기고 본작업(가격 갱신)을 절대 막지 않는다.
const runHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
let runId = null;
const runDetail = { label: LABEL, phase: "init" };

async function insertRun(userId) {
  try {
    const res = await fetch(`${SUPA}/rest/v1/marketplace_sync_runs`, {
      method: "POST",
      headers: { ...runHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ user_id: userId, platform: "all", kind: "price", trigger: "scheduler", dry_run: false, detail: runDetail }),
    });
    const rows = await res.json().catch(() => null);
    runId = Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;
  } catch (e) {
    log(`실행 기록 생성 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function patchRun(patch) {
  if (!runId) return;
  try {
    await fetch(`${SUPA}/rest/v1/marketplace_sync_runs?id=eq.${runId}`, {
      method: "PATCH", headers: runHeaders, body: JSON.stringify(patch),
    });
  } catch (e) {
    log(`실행 기록 갱신 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function step(phase, data) {
  runDetail.phase = phase;
  if (data !== undefined) runDetail[phase] = data;
  await patchRun({ detail: runDetail });
}

// ---------- 서버 살아있는지 확인, 죽어 있으면 기동 ----------
async function serverAlive() {
  try {
    await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
    return true; // 상태코드와 무관하게 응답만 오면 살아있는 것
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverAlive()) { log("서버 확인: 이미 실행 중"); return; }
  // BASE 의 포트에 맞춰 기동해야 헬스체크와 일치한다 (AUTO_BASE_URL=3001 인데 3000을 띄우면 영원히 기동 실패)
  const basePort = new URL(BASE).port || "3000";
  log(`서버가 꺼져 있음 — npm run dev (포트 ${basePort}) 자동 기동 시도`);
  const child = spawn("cmd.exe", ["/c", basePort === "3001" ? "npm run dev:3001" : `npm run dev -- -p ${basePort}`], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    if (await serverAlive()) { log(`서버 기동 완료 (${(i + 1) * 5}초 소요)`); await sleep(3000); return; }
  }
  throw new Error("서버 자동 기동 실패 (3분 대기 초과)");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 인증: service_role로 매직링크 발급 → JWT 획득 ----------
async function getSession() {
  const adminHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

  let email = env.AUTOMATION_EMAIL ?? null;
  if (!email) {
    // 상품 데이터를 실제로 보유한 계정을 자동 탐지 (계정이 여러 개여도 안전)
    const ownerRes = await fetch(`${SUPA}/rest/v1/products?select=user_id&limit=1`, { headers: adminHeaders });
    if (!ownerRes.ok) throw new Error(`상품 소유자 조회 실패 (${ownerRes.status})`);
    const ownerRows = await ownerRes.json();
    const ownerId = ownerRows?.[0]?.user_id;
    if (!ownerId) throw new Error("상품 데이터가 없어 소유 계정을 찾을 수 없습니다");

    const res = await fetch(`${SUPA}/auth/v1/admin/users?page=1&per_page=50`, { headers: adminHeaders });
    if (!res.ok) throw new Error(`사용자 목록 조회 실패 (${res.status})`);
    const json = await res.json();
    const users = json.users ?? json;
    const owner = Array.isArray(users) ? users.find((u) => u.id === ownerId) : null;
    if (!owner?.email) throw new Error(`상품 소유 계정(${ownerId})의 이메일을 찾을 수 없습니다`);
    email = owner.email;
    log(`상품 소유 계정 자동 탐지: ${email}`);
  }

  const linkRes = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!linkRes.ok) throw new Error(`매직링크 발급 실패 (${linkRes.status}): ${(await linkRes.text()).slice(0, 200)}`);
  const linkJson = await linkRes.json();
  const tokenHash = linkJson.hashed_token ?? linkJson.properties?.hashed_token;
  if (!tokenHash) throw new Error("매직링크 응답에 hashed_token 없음");

  for (const type of ["magiclink", "email"]) {
    const verifyRes = await fetch(`${SUPA}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ type, token_hash: tokenHash }),
    });
    if (verifyRes.ok) {
      const session = await verifyRes.json();
      if (session.access_token) {
        log(`로그인 성공 (${email})`);
        return { token: session.access_token, userId: session.user?.id, email };
      }
    }
  }
  throw new Error("매직링크 검증 실패 (JWT 획득 불가)");
}

// ---------- 상품 ID 조회 (service_role REST) ----------
async function fetchProductIds(userId) {
  const ids = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(
      `${SUPA}/rest/v1/products?select=id&user_id=eq.${userId}&purchase_url=neq.&registration_status=neq.${encodeURIComponent("판매종료")}&order=sort_order.asc`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Range: `${from}-${from + PAGE - 1}` } },
    );
    if (!res.ok) throw new Error(`상품 조회 실패 (${res.status})`);
    const rows = await res.json();
    ids.push(...rows.map((r) => r.id));
    if (rows.length < PAGE) break;
  }
  return ids;
}

// ---------- 당일 전일대비 초기화 ----------
async function resetToday(token, productIds) {
  const resetPoint = new Date();
  resetPoint.setHours(0, 0, 0, 0);
  const res = await fetch(`${BASE}/api/products/price-history`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ productIds, from: resetPoint.toISOString() }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`전일대비 초기화 실패: ${json.error ?? res.status}`);
  log(`전일대비 초기화 완료: 이력 ${json.cleared ?? 0}건 삭제`);
  return json.cleared ?? 0;
}

// ---------- 최저가 수집 1라운드 (SSE 파싱, 웹 UI와 동일한 해석) ----------
async function scrapeOnce(token, productIds) {
  const changes = [];   // { id, name, previous, price } — price>0 전부 (변동없음 포함)
  const retryItems = []; // CF차단 + 실패
  const soldOut = [];
  let skipped = 0;

  const res = await fetch(`${BASE}/api/products/scrape-prices-v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...(productIds ? { productIds } : {}), notify: false }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`수집 요청 실패 (${res.status}): ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.replace(/^data: /, "").trim();
      if (!data) continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }

      if (event.type === "progress") {
        if (event.bot_blocked) {
          retryItems.push({ id: event.id, name: event.name });
        } else if (event.price > 0) {
          changes.push({ id: event.id, name: event.name, previous: event.previous_price, price: event.price });
        } else if (event.fail_reason === "sold_out") {
          soldOut.push(event.id);
        } else {
          retryItems.push({ id: event.id, name: event.name });
        }
      } else if (event.type === "done") {
        skipped = event.skipped ?? 0;
        log(`라운드 완료: 변동 ${event.updated}, 변동없음 ${event.unchanged ?? 0}, 실패 ${event.failed}, 차단 ${event.bot_blocked ?? 0}, 품절 ${event.sold_out ?? 0}`);
      } else if (event.type === "error") {
        log(`서버 오류 이벤트: ${event.message}`);
      }
    }
  }
  return { changes, retryItems, soldOut, skipped };
}

// ---------- 수집 + 자동 재시도 ----------
async function scrapeWithRetry(token, initialIds, onRound) {
  const byId = new Map(); // id -> 마지막 성공 결과
  const allSoldOut = new Set();
  let skipped = 0;
  let currentIds = initialIds; // null이면 전체
  let remaining = [];

  for (let round = 0; round <= MAX_RETRY; round++) {
    if (round > 0) {
      log(`CF차단/실패 ${currentIds.length}개 자동 재시도 (${round}/${MAX_RETRY})...`);
      await sleep(3000);
    }
    let r;
    try {
      r = await scrapeOnce(token, currentIds);
    } catch (e) {
      // 서버 재컴파일·일시 네트워크 단절로 SSE 연결이 끊겨도 수집분을 버리지 않는다.
      // 첫 라운드(수집분 없음)만 치명적, 이후엔 30초 쉬고 같은 대상으로 재시도.
      const msg = e instanceof Error ? e.message : String(e);
      if (round === 0 && byId.size === 0) throw e;
      log(`라운드 ${round} 연결 오류 (${msg}) — 30초 후 재시도 계속`);
      await sleep(30000);
      continue;
    }
    for (const c of r.changes) byId.set(c.id, c);
    for (const id of r.soldOut) allSoldOut.add(id);
    if (round === 0) skipped = r.skipped;

    const retryMap = new Map();
    for (const item of r.retryItems) retryMap.set(item.id, item);
    remaining = [...retryMap.values()];
    if (onRound) await onRound({ round, collected: byId.size, soldOut: allSoldOut.size, retry: remaining.length });
    if (remaining.length === 0) break;
    currentIds = remaining.map((b) => b.id);
  }
  return { results: [...byId.values()], soldOut: [...allSoldOut], remaining, skipped };
}

// ---------- 가격 적용 ----------
async function applyChanges(token, results) {
  const changed = results.filter((r) => r.price !== r.previous);
  if (changed.length === 0) return 0;
  let applied = 0;
  const BATCH = 100;
  for (let i = 0; i < changed.length; i += BATCH) {
    const batch = changed.slice(i, i + BATCH);
    const res = await fetch(`${BASE}/api/products/apply-price-updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        updates: batch.map((r) => ({ id: r.id, price: r.price, previous_price: r.previous })),
        source: "impit_scrape",
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`가격 적용 실패: ${json.error ?? res.status}`);
    applied += json.applied ?? 0;
  }
  log(`가격 적용 완료: ${applied}건${applied < changed.length ? ` (변동 ${changed.length}건 중 미적용 ${changed.length - applied}건!)` : ""}`);
  return applied;
}

// ---------- 품절/재입고 마진 처리 (웹 UI의 applySoldOutMargins와 동일 규칙) ----------
async function applySoldOutMargins(userId, inStockIds, soldOutIds) {
  const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  const patch = async (ids, toMargin) => {
    const CHUNK = 80;
    let count = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const res = await fetch(
        `${SUPA}/rest/v1/products?select=id&user_id=eq.${userId}&id=in.(${chunk.join(",")})&margin_rate=neq.${toMargin}`,
        {
          method: "PATCH",
          headers: { ...svcHeaders, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({ margin_rate: toMargin }),
        },
      );
      if (!res.ok) { log(`마진 업데이트 실패 (${res.status})`); continue; }
      const rows = await res.json().catch(() => []);
      count += Array.isArray(rows) ? rows.length : 0;
    }
    return count;
  };

  // 복원 대상은 "현재 품절마진(35)인 상품 ∩ 이번에 가격이 잡힌 상품"만 — 빈 PATCH 왕복 방지
  let restoreTargets = [];
  if (inStockIds.length) {
    const res = await fetch(
      `${SUPA}/rest/v1/products?select=id&user_id=eq.${userId}&margin_rate=eq.${SOLDOUT_MARGIN}&registration_status=neq.${encodeURIComponent("판매종료")}&limit=5000`,
      { headers: svcHeaders },
    );
    if (res.ok) {
      const inStock = new Set(inStockIds);
      restoreTargets = (await res.json()).map((r) => r.id).filter((id) => inStock.has(id));
    } else {
      log(`품절마진 상품 조회 실패 (${res.status}) — 복원 건너뜀`);
    }
  }

  const soldCount = soldOutIds.length ? await patch(soldOutIds, SOLDOUT_MARGIN) : 0;
  const restoredCount = restoreTargets.length ? await patch(restoreTargets, DEFAULT_MARGIN) : 0;
  if (soldCount || restoredCount) log(`마진 처리: 품절 ${soldCount}건 → ${SOLDOUT_MARGIN}, 재입고 복원 ${restoredCount}건 → ${DEFAULT_MARGIN}`);
  return { soldCount, restoredIds: restoreTargets };
}

// ---------- 쿠팡·스마트스토어 API 반영 (변동가 price / 품절 stop / 재입고 resume) ----------
// 사이트의 "쿠팡 API 반영 / 스토어 API 반영" 버튼과 동일 경로. ESM(지마켓·옥션·11번가)은 API 없음 → 엑셀.
async function applyToMarketplaces(token, { changedIds, soldOutIds, restoredIds }) {
  const out = { coupang: null, smartstore: null, skipped: null };
  if (String(env.AUTO_MARKET_APPLY ?? "true").toLowerCase() === "false") { out.skipped = "AUTO_MARKET_APPLY=false"; return out; }
  let creds = [];
  try {
    const res = await fetch(`${BASE}/api/marketplace-api/credentials`, { headers: { Authorization: `Bearer ${token}` } });
    creds = res.ok ? await res.json() : [];
  } catch (e) { out.skipped = `자격증명 조회 실패: ${e instanceof Error ? e.message : String(e)}`; return out; }
  const jobs = [
    { action: "price", ids: [...new Set([...changedIds, ...restoredIds])] },
    { action: "stop", ids: soldOutIds },
    { action: "resume", ids: restoredIds },
  ];
  for (const platform of ["coupang", "smartstore"]) {
    const cred = creds.find((c) => c.platform === platform);
    if (!cred) continue;
    const r = { price: 0, stop: 0, resume: 0, failed: 0, blocked: 0, dry: false, errors: [] };
    out[platform] = r;
    for (const job of jobs) {
      if (job.ids.length === 0) continue;
      for (let i = 0; i < job.ids.length; i += 200) {
        const chunk = job.ids.slice(i, i + 200);
        try {
          const res = await fetch(`${BASE}/api/marketplace-api/${platform}/apply`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ credentialId: cred.id, productIds: chunk, action: job.action }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) { r.errors.push(`${job.action}: ${json.error ?? res.status}`); continue; }
          r[job.action] += json.successCount ?? 0;
          r.failed += json.failCount ?? 0;
          r.blocked += Array.isArray(json.blocked) ? json.blocked.length : 0;
          if (json.dryRun) r.dry = true;
          for (const x of (json.results ?? []).filter((x) => x.status === "failed").slice(0, 3)) r.errors.push(`${x.productName}: ${x.message}`);
        } catch (e) { r.errors.push(`${job.action}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    log(`${platform} API 반영: 가격 ${r.price} · 판매중지 ${r.stop} · 재개 ${r.resume} · 실패 ${r.failed} · 미연동 ${r.blocked}${r.dry ? " [DRY]" : ""}`);
    for (const e of r.errors.slice(0, 3)) log(`  x ${e}`);
  }
  return out;
}

// ---------- 가격수정 v2 엑셀 자동 저장 (변동 + 품절 상품만, 바탕화면 날짜별 폴더) ----------
// 웹의 "가격수정 v2 전체엑셀 다운로드"와 동일: 쿠팡 / ESM(옥션·지마켓 합본) / 스마트스토어 3종
const PRICE_V2_PLATFORMS = [
  { key: "coupang", label: "쿠팡 양식" },
  { key: "esm", label: "ESM 상품목록(옥션·지마켓)" },
  { key: "smartstore", label: "스마트스토어 일괄수정" },
];

async function exportPriceExcel(token, changedIds, soldOutIds) {
  const ids = [...new Set([...changedIds, ...soldOutIds])];
  if (ids.length === 0) return [];

  const now = new Date();
  const dateDir = kstYmd(now.getTime());
  const timeTag = `${String(now.getHours()).padStart(2, "0")}시${String(now.getMinutes()).padStart(2, "0")}분`;
  const outDir = path.join(env.AUTO_EXPORT_DIR ?? path.join(homedir(), "Desktop", "가격수정엑셀"), dateDir);
  mkdirSync(outDir, { recursive: true });

  const saved = [];
  for (const { key, label } of PRICE_V2_PLATFORMS) {
    try {
      const res = await fetch(`${BASE}/api/${key}-price-inventory/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ productIds: ids }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        log(`${label} 내보내기 실패: ${json.error ?? res.status}`);
        continue;
      }
      // 500행 초과 시 files[] 분할, 구형 응답은 단일 excelBase64
      const files = Array.isArray(json.files) && json.files.length > 0
        ? json.files
        : (json.excelBase64 && json.filename
          ? [{ excelBase64: json.excelBase64, filename: json.filename, rowCount: json.rowCount ?? 0 }]
          : []);
      if (files.length === 0) {
        log(`${label}: 생성된 행 없음 (${json.error ?? "양식 임포트 필요 가능성"})`);
        continue;
      }
      for (const file of files) {
        const outPath = path.join(outDir, `${timeTag}_${LABEL}_${file.filename}`);
        writeFileSync(outPath, Buffer.from(file.excelBase64, "base64"));
        saved.push(outPath);
        log(`엑셀 저장 (${label}): ${outPath}`);
      }
      const skipped = json.skippedProductIds?.length ?? 0;
      if (skipped > 0) log(`${label}: ${skipped}개 상품은 양식 행이 없어 제외됨 (재임포트 필요)`);
    } catch (e) {
      log(`${label} 저장 오류: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return saved;
}

// ---------- 디스코드 합산 알림 ----------
async function notify(token, { status, summary, fields }) {
  try {
    const res = await fetch(`${BASE}/api/notifications/automation-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: `최저가 자동 갱신 (${LABEL})`, status, summary, fields }),
    });
    if (!res.ok) throw new Error(`알림 API 실패 (${res.status})`);
  } catch (e) {
    log(`알림 API 실패 — 디스코드 직통으로 대체: ${e instanceof Error ? e.message : String(e)}`);
    await discordDirect(`**최저가 자동 갱신 (${LABEL})** — ${summary}`);
  }
}

// ---------- 메인 ----------
async function main() {
  log(`=== 시작 (reset=${DO_RESET}, limit=${LIMIT ?? "전체"}) ===`);
  const started = Date.now();

  await ensureServer();
  const { token, userId } = await getSession();
  await insertRun(userId);

  let productIds = null;
  let clearedCount = 0;

  if (DO_RESET || LIMIT) {
    const allIds = await fetchProductIds(userId);
    log(`상품 ${allIds.length}개 확인`);
    if (DO_RESET) clearedCount = await resetToday(token, allIds);
    if (LIMIT) productIds = allIds.slice(0, LIMIT);
  }
  await step("reset", { cleared: clearedCount });

  runDetail.scrape = { maxRetry: MAX_RETRY, rounds: [] };
  const { results, soldOut, remaining, skipped } = await scrapeWithRetry(token, productIds, async (round) => {
    runDetail.scrape.rounds.push(round);
    await step("scrape");
  });
  runDetail.scrape.remaining = remaining.length;
  runDetail.scrape.skipped = skipped;
  const changed = results.filter((r) => r.price !== r.previous);
  const unchanged = results.length - changed.length;

  const applied = await applyChanges(token, results);
  await step("apply", { changed: changed.length, applied, unchanged });
  const { restoredIds } = await applySoldOutMargins(userId, results.map((r) => r.id), soldOut);
  await step("margins", { soldOut: soldOut.length, restored: restoredIds.length });
  const market = await applyToMarketplaces(token, { changedIds: changed.map((r) => r.id), soldOutIds: soldOut, restoredIds });
  await step("market", market);
  const excelFiles = await exportPriceExcel(token, changed.map((r) => r.id), soldOut);
  await step("excel", { files: excelFiles.length });

  const elapsed = Math.round((Date.now() - started) / 1000);
  const okCount = results.length + soldOut.length;
  const summary = `변동 ${applied}건 적용, 변동없음 ${unchanged}건, 품절 ${soldOut.length}건, 미해결 ${remaining.length}건 (${elapsed}초)`;
  const fields = [
    { name: "가격 변동(적용)", value: applied },
    { name: "변동 없음", value: unchanged },
    { name: "품절", value: soldOut.length },
    { name: "재시도 후 미해결", value: remaining.length },
    ...(skipped ? [{ name: "건너뜀(비지마켓)", value: skipped }] : []),
    ...(DO_RESET ? [{ name: "전일대비 초기화", value: `${clearedCount}건 삭제 후 재수집` }] : []),
    ...(excelFiles.length ? [{ name: "엑셀 저장(ESM용)", value: `바탕화면\\가격수정엑셀 ${excelFiles.length}개 파일` }] : []),
  ];
  const mk = (p) => p ? `가격 ${p.price} · 중지 ${p.stop} · 재개 ${p.resume}${p.failed ? ` · 실패 ${p.failed}` : ""}${p.blocked ? ` · 미연동 ${p.blocked}` : ""}${p.dry ? " [DRY]" : ""}` : "계정 없음";
  if (market.skipped) fields.push({ name: "마켓 반영", value: `건너뜀 (${market.skipped})` });
  else { fields.push({ name: "쿠팡 반영", value: mk(market.coupang) }); fields.push({ name: "스토어 반영", value: mk(market.smartstore) }); }
  const marketFailed = [market.coupang, market.smartstore].some((p) => p && (p.failed > 0 || p.errors.length > 0));

  const status = okCount === 0 ? "failed" : (remaining.length > 0 || marketFailed) ? "partial" : "success";
  runDetail.phase = "done";
  await patchRun({
    status,
    finished_at: new Date().toISOString(),
    remote_count: results.length + soldOut.length,
    confirmed: applied,
    confirm_failed: remaining.length,
    error: status === "failed" ? summary : null,
    detail: runDetail,
  });
  await notify(token, { status, summary, fields });
  log(`=== 종료: ${summary} ===`);
  if (status === "failed") process.exitCode = 1;
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  log(`치명적 오류: ${msg}`);
  await patchRun({ status: "failed", finished_at: new Date().toISOString(), error: msg, detail: runDetail });
  await discordDirect(`**최저가 자동 갱신 (${LABEL}) 실패** — ${msg}`);
  process.exitCode = 1;
});
