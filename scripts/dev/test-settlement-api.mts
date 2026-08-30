// 정산 API 읽기 테스트 (쓰기 없음): 쿠팡 revenue-history / 스토어 settle/case 응답 형태 확인
//   npx tsx scripts/dev/test-settlement-api.mts [--days 14]
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const days = Number(opt("days", "14"));
const envText = fs.readFileSync(".env.local", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k];
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: creds } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", env.SYNC_USER_ID);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date(to.getTime() - days * 86400000);

const cp = creds?.find((c) => c.platform === "coupang");
if (cp) {
  const c = new CoupangOpenApiClient({ vendorId: cp.account_id, accessKey: decrypt(cp.access_key_encrypted), secretKey: decrypt(cp.secret_key_encrypted) });
  const res = await c.listRevenueHistory({ recognitionDateFrom: ymd(from), recognitionDateTo: ymd(new Date(to.getTime() - 86400000)), maxPerPage: 5 });
  console.log("[coupang revenue-history]", res.status, res.message);
  console.log(JSON.stringify(res.body, null, 1).slice(0, 3000));
}
const ss = creds?.find((c) => c.platform === "smartstore");
if (ss) {
  const n = new NaverCommerceApiClient({ clientId: decrypt(ss.client_id_encrypted), clientSecret: decrypt(ss.client_secret_encrypted) });
  for (let d = 0; d < days; d++) {
    const day = new Date(to.getTime() - d * 86400000);
    const res = await n.getSettleByCase({ searchDate: ymd(day), periodType: "SETTLE_CASEBYCASE_SETTLE_BASIS_DATE", pageNumber: 1, pageSize: 5 });
    const body = res.body as { elements?: unknown[] } | string | null;
    const n2 = body && typeof body === "object" ? (body.elements?.length ?? 0) : 0;
    console.log(`[naver settle/case ${ymd(day)}]`, res.status, res.message, "elements:", n2);
    if (n2 > 0) { console.log(JSON.stringify(body, null, 1).slice(0, 2500)); break; }
    await new Promise((r) => setTimeout(r, 600));
  }
}
process.exit(0);
