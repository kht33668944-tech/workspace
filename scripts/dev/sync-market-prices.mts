// 상품목록 기준으로 쿠팡·스토어 가격/판매상태 전체 동기화 (등록완료·판매중지 대상, 판매종료 제외)
//   npx tsx scripts/dev/sync-market-prices.mts [--platform coupang|smartstore|all] [--dry]
//   - 가격: 우리 계산가 ≠ 마켓 현재가(라이브) 인 상품만 변경
//   - 품절(마진 35%): 마켓 판매중지
//   - 재개는 보내지 않음 (자동 갱신이 재입고 시 처리)
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { buildCoupangPreview, buildSmartstorePreview } from "@/lib/marketplace-api-helpers";
import { logMarketplaceApi, sleep } from "@/lib/marketplace/common";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const platformArg = opt("platform", "all");
const DRY = argv.includes("--dry");
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/).filter((l)=>/^[A-Z_]+=/.test(l)).map((l)=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).trim()];}));
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k]=env[k];
if (DRY) process.env.MARKETPLACE_API_DRY_RUN = "true";
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = env.SYNC_USER_ID;

const { data: prods } = await sb.from("products").select("id,product_name,margin_rate,registration_status").eq("user_id", userId).in("registration_status", ["등록완료", "판매중지"]).limit(5000);
const all = prods ?? [];
const soldOutIds = new Set(all.filter((p) => p.margin_rate === 35).map((p) => p.id));
const priceIds = all.filter((p) => p.margin_rate !== 35).map((p) => p.id);
console.log(`대상 ${all.length}개 (가격 ${priceIds.length} · 품절→판매중지 ${soldOutIds.size})${DRY ? " [DRY]" : ""}`);
const { data: creds } = await sb.from("marketplace_api_credentials").select("*").eq("user_id", userId);

if (platformArg === "all" || platformArg === "coupang") {
  const cp = creds?.find((c) => c.platform === "coupang");
  if (cp) {
    const c = new CoupangOpenApiClient({ vendorId: cp.account_id, accessKey: decrypt(cp.access_key_encrypted), secretKey: decrypt(cp.secret_key_encrypted) });
    const pv = await buildCoupangPreview(sb, priceIds, "price");
    let changed = 0, same = 0, failed = 0; const fails: string[] = [];
    for (const it of pv.items) {
      const live = await c.request<{ data?: { salePrice?: number } }>("GET", `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/inventories`);
      const livePrice = (!live.ok || !live.body || typeof live.body === "string") ? null : live.body.data?.salePrice;
      await sleep(220);
      if (livePrice != null && Number(livePrice) === Number(it.newValue)) { same++; continue; }
      const res = await c.changePrice(it.vendorItemId, Number(it.newValue));
      await sleep(220);
      const ok = res.ok;
      if (ok) changed++; else { failed++; if (fails.length < 8) fails.push(`${it.productName.slice(0, 30)}: ${res.message}`); }
      // 쿠팡 테이블에는 api_synced_at 컬럼이 없다 (스마트스토어 전용) — 넣으면 update 전체가 400으로 무효화된다
      if (ok && !res.dryRun) {
        const { error: cacheErr } = await sb.from("coupang_price_inventory").update({ sale_price: Number(it.newValue) }).eq("option_id", it.vendorItemId);
        if (cacheErr) console.error("[sync-market-prices] 쿠팡 캐시 갱신 실패:", cacheErr.message);
      }
      await logMarketplaceApi(sb, { user_id: userId, platform: "coupang", credential_id: cp.id, action: res.dryRun ? "price:dry" : "price", status: ok ? "success" : "failed", product_id: it.productId, product_name: it.productName, vendor_item_id: it.vendorItemId, previous_value: livePrice != null ? String(livePrice) : it.previousValue, new_value: it.newValue, error_message: ok ? null : res.message });
    }
    let stopped = 0, stopFailed = 0;
    const sv = await buildCoupangPreview(sb, [...soldOutIds], "stop");
    for (const it of sv.items) {
      const res = await c.stopSale(it.vendorItemId);
      await sleep(220);
      if (res.ok) {
        stopped++;
        if (!res.dryRun) {
          const { error: cacheErr } = await sb.from("coupang_price_inventory").update({ sale_status: "판매중지" }).eq("option_id", it.vendorItemId);
          if (cacheErr) console.error("[sync-market-prices] 쿠팡 캐시 갱신 실패:", cacheErr.message);
        }
      } else stopFailed++;
      await logMarketplaceApi(sb, { user_id: userId, platform: "coupang", credential_id: cp.id, action: res.dryRun ? "stop:dry" : "stop", status: res.ok ? "success" : "failed", product_id: it.productId, product_name: it.productName, vendor_item_id: it.vendorItemId, previous_value: it.previousValue, new_value: "판매중지", error_message: res.ok ? null : res.message });
    }
    console.log(`[쿠팡] 가격 변경 ${changed} · 이미 같음 ${same} · 실패 ${failed} · 미연동 ${pv.blocked.length} | 판매중지 ${stopped} (실패 ${stopFailed}, 미연동 ${sv.blocked.length})`);
    for (const f of fails) console.log("  x", f);
  }
}

if (platformArg === "all" || platformArg === "smartstore") {
  const ss = creds?.find((c) => c.platform === "smartstore");
  if (ss) {
    const n = new NaverCommerceApiClient({ clientId: decrypt(ss.client_id_encrypted), clientSecret: decrypt(ss.client_secret_encrypted) });
    const liveAll = await n.searchAllProducts();
    const byOrigin = new Map(liveAll.map((p) => [String(p.originProductNo), p]));
    const pv = await buildSmartstorePreview(sb, priceIds, "price");
    let changed = 0, same = 0, failed = 0; const fails: string[] = [];
    for (const it of pv.items) {
      const live = byOrigin.get(String(it.originProductNo));
      if (live && Number(live.salePrice) === Number(it.newValue)) { same++; continue; }
      const res = await n.patchOriginProduct(it.originProductNo, (op) => { op.originProduct.salePrice = Number(it.newValue); });
      await sleep(600);
      const ok = res.ok;
      if (ok) changed++; else { failed++; if (fails.length < 8) fails.push(`${it.productName.slice(0, 30)}: ${res.message}`); }
      if (ok && !res.dryRun) await sb.from("smartstore_price_inventory").update({ sale_price: Number(it.newValue), api_synced_at: new Date().toISOString() }).eq("origin_product_no", it.originProductNo);
      await logMarketplaceApi(sb, { user_id: userId, platform: "smartstore", credential_id: ss.id, action: res.dryRun ? "price:dry" : "price", status: ok ? "success" : "failed", product_id: it.productId, product_name: it.productName, target_id: it.originProductNo, previous_value: live ? String(live.salePrice) : it.previousValue, new_value: it.newValue, error_message: ok ? null : res.message });
    }
    let stopped = 0, stopFailed = 0;
    const sv = await buildSmartstorePreview(sb, [...soldOutIds], "stop");
    for (const it of sv.items) {
      const live = byOrigin.get(String(it.originProductNo));
      if (live && live.statusType !== "SALE") { stopped++; continue; }
      const res = await n.changeProductStatus(it.originProductNo, "SUSPENSION");
      await sleep(600);
      if (res.ok) { stopped++; if (!res.dryRun) await sb.from("smartstore_price_inventory").update({ product_status: "SUSPENSION", api_synced_at: new Date().toISOString() }).eq("origin_product_no", it.originProductNo); } else stopFailed++;
      await logMarketplaceApi(sb, { user_id: userId, platform: "smartstore", credential_id: ss.id, action: res.dryRun ? "stop:dry" : "stop", status: res.ok ? "success" : "failed", product_id: it.productId, product_name: it.productName, target_id: it.originProductNo, previous_value: it.previousValue, new_value: "판매중지", error_message: res.ok ? null : res.message });
    }
    console.log(`[스토어] 가격 변경 ${changed} · 이미 같음 ${same} · 실패 ${failed} · 미연동 ${pv.blocked.length} | 판매중지 ${stopped} (실패 ${stopFailed}, 미연동 ${sv.blocked.length})`);
    for (const f of fails) console.log("  x", f);
  }
}
process.exit(0);
