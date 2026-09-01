import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import { shipOrders, type ShipResult } from "@/lib/marketplace/order-ship";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";
import { notifyShipResults } from "@/lib/marketplace/order-sync-notify";
import { isDryRun } from "@/lib/marketplace/common";

export const maxDuration = 300;

/** 송장 전송 실행: { orderIds?: string[], force?: boolean, platform?: "coupang"|"smartstore"|"all" } */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { orderIds?: string[]; force?: boolean; platform?: string };
    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;
    const orderIds = Array.isArray(body.orderIds) && body.orderIds.length > 0 ? body.orderIds : undefined;
    const platforms: SyncPlatform[] = body.platform === "coupang" || body.platform === "smartstore" ? [body.platform] : ["coupang", "smartstore"];

    const { data: creds } = await supabase.from("marketplace_api_credentials").select("id,platform").in("platform", platforms);
    const results: ShipResult[] = [];
    for (const platform of platforms) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) continue;
      const clients = platform === "coupang"
        ? { coupang: (await getCoupangClientFromCredential(supabase, cred.id)).client }
        : { smartstore: (await getNaverClientFromCredential(supabase, cred.id)).client };
      results.push(await shipOrders({ supabase, userId, platform, credentialId: cred.id, orderIds, force: body.force, trigger: "manual", ...clients }));
    }
    await notifyShipResults(results, "manual");
    return NextResponse.json({ dryRun: isDryRun(), results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ship-apply] 오류:", message);
    return NextResponse.json({ error: `송장 전송 실패: ${message}` }, { status: 500 });
  }
}
