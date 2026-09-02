import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import { syncOrders, type SyncPlatform, type SyncResult } from "@/lib/marketplace/order-sync";
import { notifySyncResults } from "@/lib/marketplace/order-sync-notify";
import type { MarketplaceSyncRun } from "@/types/database";

export const maxDuration = 300;

/** 최근 실행 이력 */
export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("marketplace_sync_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(Number(request.nextUrl.searchParams.get("limit") ?? 10) || 10);
  if (error) return NextResponse.json({ error: "이력 조회 실패" }, { status: 500 });
  return NextResponse.json((data ?? []) as MarketplaceSyncRun[]);
}

/** 수동 주문 수집: { platform: "coupang"|"smartstore"|"all", days?: number } */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = (await request.json().catch(() => ({}))) as { platform?: SyncPlatform | "all"; days?: number };
    const platforms: SyncPlatform[] = body.platform === "coupang" || body.platform === "smartstore" ? [body.platform] : ["coupang", "smartstore"];
    const days = Math.min(Math.max(Number(body.days ?? 3) || 3, 1), 31);

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;

    const { data: creds } = await supabase.from("marketplace_api_credentials").select("id,platform").in("platform", platforms);
    const results: SyncResult[] = [];
    for (const platform of platforms) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) {
        results.push({ platform, dryRun: false, remoteCount: 0, newOrders: [], skippedExisting: 0, confirmed: 0, confirmFailed: 0, confirmErrors: [], claims: [], claimCounts: {}, autoApproved: [], addressChanges: [], errors: [`${platform} API 계정이 등록되지 않음`], runId: null });
        continue;
      }
      const clients = platform === "coupang"
        ? { coupang: (await getCoupangClientFromCredential(supabase, cred.id)).client }
        : { smartstore: (await getNaverClientFromCredential(supabase, cred.id)).client };
      const r = await syncOrders({ supabase, userId, platform, credentialId: cred.id, days, trigger: "manual", ...clients });
      results.push(r);
      console.log(`[order-sync] ${platform}: remote=${r.remoteCount} new=${r.newOrders.length} confirmed=${r.confirmed} claims=${r.claims.length} errors=${r.errors.length}`);
    }
    notifySyncResults(results, "manual").catch(() => {});
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[order-sync] 오류:", message);
    return NextResponse.json({ error: `주문 수집 실패: ${message}` }, { status: 500 });
  }
}
