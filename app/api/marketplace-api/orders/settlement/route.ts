import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import { syncSettlements, type SettlementResult } from "@/lib/marketplace/settlement-sync";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";

export const maxDuration = 300;

/** 정산 반영: { platform?: "coupang"|"smartstore"|"all", days?: number } */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { platform?: string; days?: number };
    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;
    const platforms: SyncPlatform[] = body.platform === "coupang" || body.platform === "smartstore" ? [body.platform] : ["coupang", "smartstore"];
    const days = Math.min(Math.max(Number(body.days) || 35, 1), 120);

    const { data: creds } = await supabase.from("marketplace_api_credentials").select("id,platform").in("platform", platforms);
    const results: SettlementResult[] = [];
    for (const platform of platforms) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) continue;
      const clients = platform === "coupang"
        ? { coupang: (await getCoupangClientFromCredential(supabase, cred.id)).client }
        : { smartstore: (await getNaverClientFromCredential(supabase, cred.id)).client };
      results.push(await syncSettlements({ supabase, userId, platform, credentialId: cred.id, days, trigger: "manual", ...clients }));
    }
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[settlement] 오류:", message);
    return NextResponse.json({ error: `정산 반영 실패: ${message}` }, { status: 500 });
  }
}
