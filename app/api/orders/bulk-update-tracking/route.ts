import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { BulkUpdateTrackingRequest } from "@/lib/scrapers/types";

export async function POST(request: NextRequest) {
  try {
    // 클라이언트 인증 토큰으로 Supabase 클라이언트 생성 (RLS 통과)
    const authHeader = request.headers.get("authorization");
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      authHeader ? { global: { headers: { Authorization: authHeader } } } : undefined
    );

    const body = (await request.json()) as BulkUpdateTrackingRequest;

    if (!body.updates || body.updates.length === 0) {
      return NextResponse.json({ error: "업데이트할 데이터가 없습니다." }, { status: 400 });
    }

    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];

    for (const update of body.updates) {
      const updateData: Record<string, unknown> = {
        courier: update.courier,
        tracking_no: update.tracking_no,
      };

      // 운송장번호가 있으면 배송완료로 자동 변경
      if (update.tracking_no) {
        updateData.delivery_status = "배송완료";
      }

      const { data, error } = await supabase
        .from("orders")
        .update(updateData)
        .eq("purchase_order_no", update.purchase_order_no)
        .select("id");

      if (error) {
        failCount++;
        errors.push(`${update.purchase_order_no}: ${error.message}`);
      } else if (!data || data.length === 0) {
        failCount++;
        errors.push(`${update.purchase_order_no}: DB에서 주문번호를 찾을 수 없음`);
      } else {
        successCount++;
      }
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
