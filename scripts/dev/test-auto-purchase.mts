// 자동구매 stage 실검증 — 선택한 orderIds 만 실제 구매 (dryRun 인자로 미리보기 가능)
//   npx tsx scripts/dev/test-auto-purchase.mts <dry|run> <orderId> [orderId...]
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { runAutoPurchaseStage } from "@/lib/marketplace/auto-purchase-stage";
import { getAppSetting, setAppSetting, type AutoPurchaseSetting } from "@/lib/app-settings";
import { getAutomationSession, ensureServer, resolveBaseUrl } from "../lib/automation-auth.mjs";

const envText = fs.readFileSync(".env.local", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k];

const mode = process.argv[2];
const orderIds = process.argv.slice(3);
if (mode !== "dry" && mode !== "run") { console.error("사용법: test-auto-purchase.mts <dry|run> <orderId...>"); process.exit(1); }
if (orderIds.length === 0) { console.error("orderId 를 1개 이상 지정하세요"); process.exit(1); }

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const baseUrl = resolveBaseUrl(env);
await ensureServer(baseUrl, (m) => console.log(`[server] ${m}`));
const session = await getAutomationSession(env, (m) => console.log(`[auth] ${m}`));

// 테스트 동안만 auto_purchase 설정을 임시로 켠다 (계정은 유지). 끝나면 원래 값 복원.
const prev = await getAppSetting<AutoPurchaseSetting>(sb, env.SYNC_USER_ID!, "auto_purchase");
const account = prev?.accounts?.gmarket || "joker3733";
await setAppSetting(sb, env.SYNC_USER_ID!, "auto_purchase", { enabled: true, accounts: { ...(prev?.accounts ?? {}), gmarket: account } });
console.log(`[setting] auto_purchase 임시 ON (계정 ${account}) — 종료 시 원복`);

// SIGTERM/SIGINT(타임아웃·Ctrl+C)로 죽어도 설정을 원복 (finally 는 강제 kill 시 실행 안 될 수 있음)
const restoreOnSignal = async () => {
  try { await setAppSetting(sb, env.SYNC_USER_ID!, "auto_purchase", prev ?? { enabled: false, accounts: {} }); } catch {}
  process.exit(130);
};
process.on("SIGTERM", restoreOnSignal);
process.on("SIGINT", restoreOnSignal);

try {
  console.log(`\n=== 자동구매 stage ${mode.toUpperCase()} — ${orderIds.length}건 ===`);
  const r = await runAutoPurchaseStage({
    supabase: sb, userId: env.SYNC_USER_ID!, baseUrl, token: session.token,
    paymentPin: env.GMARKET_PAYMENT_PIN ?? null,
    dryRun: mode === "dry", trigger: "manual", orderIds,
    log: (m) => console.log(`  ${m}`),
  });
  console.log("\n=== 결과:", JSON.stringify({ purchased: r.purchased, purchaseFailed: r.purchaseFailed, skipped: r.skipped, wouldPurchase: r.wouldPurchase, errors: r.errors }, null, 2));
} finally {
  await setAppSetting(sb, env.SYNC_USER_ID!, "auto_purchase", prev ?? { enabled: false, accounts: {} });
  console.log(`[setting] auto_purchase 원복 (enabled=${prev?.enabled ?? false})`);
}
process.exit(0);
