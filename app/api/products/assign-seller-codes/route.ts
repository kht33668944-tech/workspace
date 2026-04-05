import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

/**
 * 내보내기 전 seller_code 사전 할당 API
 * - seller_code가 없는 상품에 오늘 날짜 + 순번으로 코드 부여
 * - 이미 있는 상품은 건너뜀 (같은 상품 = 같은 코드 보장)
 * - 병렬 내보내기 전에 1회만 호출하여 레이스 컨디션 방지
 */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { productIds } = await request.json() as { productIds: string[] };
    if (!productIds?.length) return NextResponse.json({ error: "상품 ID가 없습니다." }, { status: 400 });

    const supabase = getSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 대상 상품 중 seller_code가 없는 것만 조회
    const { data: products, error } = await supabase
      .from("products")
      .select("id, seller_code")
      .in("id", productIds);
    if (error) throw error;

    const needsCode = (products ?? []).filter(p => !p.seller_code);
    if (needsCode.length === 0) {
      return NextResponse.json({ assigned: 0 });
    }

    // 오늘 날짜의 최대 순번 조회
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

    const { data: maxRow } = await supabase
      .from("products")
      .select("seller_code")
      .eq("user_id", user.id)
      .like("seller_code", `${dateStr}%`)
      .order("seller_code", { ascending: false })
      .limit(1);

    let idx = (maxRow?.length ? parseInt(maxRow[0].seller_code.slice(6), 10) || 0 : 0) + 1;

    // 순차적으로 seller_code 할당 및 DB 저장
    const BATCH = 10;
    for (let i = 0; i < needsCode.length; i += BATCH) {
      const batch = needsCode.slice(i, i + BATCH);
      await Promise.all(
        batch.map(p => {
          const code = `${dateStr}${String(idx++).padStart(3, "0")}`;
          return supabase.from("products").update({ seller_code: code }).eq("id", p.id);
        })
      );
    }

    console.log(`[assign-seller-codes] ${needsCode.length}개 상품에 seller_code 할당 (${dateStr}${String(idx - needsCode.length).padStart(3, "0")}~${dateStr}${String(idx - 1).padStart(3, "0")})`);
    return NextResponse.json({ assigned: needsCode.length });
  } catch (err) {
    console.error("[assign-seller-codes] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "seller_code 할당 실패" }, { status: 500 });
  }
}
