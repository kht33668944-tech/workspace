import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import {
  collectCoupangOrders,
  collectSmartstoreOrders,
  executeCancels,
  fetchCancelReadyOrders,
  matchOrders,
  type CancelPlatform,
} from "@/lib/marketplace/order-cancel";
import { isDryRun } from "@/lib/marketplace/common";

export const maxDuration = 300;

/**
 * 4~5단계. 서버에서 대조를 다시 수행하고, 클라이언트가 확인한 orderIds 에 포함된 건만 실행한다.
 */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = (await request.json()) as {
      credentialId?: string;
      platform?: CancelPlatform;
      orderIds?: string[];
      wingUserId?: string;
      detailedReason?: string;
    };
    if (!body.credentialId) return NextResponse.json({ error: "API 계정을 선택하세요." }, { status: 400 });
    if (body.platform !== "coupang" && body.platform !== "smartstore") {
      return NextResponse.json({ error: "지원하지 않는 판매처입니다." }, { status: 400 });
    }
    const orderIds = new Set(Array.isArray(body.orderIds) ? body.orderIds : []);
    if (orderIds.size === 0) return NextResponse.json({ error: "취소할 주문을 선택하세요." }, { status: 400 });
    if (body.platform === "coupang" && !body.wingUserId?.trim()) {
      return NextResponse.json({ error: "쿠팡윙 로그인 ID가 필요합니다." }, { status: 400 });
    }

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;

    const orders = await fetchCancelReadyOrders(supabase, userId, body.platform);
    const coupang = body.platform === "coupang" ? await getCoupangClientFromCredential(supabase, body.credentialId) : null;
    const naver = body.platform === "smartstore" ? await getNaverClientFromCredential(supabase, body.credentialId) : null;
    const remote = coupang ? await collectCoupangOrders(coupang.client) : await collectSmartstoreOrders(naver!.client);
    const preview = matchOrders(body.platform, orders, remote);
    const matches = preview.matched.filter((m) => orderIds.has(m.order.id));

    const results = await executeCancels({
      supabase,
      userId,
      credentialId: body.credentialId,
      platform: body.platform,
      matches,
      coupang: coupang ? { client: coupang.client, wingUserId: body.wingUserId!.trim() } : undefined,
      smartstore: naver ? { client: naver.client, detailedReason: body.detailedReason?.trim() || undefined } : undefined,
    });

    const successCount = results.filter((r) => r.status === "success" || r.status === "dry").length;
    console.log(`[order-cancel] ${body.platform} 실행: 요청 ${orderIds.size} / 실행 ${results.length} / 성공 ${successCount}`);
    return NextResponse.json({
      dryRun: isDryRun(),
      successCount,
      failCount: results.length - successCount,
      notMatched: [...orderIds].filter((id) => !matches.some((m) => m.order.id === id)).length,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[order-cancel] 실행 오류:", message);
    return NextResponse.json({ error: `취소 실행 실패: ${message}` }, { status: 500 });
  }
}
