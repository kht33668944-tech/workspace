// 하루 요약을 지금 바로 보낸다 (테스트/수동):  npx tsx scripts/dev/send-daily-summary.mts [--date 2026-08-30]
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { sendDailySummary } from "@/lib/marketplace/daily-summary";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/).filter((l)=>/^[A-Z_]+=/.test(l)).map((l)=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).trim()];}));
for (const k of Object.keys(env)) process.env[k]=env[k];
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const i = process.argv.indexOf("--date");
const s = await sendDailySummary(sb, env.SYNC_USER_ID, i > 0 ? new Date(`${process.argv[i + 1]}T12:00:00+09:00`) : new Date());
console.log(s.title + "\n" + s.summary);
process.exit(0);
