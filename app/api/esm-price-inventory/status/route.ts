import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, fetchAllRows } from "@/lib/api-helpers";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const supabase = getSupabaseClient(token);

    const { count: totalRows, error: countErr } = await supabase
      .from("esm_price_inventory")
      .select("*", { count: "exact", head: true });
    if (countErr) throw countErr;

    const { data: latest } = await supabase
      .from("esm_price_inventory")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    const lastImportedAt = latest?.[0]?.updated_at ?? null;

    // product_id별 site별 행 수 집계 (매칭된 행만) — 1000행 초과 무음 절단 방지: 전건 페이지네이션
    const matchedRows = await fetchAllRows<{ product_id: string | null; site: string }>(
      (from, to) => supabase
        .from("esm_price_inventory")
        .select("product_id, site")
        .not("product_id", "is", null)
        .range(from, to),
    );

    const productIds = [...new Set(matchedRows.map(r => r.product_id).filter((x): x is string => !!x))];
    const productNameMap = new Map<string, string>();
    if (productIds.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < productIds.length; i += CHUNK) {
        const ids = productIds.slice(i, i + CHUNK);
        const { data } = await supabase.from("products").select("id, product_name").in("id", ids);
        for (const p of data ?? []) productNameMap.set(p.id, p.product_name);
      }
    }

    // 상품별 옥션/지마켓 카운트
    const statByProductId = new Map<string, { auction: number; gmarket: number }>();
    for (const r of matchedRows) {
      if (!r.product_id) continue;
      const entry = statByProductId.get(r.product_id) ?? { auction: 0, gmarket: 0 };
      if (r.site === "옥션") entry.auction++;
      else if (r.site === "지마켓") entry.gmarket++;
      statByProductId.set(r.product_id, entry);
    }

    const matchedProducts = [...statByProductId.entries()]
      .map(([id, s]) => ({
        id,
        product_name: productNameMap.get(id) ?? "(삭제된 상품)",
        auctionCount: s.auction,
        gmarketCount: s.gmarket,
      }))
      .sort((a, b) => a.product_name.localeCompare(b.product_name));

    return NextResponse.json({
      totalRows: totalRows ?? 0,
      matchedProductCount: matchedProducts.length,
      lastImportedAt,
      matchedProducts,
    });
  } catch (err) {
    console.error("[esm-price-inventory/status] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "현황 조회 실패" }, { status: 500 });
  }
}
