import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import type { BulkUpdateTrackingRequest } from "@/lib/scrapers/types";
import { applyTrackingToOrders } from "@/lib/tracking/apply";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const token = getAccessToken(request);
    if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    const supabase = getSupabaseClient(token);

    const body = (await request.json()) as BulkUpdateTrackingRequest;

    if (!body.updates || body.updates.length === 0) {
      return NextResponse.json({ error: "업데이트할 데이터가 없습니다." }, { status: 400 });
    }

    const { data: userData } = await supabase.auth.getUser();
    const applied = await applyTrackingToOrders(supabase, body.updates, userData.user?.id);
    const { successCount, failCount, errors } = applied;

    console.log("[bulk-update] 결과:", { successCount, failCount, errors: errors.slice(0, 5) });
    return NextResponse.json({ successCount, failCount, errors });
  } catch (err) {
    return NextResponse.json(
      { error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
