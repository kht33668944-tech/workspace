// 등록완료 상품의 우리 계산 판매가 vs 마켓 실제 판매가 대조 (읽기 전용)
//   npx tsx scripts/dev/check-market-prices.mts [--live-limit 300]
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { buildCoupangPreview, buildSmartstorePreview } from "@/lib/marketplace-api-helpers";
import { sleep } from "@/lib/marketplace/common";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const liveLimit = Number(opt("live-limit", "300"));
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/).filter((l)=>/^[A-Z_]+=/.test(l)).map((l)=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).trim()];}));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k]=env[k];
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = env.SYNC_USER_ID;

const { data: prods } = await sb.from("products").select("id,product_name").eq("user_id", userId).eq("registration_status", "등록완료").limit(5000);
const ids = (prods ?? []).map((p) => p.id);
console.log(`등록완료 상품 ${ids.length}개`);
const { data: creds } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", userId);

// ── 쿠팡
{
  const pv = await buildCoupangPreview(sb, ids, "price");
  const diff = pv.items.filter((i) => i.previousValue == null || Number(i.previousValue) !== Number(i.newValue));
  console.log(`\n[쿠팡] 연동 ${pv.items.length}개 · 미연동/제외 ${pv.blocked.length}개 · 캐시 기준 불일치 ${diff.length}개`);
  const cp = creds?.find((c) => c.platform === "coupang");
  if (cp && diff.length > 0) {
    const c = new CoupangOpenApiClient({ vendorId: cp.account_id, accessKey: decrypt(cp.access_key_encrypted), secretKey: decrypt(cp.secret_key_encrypted) });
    let realDiff = 0, same = 0, fail = 0; const samples: string[] = [];
    for (const it of diff.slice(0, liveLimit)) {
      const res = await c.request<{ data?: { salePrice?: number; onSale?: boolean; amountInStock?: number } }>("GET", `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/inventories`);
      const live = (!res.ok || !res.body || typeof res.body === "string") ? null : res.body.data;
      if (!live) { fail++; continue; }
      if (Number(live.salePrice) === Number(it.newValue)) same++;
      else { realDiff++; if (samples.length < 12) samples.push(`  ${it.productName.slice(0, 34)} | 마켓 ${live.salePrice}${live.onSale === false ? "(중지)" : ""} → 계산 ${it.newValue}`); }
      await sleep(220);
    }
    console.log(`  라이브 확인 ${Math.min(diff.length, liveLimit)}개: 실제 다름 ${realDiff} · 같음(캐시만 옛값) ${same} · 조회실패 ${fail}`);
    for (const s of samples) console.log(s);
  }
}

// ── 스마트스토어
{
  const pv = await buildSmartstorePreview(sb, ids, "price");
  const diff = pv.items.filter((i) => i.previousValue == null || Number(i.previousValue) !== Number(i.newValue));
  console.log(`\n[스토어] 연동 ${pv.items.length}개 · 미연동/제외 ${pv.blocked.length}개 · 캐시 기준 불일치 ${diff.length}개`);
  const ss = creds?.find((c) => c.platform === "smartstore");
  if (ss && pv.items.length > 0) {
    const n = new NaverCommerceApiClient({ clientId: decrypt(ss.client_id_encrypted), clientSecret: decrypt(ss.client_secret_encrypted) });
    const all = await n.searchAllProducts();
    const byOrigin = new Map(all.map((p) => [String(p.originProductNo), p]));
    let realDiff = 0, same = 0, miss = 0; const samples: string[] = [];
    for (const it of pv.items) {
      const live = byOrigin.get(String(it.originProductNo));
      if (!live) { miss++; continue; }
      if (Number(live.salePrice) === Number(it.newValue)) same++;
      else { realDiff++; if (samples.length < 12) samples.push(`  ${it.productName.slice(0, 34)} | 마켓 ${live.salePrice}${live.statusType !== "SALE" ? `(${live.statusType})` : ""} → 계산 ${it.newValue}`); }
    }
    console.log(`  라이브 확인 ${pv.items.length}개: 실제 다름 ${realDiff} · 같음 ${same} · 마켓에 없음 ${miss}`);
    for (const s of samples) console.log(s);
  }
}
process.exit(0);
