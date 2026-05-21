import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const supabase = getSupabaseClient(token);

    const { count: totalRows, error: countErr } = await supabase
      .from("smartstore_price_inventory")
      .select("*", { count: "exact", head: true });
    if (countErr) throw countErr;

    const { data: latest } = await supabase
      .from("smartstore_price_inventory")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    const lastImportedAt = latest?.[0]?.updated_at ?? null;

    // 매칭된 상품 + 스마트스토어 상품번호
    const { data: matchedRows, error: rowsErr } = await supabase
      .from("smartstore_price_inventory")
      .select("product_id, smartstore_product_id, option_type")
      .not("product_id", "is", null);
    if (rowsErr) throw rowsErr;

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

    // 상품 1개당 1행이 원칙이지만 동일 product_id에 여러 smartstore_product_id가 매핑될 수도 있어 그룹화
    const byProductId = new Map<string, { ids: string[]; hasOption: boolean }>();
    for (const r of matchedRows ?? []) {
      if (!r.product_id) continue;
      const entry = byProductId.get(r.product_id) ?? { ids: [], hasOption: false };
      if (r.smartstore_product_id) entry.ids.push(r.smartstore_product_id);
      if (r.option_type && r.option_type !== "설정안함") entry.hasOption = true;
      byProductId.set(r.product_id, entry);
    }

    const matchedProducts = [...byProductId.entries()]
      .map(([id, s]) => ({
        id,
        product_name: productNameMap.get(id) ?? "(삭제된 상품)",
        smartstoreProductIds: s.ids,
        hasOption: s.hasOption,
      }))
      .sort((a, b) => a.product_name.localeCompare(b.product_name));

    return NextResponse.json({
      totalRows: totalRows ?? 0,
      matchedProductCount: matchedProducts.length,
      lastImportedAt,
      matchedProducts,
    });
  } catch (err) {
    console.error("[smartstore-price-inventory/status] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "현황 조회 실패" }, { status: 500 });
  }
}
