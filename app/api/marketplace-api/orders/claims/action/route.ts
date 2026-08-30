import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import { CLAIM_ACTION_LABEL, runClaimAction, type ClaimAction, type ClaimActionPayload } from "@/lib/marketplace/order-claims";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";
import { isDryRun } from "@/lib/marketplace/common";

export const maxDuration = 120;

/** 반품/교환 처리: { action, orderIds, payload? } */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const body = (await request.json()) as { action?: string; orderIds?: string[]; payload?: ClaimActionPayload };
    const action = body.action as ClaimAction;
    if (!action || !(action in CLAIM_ACTION_LABEL)) return NextResponse.json({ error: "알 수 없는 작업" }, { status: 400 });
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.filter(Boolean) : [];
    if (orderIds.length === 0) return NextResponse.json({ error: "주문을 선택하세요." }, { status: 400 });

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;

    const { data: rows } = await supabase.from("orders").select("id,marketplace").eq("user_id", userId).in("id", orderIds);
    const byPlatform: Record<SyncPlatform, string[]> = { coupang: [], smartstore: [] };
    for (const r of rows ?? []) {
      const m = r.marketplace ?? "";
      if (m.includes("쿠팡")) byPlatform.coupang.push(r.id);
      else if (m.includes("스마트스토어")) byPlatform.smartstore.push(r.id);
    }
    const { data: creds } = await supabase.from("marketplace_api_credentials").select("id,platform").in("platform", ["coupang", "smartstore"]);
    const results = [];
    for (const platform of ["coupang", "smartstore"] as SyncPlatform[]) {
      if (byPlatform[platform].length === 0) continue;
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) { results.push(...byPlatform[platform].map((id) => ({ orderId: id, recipientName: null, productName: null, status: "failed" as const, message: `${platform} API 계정 없음` }))); continue; }
      const clients = platform === "coupang"
        ? { coupang: (await getCoupangClientFromCredential(supabase, cred.id)).client }
        : { smartstore: (await getNaverClientFromCredential(supabase, cred.id)).client };
      results.push(...(await runClaimAction({ supabase, userId, credentialId: cred.id, platform, action, orderIds: byPlatform[platform], payload: body.payload, ...clients })));
    }
    return NextResponse.json({ dryRun: isDryRun(), results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[claims-action] 오류:", message);
    return NextResponse.json({ error: `클레임 처리 실패: ${message}` }, { status: 500 });
  }
}
