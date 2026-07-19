import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getServiceSupabaseClient, getSupabaseClient } from "@/lib/api-helpers";
import {
  cancelPurchaseOrders,
  PURCHASE_CANCEL_MODES,
  PURCHASE_CANCEL_REASONS,
  PurchaseCancellationError,
  type PurchaseCancelMode,
  type PurchaseCancelReason,
} from "@/lib/purchase-cancellation";

export const revalidate = 0;

type CancelPurchaseBody = {
  orderIds?: unknown;
  mode?: unknown;
  reason?: unknown;
};

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = await request.json() as CancelPurchaseBody;
    const orderIds = Array.isArray(body.orderIds)
      ? body.orderIds.filter((id): id is string => typeof id === "string")
      : [];
    const mode = body.mode;
    const reason = body.reason;

    if (!PURCHASE_CANCEL_MODES.includes(mode as PurchaseCancelMode)) {
      return NextResponse.json({ error: "구매 상태를 선택해주세요." }, { status: 400 });
    }
    if (!PURCHASE_CANCEL_REASONS.includes(reason as PurchaseCancelReason)) {
      return NextResponse.json({ error: "취소 사유를 선택해주세요." }, { status: 400 });
    }

    const userSupabase = getSupabaseClient(token);
    const { data: { user }, error: userError } = await userSupabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

    const result = await cancelPurchaseOrders(
      getServiceSupabaseClient(),
      user.id,
      orderIds,
      mode as PurchaseCancelMode,
      reason as PurchaseCancelReason,
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof PurchaseCancellationError) {
      return NextResponse.json(
        { error: error.message, details: error.details ?? [] },
        { status: error.statusCode },
      );
    }
    console.error("[cancel-purchase] 처리 실패:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "구매취소/정리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
