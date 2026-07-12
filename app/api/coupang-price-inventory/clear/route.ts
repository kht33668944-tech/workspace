import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

export const maxDuration = 30;

export async function DELETE(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const supabase = getSupabaseClient(token);
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

    const { error, count } = await supabase
      .from("coupang_price_inventory")
      .delete({ count: "exact" })
      .eq("user_id", userData.user.id);
    if (error) throw error;

    console.log(`[coupang-price-inventory/clear] 기존 쿠팡 옵션 행 ${count ?? 0}개 삭제`);
    return NextResponse.json({ deleted: count ?? 0 });
  } catch (err) {
    console.error("[coupang-price-inventory/clear] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "기존 쿠팡 가격수정 정보 삭제 실패" }, { status: 500 });
  }
}
