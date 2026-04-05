import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

const PLATFORM_GROUPS = ["smartstore", "esm", "coupang"] as const;

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { productIds } = await request.json() as { productIds: string[] };
    if (!productIds?.length) return NextResponse.json({ error: "상품 ID가 없습니다." }, { status: 400 });

    const supabase = getSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 대상 상품 조회
    const { data: products, error } = await supabase
      .from("products")
      .select("id, seller_code")
      .in("id", productIds);
    if (error) throw error;

    // 오늘 날짜
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

    // 오늘 날짜의 seller_code 최대 순번 조회 (모든 그룹 통합)
    const { data: allWithCode } = await supabase
      .from("products")
      .select("seller_code")
      .eq("user_id", user.id)
      .not("seller_code", "is", null);

    let globalMax = 0;
    for (const p of allWithCode ?? []) {
      const codes = p.seller_code as Record<string, string> | null;
      if (!codes) continue;
      for (const code of Object.values(codes)) {
        if (typeof code === "string" && code.startsWith(dateStr)) {
          const num = parseInt(code.slice(6), 10) || 0;
          if (num > globalMax) globalMax = num;
        }
      }
    }

    // 각 상품에 대해 빠진 그룹의 코드 할당
    let assigned = 0;
    let idx = globalMax + 1;

    const BATCH = 10;
    const updates: Array<{ id: string; seller_code: Record<string, string> }> = [];

    for (const p of products ?? []) {
      const existing = (p.seller_code as Record<string, string> | null) ?? {};
      let changed = false;

      for (const group of PLATFORM_GROUPS) {
        if (!existing[group]) {
          existing[group] = `${dateStr}${String(idx++).padStart(3, "0")}`;
          changed = true;
          assigned++;
        }
      }

      if (changed) {
        updates.push({ id: p.id, seller_code: existing });
      }
    }

    // DB 배치 업데이트
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      await Promise.all(
        batch.map(u =>
          supabase.from("products").update({ seller_code: u.seller_code }).eq("id", u.id)
        )
      );
    }

    console.log(`[assign-seller-codes] ${updates.length}개 상품에 ${assigned}개 코드 할당`);
    return NextResponse.json({ assigned });
  } catch (err) {
    console.error("[assign-seller-codes] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "seller_code 할당 실패" }, { status: 500 });
  }
}
