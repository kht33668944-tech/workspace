import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getServiceSupabaseClient, getSupabaseClient } from "@/lib/api-helpers";
import {
  cancelPurchaseOrders,
  PurchaseCancellationError,
} from "@/lib/purchase-cancellation";

export const revalidate = 0;

type ClearDuplicateBody = {
  orderId?: string;
};

// 기존 단건 버튼과의 호환용입니다. 구매로그를 삭제하지 않고 취소 상태로 보관합니다.
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = await request.json() as ClearDuplicateBody;
    const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
    if (!orderId) return NextResponse.json({ error: "주문 ID가 필요합니다." }, { status: 400 });

    const userSupabase = getSupabaseClient(token);
    const { data: { user }, error: userError } = await userSupabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

    const result = await cancelPurchaseOrders(
      getServiceSupabaseClient(),
      user.id,
      [orderId],
      "purchased_cancelled",
      "기타",
    );

    return NextResponse.json({
      ok: true,
      cancelledLogCount: result.cancelledLogCount,
      targetStatus: result.targetStatus,
    });
  } catch (error) {
    if (error instanceof PurchaseCancellationError) {
      return NextResponse.json(
        { error: error.message, details: error.details ?? [] },
        { status: error.statusCode },
      );
    }
    console.error("[clear-purchase-duplicate] 처리 실패:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "중복구매 의심 정리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
