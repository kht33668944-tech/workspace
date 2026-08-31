// 마켓 주문 자동 수집 (윈도우 작업 스케줄러에서 1시간마다 실행)
//
//   npx tsx scripts/marketplace-order-sync.mts --platform all --days 3 [--dry]
//
// - .env.local 의 SYNC_USER_ID(발주서 소유 사용자) 와 marketplace_api_credentials 의 키를 사용
// - --dry 또는 MARKETPLACE_API_DRY_RUN=true 면 마켓 쓰기(발주확인) 없이 조회·매핑만
// - 결과는 logs/order-sync.log 에 append, 신규/취소요청/오류가 있으면 디스코드 알림
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { syncOrders, type SyncPlatform, type SyncResult } from "@/lib/marketplace/order-sync";
import { notifySyncResults, notifyInquiryResults } from "@/lib/marketplace/order-sync-notify";
import { syncSettlements } from "@/lib/marketplace/settlement-sync";
import { sendDailySummary } from "@/lib/marketplace/daily-summary";
import { syncInquiries, type InquirySyncResult } from "@/lib/marketplace/inquiry-sync";
import { AUTOMATIONS, isOverdue, isStaleRunning } from "@/lib/automation-schedule";
import { notifyAutomationResult } from "@/lib/discord-notifier";
import { toKstDateKey } from "@/lib/date-utils";

const argv = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const platformArg = opt("platform", "all");
const days = Math.min(Math.max(Number(opt("days", "3")) || 3, 1), 31);
if (argv.includes("--dry")) process.env.MARKETPLACE_API_DRY_RUN = "true";

const envText = fs.readFileSync(".env.local", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k];

const logDir = path.resolve("logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "order-sync.log");
const log = (msg: string) => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); fs.appendFileSync(logFile, line + "\n"); };

const userId = env.SYNC_USER_ID;
if (!userId) { log("SYNC_USER_ID 가 .env.local 에 없다 — 발주서 소유 사용자 UUID를 넣어야 한다"); process.exit(1); }

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const platforms: SyncPlatform[] = platformArg === "coupang" || platformArg === "smartstore" ? [platformArg] : ["coupang", "smartstore"];

const { data: creds, error } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", userId).in("platform", platforms);
if (error) { log(`자격증명 조회 실패: ${error.message}`); process.exit(1); }

const makeClients = (platform: SyncPlatform, cred: { account_id: string; access_key_encrypted: string; secret_key_encrypted: string; client_id_encrypted: string; client_secret_encrypted: string }) =>
  platform === "coupang"
    ? { coupang: new CoupangOpenApiClient({ vendorId: cred.account_id, accessKey: decrypt(cred.access_key_encrypted), secretKey: decrypt(cred.secret_key_encrypted) }) }
    : { smartstore: new NaverCommerceApiClient({ clientId: decrypt(cred.client_id_encrypted), clientSecret: decrypt(cred.client_secret_encrypted) }) };

const results: SyncResult[] = [];
for (const platform of platforms) {
  const cred = (creds ?? []).find((c) => c.platform === platform);
  if (!cred) { log(`${platform}: API 계정 없음 — 건너뜀`); continue; }
  try {
    const clients = makeClients(platform, cred);
    const r = await syncOrders({ supabase: sb, userId, platform, credentialId: cred.id, days, trigger: "scheduler", ...clients });
    results.push(r);
    log(`${platform}: remote=${r.remoteCount} new=${r.newOrders.length} existing=${r.skippedExisting} confirmed=${r.confirmed}/${r.confirmFailed} claims=${JSON.stringify(r.claimCounts)} errors=${r.errors.length}${r.dryRun ? " [DRY]" : ""}`);
    for (const o of r.newOrders) log(`  + ${o.recipientName} · ${o.productName} x${o.quantity} ₩${o.revenue}`);
    for (const c of r.claims) log(`  ! ${c.recipientName} · ${c.productName}: ${c.from} → ${c.to} (${c.claimStatus})`);
    for (const e of [...r.errors, ...r.confirmErrors]) log(`  x ${e}`);
  } catch (err) {
    log(`${platform}: 예외 — ${err instanceof Error ? err.message : String(err)}`);
  }
}
// 미발송 주문(구매대기·확인·부분구매·발송불가·배송준비) 중 발송기한 임박(내일까지) — 알림으로 결정 촉구
let shipDeadline: Array<{ recipientName: string | null; productName: string | null; shipByDate: string }> = [];
try {
  const tomorrowKst = toKstDateKey(Date.now() + 86400000);
  const { data: holdRows } = await sb.from("orders")
    .select("recipient_name,product_name,ship_by_date")
    .eq("user_id", userId)
    .in("delivery_status", ["구매대기", "구매확인필요", "부분구매", "발송불가", "배송준비"])
    .is("tracking_no", null)
    .not("ship_by_date", "is", null).lte("ship_by_date", tomorrowKst);
  shipDeadline = (holdRows ?? []).map((r) => ({ recipientName: r.recipient_name, productName: r.product_name, shipByDate: r.ship_by_date }));
  if (shipDeadline.length > 0) log(`발송불가 발송기한 임박 ${shipDeadline.length}건 (≤${tomorrowKst})`);
} catch (e) { log(`발송기한 확인 실패: ${e instanceof Error ? e.message : String(e)}`); }

await notifySyncResults(results, "scheduler", { shipDeadline });

// 문의 동기화 — 새 문의는 AI 초안·단순건 자동답변 후 #문의-자동화 알림 (--skip-inquiries 로 생략)
if (!argv.includes("--skip-inquiries")) {
  const inquiryResults: InquirySyncResult[] = [];
  for (const platform of platforms) {
    const cred = (creds ?? []).find((c) => c.platform === platform);
    if (!cred) continue;
    try {
      const r = await syncInquiries({
        supabase: sb, userId, platform, credentialId: cred.id, days: 7, trigger: "scheduler",
        wingUserId: typeof cred.meta?.wingUserId === "string" ? cred.meta.wingUserId : null,
        ...makeClients(platform, cred),
      });
      inquiryResults.push(r);
      log(`${platform} 문의: remote=${r.remoteCount} new=${r.newInquiries.length} auto=${r.autoReplied.length} held=${r.heldForReview.length} answered+=${r.updatedAnswered} errors=${r.errors.length}`);
      for (const e of r.errors.slice(0, 3)) log(`  x ${e}`);
    } catch (err) { log(`${platform} 문의 예외: ${err instanceof Error ? err.message : String(err)}`); }
  }
  try { await notifyInquiryResults(inquiryResults, "scheduler"); }
  catch (e) { log(`문의 알림 실패: ${e instanceof Error ? e.message : String(e)}`); }
}

// 정산 반영 — 하루 1회 (오늘 kind=settlement 실행이 없을 때만)
if (!argv.includes("--skip-settlement") && !process.env.MARKETPLACE_API_DRY_RUN) {
  const todayKst = toKstDateKey();
  const { data: last } = await sb.from("marketplace_sync_runs").select("started_at").eq("user_id", userId).eq("kind", "settlement").order("started_at", { ascending: false }).limit(1).maybeSingle();
  const lastKst = last?.started_at ? toKstDateKey(new Date(last.started_at)) : null;
  if (lastKst !== todayKst) {
    for (const platform of platforms) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) continue;
      try {
        const clients = makeClients(platform, cred);
        const s = await syncSettlements({ supabase: sb, userId, platform, credentialId: cred.id, days: 35, trigger: "scheduler", ...clients });
        log(`${platform} 정산: ${s.from}~${s.to} rows=${s.remoteRows} matched=${s.matched} updated=${s.updated} unmatched=${s.unmatched} errors=${s.errors.length}`);
        for (const e of s.errors.slice(0, 3)) log(`  x ${e}`);
      } catch (err) { log(`${platform} 정산 예외: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
}
// 하루 요약 — KST 21시 이후 그날 첫 실행에서 1회 (#주문수집-자동화)
if (!argv.includes("--skip-summary") && !process.env.MARKETPLACE_API_DRY_RUN) {
  const kstNow = new Date(Date.now() + 9 * 3600000);
  const todayKst = toKstDateKey();
  if (kstNow.getUTCHours() >= 21) {
    const { data: last } = await sb.from("marketplace_sync_runs").select("started_at").eq("user_id", userId).eq("kind", "daily-summary").order("started_at", { ascending: false }).limit(1).maybeSingle();
    const lastKst = last?.started_at ? toKstDateKey(new Date(last.started_at)) : null;
    if (lastKst !== todayKst) {
      try {
        const s = await sendDailySummary(sb, userId);
        await sb.from("marketplace_sync_runs").insert({ user_id: userId, platform: "all", kind: "daily-summary", trigger: "scheduler", status: "success", finished_at: new Date().toISOString(), detail: s.total });
        log(`하루 요약 발송: 주문 ${s.total.count}건 순수익 ${Math.round(s.total.settlement - s.total.cost)}`);
      } catch (err) { log(`하루 요약 실패: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
}
// ── 헬스 체크: 다른 자동화(운송장·최저가)가 예정대로 돌았는지 감시 — 이상 시 디스코드 경고 1회/일
// PC가 꺼졌다 켜지면 이 크론(StartWhenAvailable)이 먼저 살아나 감지하는 구조
if (!argv.includes("--skip-health") && !process.env.MARKETPLACE_API_DRY_RUN) {
  try {
    const problems: string[] = [];

    // 1) 좀비 running 자동 정리 (최대 소요시간 + 15분 초과)
    const { data: runningRows } = await sb.from("marketplace_sync_runs")
      .select("*").eq("user_id", userId).eq("status", "running").neq("kind", "health-alert");
    for (const row of runningRows ?? []) {
      if (isStaleRunning(row)) {
        await sb.from("marketplace_sync_runs")
          .update({ status: "failed", finished_at: new Date().toISOString(), error: "헬스체크: 프로세스 중단 감지 (자동 정리)" })
          .eq("id", row.id);
        problems.push(`${row.kind} 작업이 중간에 멈췄습니다 (${new Date(row.started_at).toLocaleTimeString("ko-KR", { hour12: false })} 시작 후 응답 없음)`);
        log(`헬스체크: 좀비 정리 — kind=${row.kind} id=${row.id}`);
      }
    }

    // 2) 예정 주기 초과 미실행 감지 — 이 크론(OnliveOrderSync) 밖에서 도는 schtasks 자동화 전부
    for (const def of AUTOMATIONS.filter((d) => d.schedule.type === "interval" && d.runVia === "schtasks")) {
      const { data: lastRows } = await sb.from("marketplace_sync_runs")
        .select("started_at").eq("user_id", userId).eq("kind", def.primaryKind)
        .order("started_at", { ascending: false }).limit(1);
      const last = lastRows?.[0]?.started_at ?? null;
      if (isOverdue(def, last)) {
        const hours = last ? Math.round((Date.now() - new Date(last).getTime()) / 3600000) : null;
        problems.push(`${def.label} 자동화가 ${hours !== null ? `${hours}시간째` : "기록상 한 번도"} 실행되지 않았습니다 (주기 ${def.schedule.type === "interval" ? def.schedule.intervalHours : "?"}시간)`);
      }
    }

    if (problems.length > 0) {
      // 1일 1회 래치 (정산 래치와 동일 패턴)
      const todayKst = toKstDateKey();
      const { data: lastAlert } = await sb.from("marketplace_sync_runs").select("started_at").eq("user_id", userId).eq("kind", "health-alert").order("started_at", { ascending: false }).limit(1).maybeSingle();
      const lastAlertKst = lastAlert?.started_at ? toKstDateKey(new Date(lastAlert.started_at)) : null;
      if (lastAlertKst !== todayKst) {
        await notifyAutomationResult({
          channel: "default",
          title: "⚠️ 자동화 헬스 경고",
          status: "failed",
          summary: problems.map((p) => `• ${p}`).join("\n") + "\n\n작업 스케줄러와 PC 전원 상태를 확인하세요. 사이트 ▸ 자동화 페이지에서 즉시 실행할 수 있습니다.",
        });
        await sb.from("marketplace_sync_runs").insert({ user_id: userId, platform: "all", kind: "health-alert", trigger: "scheduler", status: "success", finished_at: new Date().toISOString(), detail: { problems } });
        log(`헬스체크: 경고 발송 — ${problems.length}건`);
      } else {
        log(`헬스체크: 이상 ${problems.length}건 (오늘 이미 경고함)`);
      }
    }
  } catch (e) { log(`헬스체크 실패: ${e instanceof Error ? e.message : String(e)}`); }
}

log("done");
