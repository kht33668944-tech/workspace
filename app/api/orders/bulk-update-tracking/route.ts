import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import type { BulkUpdateTrackingRequest } from "@/lib/scrapers/types";

export const maxDuration = 120;

const UPDATE_BATCH = 20; // 동시 업데이트 수 (직렬 라운드트립 타임아웃 방지)

export async function POST(request: NextRequest) {
  try {
    const token = getAccessToken(request);
    if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    const supabase = getSupabaseClient(token);

    const body = (await request.json()) as BulkUpdateTrackingRequest;

    if (!body.updates || body.updates.length === 0) {
      return NextResponse.json({ error: "업데이트할 데이터가 없습니다." }, { status: 400 });
    }

    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];

    // 20건씩 병렬 처리 (기존 1건씩 순차 → 대량 시 타임아웃 위험)
    for (let i = 0; i < body.updates.length; i += UPDATE_BATCH) {
      const batch = body.updates.slice(i, i + UPDATE_BATCH);
      const results = await Promise.allSettled(
        batch.map((update) => {
          const updateData: Record<string, unknown> = {
            courier: update.courier,
            tracking_no: update.tracking_no,
          };
          // 운송장번호가 있으면 배송완료로 자동 변경
          if (update.tracking_no) {
            updateData.delivery_status = "배송완료";
          }
          return supabase
            .from("orders")
            .update(updateData)
            .eq("purchase_order_no", update.purchase_order_no)
            .select("id");
        })
      );

      results.forEach((r, j) => {
        const orderNo = batch[j].purchase_order_no;
        if (r.status === "rejected") {
          failCount++;
          errors.push(`${orderNo}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        } else if (r.value.error) {
          failCount++;
          errors.push(`${orderNo}: ${r.value.error.message}`);
        } else if (!r.value.data || r.value.data.length === 0) {
          failCount++;
          errors.push(`${orderNo}: DB에서 주문번호를 찾을 수 없음`);
        } else {
          successCount++;
        }
      });
    }

    console.log("[bulk-update] 결과:", { successCount, failCount, errors: errors.slice(0, 5) });
    return NextResponse.json({ successCount, failCount, errors });
  } catch (err) {
    return NextResponse.json(
      { error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
