import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getServiceSupabaseClient, getSupabaseClient } from "@/lib/api-helpers";

export const revalidate = 0;

type ClearDuplicateBody = {
  orderId?: string;
};

const BLOCKED_STATUSES = new Set(["배송완료", "반품완료", "교환완료", "취소완료"]);

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = await request.json() as ClearDuplicateBody;
    const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
    if (!orderId) {
      return NextResponse.json({ error: "주문 ID가 필요합니다." }, { status: 400 });
    }

    const userSupabase = getSupabaseClient(token);
    const { data: { user }, error: userErr } = await userSupabase.auth.getUser();
    if (userErr || !user) {
      return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    }

    const supabase = getServiceSupabaseClient();
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, delivery_status, tracking_no")
      .eq("id", orderId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (orderErr) {
      console.error("[clear-purchase-duplicate] 주문 조회 실패:", orderErr.message);
      return NextResponse.json({ error: orderErr.message }, { status: 500 });
    }
    if (!order) {
      return NextResponse.json({ error: "주문을 찾을 수 없습니다." }, { status: 404 });
    }

    const trackingNo = typeof order.tracking_no === "string" ? order.tracking_no.trim() : "";
    if (trackingNo || BLOCKED_STATUSES.has(order.delivery_status)) {
      return NextResponse.json(
        { error: "운송장 또는 완료 상태가 있는 주문은 중복구매 의심 해제를 할 수 없습니다." },
        { status: 409 }
      );
    }

    const { data: deletedLogs, error: deleteErr } = await supabase
      .from("purchase_logs")
      .delete()
      .eq("user_id", user.id)
      .eq("order_id", orderId)
      .select("id");

    if (deleteErr) {
      console.error("[clear-purchase-duplicate] 구매 로그 삭제 실패:", deleteErr.message);
      return NextResponse.json({ error: deleteErr.message }, { status: 500 });
    }

    const { data: updatedOrder, error: updateErr } = await supabase
      .from("orders")
      .update({
        purchase_order_no: null,
        cost: null,
        payment_method: null,
        purchased_at: null,
        delivery_status: "결제전",
      })
      .eq("id", orderId)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();

    if (updateErr) {
      console.error("[clear-purchase-duplicate] 주문 구매정보 초기화 실패:", updateErr.message);
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }
    if (!updatedOrder) {
      return NextResponse.json({ error: "주문 구매정보를 초기화하지 못했습니다." }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      deletedLogCount: deletedLogs?.length ?? 0,
    });
  } catch (err) {
    console.error("[clear-purchase-duplicate] 처리 실패:", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "중복구매 의심 해제 실패" },
      { status: 500 }
    );
  }
}
