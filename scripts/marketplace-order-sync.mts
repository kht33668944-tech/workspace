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
import { notifySyncResults } from "@/lib/marketplace/order-sync-notify";
import { syncSettlements } from "@/lib/marketplace/settlement-sync";

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

const results: SyncResult[] = [];
for (const platform of platforms) {
  const cred = (creds ?? []).find((c) => c.platform === platform);
  if (!cred) { log(`${platform}: API 계정 없음 — 건너뜀`); continue; }
  try {
    const clients = platform === "coupang"
      ? { coupang: new CoupangOpenApiClient({ vendorId: cred.account_id, accessKey: decrypt(cred.access_key_encrypted), secretKey: decrypt(cred.secret_key_encrypted) }) }
      : { smartstore: new NaverCommerceApiClient({ clientId: decrypt(cred.client_id_encrypted), clientSecret: decrypt(cred.client_secret_encrypted) }) };
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
await notifySyncResults(results, "scheduler");

// 정산 반영 — 하루 1회 (오늘 kind=settlement 실행이 없을 때만)
if (!argv.includes("--skip-settlement") && !process.env.MARKETPLACE_API_DRY_RUN) {
  const todayKst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const { data: last } = await sb.from("marketplace_sync_runs").select("started_at").eq("user_id", userId).eq("kind", "settlement").order("started_at", { ascending: false }).limit(1).maybeSingle();
  const lastKst = last?.started_at ? new Date(new Date(last.started_at).getTime() + 9 * 3600000).toISOString().slice(0, 10) : null;
  if (lastKst !== todayKst) {
    for (const platform of platforms) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) continue;
      try {
        const clients = platform === "coupang"
          ? { coupang: new CoupangOpenApiClient({ vendorId: cred.account_id, accessKey: decrypt(cred.access_key_encrypted), secretKey: decrypt(cred.secret_key_encrypted) }) }
          : { smartstore: new NaverCommerceApiClient({ clientId: decrypt(cred.client_id_encrypted), clientSecret: decrypt(cred.client_secret_encrypted) }) };
        const s = await syncSettlements({ supabase: sb, userId, platform, credentialId: cred.id, days: 35, trigger: "scheduler", ...clients });
        log(`${platform} 정산: ${s.from}~${s.to} rows=${s.remoteRows} matched=${s.matched} updated=${s.updated} unmatched=${s.unmatched} errors=${s.errors.length}`);
        for (const e of s.errors.slice(0, 3)) log(`  x ${e}`);
      } catch (err) { log(`${platform} 정산 예외: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
}
log("done");
