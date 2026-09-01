import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import {
  collectCoupangOrders,
  collectSmartstoreOrders,
  fetchCancelReadyOrders,
  matchOrders,
  type CancelPlatform,
} from "@/lib/marketplace/order-cancel";
import { isDryRun } from "@/lib/marketplace/common";

export const maxDuration = 300;

/** 1~3단계: 발주서 추출 → 마켓 주문 수집 → 대조. 외부 쓰기 없음. */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = (await request.json()) as { credentialId?: string; platform?: CancelPlatform; orderIds?: string[] };
    if (!body.credentialId) return NextResponse.json({ error: "API 계정을 선택하세요." }, { status: 400 });
    if (body.platform !== "coupang" && body.platform !== "smartstore") {
      return NextResponse.json({ error: "지원하지 않는 판매처입니다." }, { status: 400 });
    }

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

    const { orders, notReady } = await fetchCancelReadyOrders(supabase, userData.user.id, body.platform, Array.isArray(body.orderIds) ? body.orderIds : undefined);
    if (orders.length === 0) {
      return NextResponse.json({ platform: body.platform, matched: [], skipped: notReady, remoteCount: 0, dryRun: isDryRun() });
    }

    const remote =
      body.platform === "coupang"
        ? await collectCoupangOrders((await getCoupangClientFromCredential(supabase, body.credentialId)).client)
        : await collectSmartstoreOrders((await getNaverClientFromCredential(supabase, body.credentialId)).client);

    const preview = matchOrders(body.platform, orders, remote);
    console.log(`[order-cancel] ${body.platform} 미리보기: 대상 ${orders.length} / 마켓 ${remote.length} / 매칭 ${preview.matched.length} / 제외 ${preview.skipped.length}`);
    return NextResponse.json({ ...preview, skipped: [...notReady, ...preview.skipped], dryRun: isDryRun() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[order-cancel] 미리보기 오류:", message);
    return NextResponse.json({ error: `취소 미리보기 실패: ${message}` }, { status: 500 });
  }
}
