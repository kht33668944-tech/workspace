// 운송장 수집 → 마켓 송장 전송 → ESM 운송장 엑셀 저장 (윈도우 작업 스케줄러 "OnliveTrackingShip", 3시간마다)
//
//   npx tsx scripts/tracking-and-ship.mts [--skip-collect] [--skip-ship] [--skip-esm] [--dry] [--days 30]
//
// - 수집: purchase_credentials(지마켓/옥션/오늘의집)로 운송장 없는 주문을 스크래핑해 발주서에 반영 (브라우저 필요)
// - 전송: 쿠팡·스마트스토어 판매분 중 미전송 운송장을 API 로 발송처리 (수동 입력분 포함)
// - ESM : 지마켓·옥션·11번가 판매분 운송장을 플레이오토 양식 엑셀로 바탕화면\ESM운송장 에 저장
// - --dry / MARKETPLACE_API_DRY_RUN=true 면 마켓 쓰기 없이 대상만 확인 (수집·엑셀은 실행됨, 엑셀은 exported 표시 안 함)
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";
import { shipOrders, type ShipResult } from "@/lib/marketplace/order-ship";
import { notifyShipResults } from "@/lib/marketplace/order-sync-notify";
import { collectTrackingForUser, type CollectAllResult } from "@/lib/tracking/collect-all";
import { exportEsmTrackingExcel, type EsmExportResult } from "@/lib/tracking/esm-export";
import { startSyncRun, finishSyncRun, type SyncRunPatch } from "@/lib/marketplace/sync-run";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const days = Math.min(Math.max(Number(opt("days", "30")) || 30, 1), 90);
const dry = has("dry");
if (dry) process.env.MARKETPLACE_API_DRY_RUN = "true";

const envText = fs.readFileSync(".env.local", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k];
if (process.env.BROWSER_HEADLESS_SCHEDULED) process.env.BROWSER_HEADLESS = process.env.BROWSER_HEADLESS_SCHEDULED;

const logDir = path.resolve("logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "tracking-ship.log");
const log = (msg: string) => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); fs.appendFileSync(logFile, line + "\n"); };

// 주문수집 스크립트와 동시 실행 방지 (쿠팡 API 초당 한도 합산)
const lockFile = path.join(logDir, ".marketplace.lock");
async function acquireLock() {
  for (let i = 0; i < 60; i++) {
    try {
      const st = fs.existsSync(lockFile) ? fs.statSync(lockFile) : null;
      if (st && Date.now() - st.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(lockFile); // 30분 넘은 락은 죽은 프로세스
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return true;
    } catch { await new Promise((r) => setTimeout(r, 10000)); }
  }
  return false;
}
const releaseLock = () => { try { if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.unlinkSync(lockFile); } catch { /* ignore */ } };

const userId = env.SYNC_USER_ID;
if (!userId) { log("SYNC_USER_ID 가 .env.local 에 없다"); process.exit(1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

if (!(await acquireLock())) { log("다른 마켓 작업이 실행 중 — 10분 대기 후 포기"); process.exit(2); }
process.on("exit", releaseLock);

// 실행 기록 (자동화 페이지 타임라인용) — 실패해도 본작업 계속 (lib/marketplace/sync-run 공용)
const startRun = (kind: string) => startSyncRun(sb, { userId, platform: "all", kind, trigger: "scheduler", dryRun: dry });
const finishRun = (id: string | null, patch: SyncRunPatch) => finishSyncRun(sb, id, patch);

let collect: CollectAllResult | null = null;
const ships: ShipResult[] = [];
let esm: EsmExportResult | null = null;

try {
  // 1) 운송장 수집
  if (!has("skip-collect")) {
    const runId = await startRun("tracking-collect");
    try {
      collect = await collectTrackingForUser(sb, userId, { days, log });
      log(`수집: 미수집 ${collect.pending}건, 계정 매칭 안 됨 ${collect.unmatched}건, 그룹 ${collect.groups.length}`);
      const applied = collect.groups.reduce((n, g) => n + g.applied, 0);
      const hasIssue = collect.groups.some((g) => g.error || g.failed > 0);
      await finishRun(runId, {
        status: hasIssue ? "partial" : "success",
        remote_count: collect.pending,
        confirmed: applied,
        detail: { pending: collect.pending, unmatched: collect.unmatched, applied, groups: collect.groups },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`수집 예외: ${msg}`);
      await finishRun(runId, { status: "failed", error: msg });
    }
  }

  // 2) 마켓 송장 전송
  if (!has("skip-ship")) {
    const { data: creds } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", userId).in("platform", ["coupang", "smartstore"]);
    for (const platform of ["coupang", "smartstore"] as SyncPlatform[]) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) { log(`${platform}: API 계정 없음 — 송장 전송 건너뜀`); continue; }
      try {
        const clients = platform === "coupang"
          ? { coupang: new CoupangOpenApiClient({ vendorId: cred.account_id, accessKey: decrypt(cred.access_key_encrypted), secretKey: decrypt(cred.secret_key_encrypted) }) }
          : { smartstore: new NaverCommerceApiClient({ clientId: decrypt(cred.client_id_encrypted), clientSecret: decrypt(cred.client_secret_encrypted) }) };
        const r = await shipOrders({ supabase: sb, userId, platform, credentialId: cred.id, trigger: "scheduler", ...clients });
        ships.push(r);
        log(`${platform} 송장: 대상 ${r.candidates} 전송 ${r.sent} 이미전송 ${r.alreadySent} 실패 ${r.failed} 제외 ${r.skipped.length}${r.dryRun ? " [DRY]" : ""}`);
        for (const row of r.rows.filter((x) => x.status === "failed")) log(`  x ${row.recipientName} · ${row.productName}: ${row.message}`);
        for (const s of r.skipped.slice(0, 10)) log(`  - 제외 ${s.order.recipient_name} · ${s.order.product_name}: ${s.reason}`);
        for (const e of r.errors) log(`  ! ${e}`);
      } catch (e) { log(`${platform} 송장 예외: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  // 3) ESM 운송장 엑셀
  if (!has("skip-esm")) {
    const runId = await startRun("esm-export");
    try {
      esm = await exportEsmTrackingExcel(sb, userId, { days, markExported: !dry });
      log(esm.count > 0 ? `ESM 운송장 ${esm.count}건 → ${esm.file}` : "ESM 운송장: 새 건 없음");
      await finishRun(runId, { status: "success", remote_count: esm.count, detail: { count: esm.count, file: esm.file ?? null } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`ESM 엑셀 예외: ${msg}`);
      await finishRun(runId, { status: "failed", error: msg });
    }
  }
} finally {
  releaseLock();
}

await notifyShipResults(ships, "scheduler", { collect, esm });
log("done");
process.exit(0);
