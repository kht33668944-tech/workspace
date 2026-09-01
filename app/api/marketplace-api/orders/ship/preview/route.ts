import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { fetchShipReadyOrders } from "@/lib/marketplace/order-ship";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";
import { isDryRun } from "@/lib/marketplace/common";

export const maxDuration = 60;

/** 송장 전송 미리보기: { orderIds?: string[], force?: boolean } → 플랫폼별 대상/제외 목록 (마켓 호출 없음) */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { orderIds?: string[]; force?: boolean };
    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;
    const orderIds = Array.isArray(body.orderIds) && body.orderIds.length > 0 ? body.orderIds : undefined;

    const { data: creds } = await supabase.from("marketplace_api_credentials").select("id,platform").in("platform", ["coupang", "smartstore"]);
    const out: Record<string, unknown> = { dryRun: isDryRun() };
    for (const platform of ["coupang", "smartstore"] as SyncPlatform[]) {
      const hasCred = (creds ?? []).some((c) => c.platform === platform);
      const { ready, skipped } = await fetchShipReadyOrders(supabase, userId, platform, { orderIds, force: body.force });
      out[platform] = { hasCredential: hasCred, ready, skipped: skipped.map((s) => ({ ...s.order, reason: s.reason })) };
    }
    return NextResponse.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ship-preview] 오류:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
