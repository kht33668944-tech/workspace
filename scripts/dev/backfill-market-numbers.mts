// 옛 플토 행에 마켓번호 백필 + (선택) 정산 반영
//   npx tsx scripts/dev/backfill-market-numbers.mts --days 35 [--settle]
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { backfillMarketplaceNumbers, type SyncPlatform } from "@/lib/marketplace/order-sync";
import { syncSettlements } from "@/lib/marketplace/settlement-sync";
const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const days = Number(opt("days", "35"));
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/).filter((l)=>/^[A-Z_]+=/.test(l)).map((l)=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).trim()];}));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k]=env[k];
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = env.SYNC_USER_ID;
const { data: creds } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", userId);
for (const platform of ["coupang", "smartstore"] as SyncPlatform[]) {
  const cred = creds?.find((c) => c.platform === platform);
  if (!cred) continue;
  const clients = platform === "coupang"
    ? { coupang: new CoupangOpenApiClient({ vendorId: cred.account_id, accessKey: decrypt(cred.access_key_encrypted), secretKey: decrypt(cred.secret_key_encrypted) }) }
    : { smartstore: new NaverCommerceApiClient({ clientId: decrypt(cred.client_id_encrypted), clientSecret: decrypt(cred.client_secret_encrypted) }) };
  const r = await backfillMarketplaceNumbers({ supabase: sb, userId, platform, credentialId: cred.id, days, ...clients });
  console.log(`[backfill ${platform}] remote=${r.remoteCount} linked=${r.alreadyLinked} filled=${r.filled} notFound=${r.notFound} errors=${r.errors.length}`, r.errors.slice(0, 3));
  if (argv.includes("--settle")) {
    const s = await syncSettlements({ supabase: sb, userId, platform, credentialId: cred.id, days, trigger: "manual", ...clients });
    console.log(`[settle ${platform}] ${s.from}~${s.to} rows=${s.remoteRows} matched=${s.matched} updated=${s.updated} unchanged=${s.unchanged} unmatched=${s.unmatched} errors=${s.errors.length}`, s.errors.slice(0, 3));
    for (const x of s.samples.slice(0, 8)) console.log(`   ${x.recipientName} · ${x.productName}: ${x.before} → ${x.after}`);
  }
}
process.exit(0);
