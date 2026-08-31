import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import { syncInquiries, type InquirySyncResult } from "@/lib/marketplace/inquiry-sync";
import { notifyInquiryResults } from "@/lib/marketplace/order-sync-notify";
import type { SyncPlatform } from "@/lib/marketplace/order-sync";

export const maxDuration = 300;

/** 수동 문의 동기화: { platform?: "coupang"|"smartstore"|"all" } */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = (await request.json().catch(() => ({}))) as { platform?: SyncPlatform | "all" };
    const platforms: SyncPlatform[] = body.platform === "coupang" || body.platform === "smartstore" ? [body.platform] : ["coupang", "smartstore"];

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;

    const { data: creds } = await supabase.from("marketplace_api_credentials").select("id,platform,meta").in("platform", platforms);
    const results: InquirySyncResult[] = [];
    for (const platform of platforms) {
      const cred = (creds ?? []).find((c) => c.platform === platform);
      if (!cred) continue;
      const clients = platform === "coupang"
        ? { coupang: (await getCoupangClientFromCredential(supabase, cred.id)).client }
        : { smartstore: (await getNaverClientFromCredential(supabase, cred.id)).client };
      const wingUserId = typeof (cred.meta as Record<string, unknown> | null)?.wingUserId === "string"
        ? (cred.meta as Record<string, string>).wingUserId
        : null;
      const r = await syncInquiries({ supabase, userId, platform, credentialId: cred.id, days: 7, trigger: "manual", wingUserId, ...clients });
      results.push(r);
      console.log(`[inquiry-sync] ${platform}: remote=${r.remoteCount} new=${r.newInquiries.length} auto=${r.autoReplied.length} held=${r.heldForReview.length} errors=${r.errors.length}`);
    }
    notifyInquiryResults(results, "manual").catch(() => {});
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[inquiry-sync] 오류:", message);
    return NextResponse.json({ error: `문의 동기화 실패: ${message}` }, { status: 500 });
  }
}
