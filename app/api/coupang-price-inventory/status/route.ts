import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const supabase = getSupabaseClient(token);

    // 전체 옵션 행 + 마지막 임포트 시각
    const { count: totalRows, error: countErr } = await supabase
      .from("coupang_price_inventory")
      .select("*", { count: "exact", head: true });
    if (countErr) throw countErr;

    const { data: latest } = await supabase
      .from("coupang_price_inventory")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    const lastImportedAt = latest?.[0]?.updated_at ?? null;

    // product_id별 옵션 수 (매칭된 행만)
    const { data: matchedRows, error: rowsErr } = await supabase
      .from("coupang_price_inventory")
      .select("product_id, registered_name")
      .not("product_id", "is", null);
    if (rowsErr) throw rowsErr;

    // products 이름 조회 (매칭된 product_id들만)
    const productIds = [...new Set((matchedRows ?? []).map(r => r.product_id).filter((x): x is string => !!x))];
    const productNameMap = new Map<string, string>();
    if (productIds.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < productIds.length; i += CHUNK) {
        const ids = productIds.slice(i, i + CHUNK);
        const { data } = await supabase.from("products").select("id, product_name").in("id", ids);
        for (const p of data ?? []) productNameMap.set(p.id, p.product_name);
      }
    }

    // 집계
    const optionCountByProductId = new Map<string, number>();
    for (const r of matchedRows ?? []) {
      if (!r.product_id) continue;
      optionCountByProductId.set(r.product_id, (optionCountByProductId.get(r.product_id) ?? 0) + 1);
    }
    const matchedProducts = [...optionCountByProductId.entries()]
      .map(([id, optionCount]) => ({
        id,
        product_name: productNameMap.get(id) ?? "(삭제된 상품)",
        optionCount,
      }))
      .sort((a, b) => a.product_name.localeCompare(b.product_name));

    return NextResponse.json({
      totalRows: totalRows ?? 0,
      matchedProductCount: matchedProducts.length,
      lastImportedAt,
      matchedProducts,
    });
  } catch (err) {
    console.error("[coupang-price-inventory/status] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "현황 조회 실패" }, { status: 500 });
  }
}
