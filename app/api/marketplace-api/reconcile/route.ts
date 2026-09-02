import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { computeCoupangTargetPrice, computeSmartstoreTargetPrice } from "@/lib/marketplace-api-helpers";
import { buildRateMap } from "@/lib/product-calculations";
import { AUTOMATION_EXCLUDED_STATUSES } from "@/lib/constants";
import type { CommissionRate, Product } from "@/types/database";

export const maxDuration = 60;

// 가격 검산 — "기준가(상품목록 계산가) ≠ 마켓 캐시가"인 판매중 상품의 id 를 돌려준다.
// 자동화(auto-price-refresh)가 price 잡 대상에 합류시켜, 어떤 경로로 어긋났든 다음 회차에 자동 복구되게 한다.
// 판매중지/SUSPENSION 행은 제외 — 중지 상태의 옛 가격 유지는 의도된 동작(재개 시 price 잡이 처리).
// ESM 은 API 가 없어 검산 불가 — 범위 밖.

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;

    const products = await pageAll<Product>((from, to) =>
      supabase.from("products").select("*").eq("user_id", userId).order("id").range(from, to));
    const { data: rates, error: ratesErr } = await supabase.from("commission_rates").select("*");
    if (ratesErr) throw new Error(ratesErr.message);
    const rateMap = buildRateMap((rates ?? []) as CommissionRate[]);
    const productMap = new Map(products.filter((p) => !AUTOMATION_EXCLUDED_STATUSES.has(p.registration_status)).map((p) => [p.id, p]));

    type InvRow = { product_id: string | null; sale_price: number | null };
    const coupangRows = await pageAll<InvRow>((from, to) =>
      supabase.from("coupang_price_inventory").select("product_id,sale_price").eq("user_id", userId).eq("sale_status", "판매중").order("id").range(from, to));
    const ssRows = await pageAll<InvRow>((from, to) =>
      supabase.from("smartstore_price_inventory").select("product_id,sale_price").eq("user_id", userId).eq("product_status", "SALE").order("id").range(from, to));

    const coupang = new Set<string>();
    for (const row of coupangRows) {
      const p = row.product_id ? productMap.get(row.product_id) : undefined;
      if (!p) continue;
      const target = computeCoupangTargetPrice(p, rateMap);
      if (target != null && target > 0 && row.sale_price !== target) coupang.add(p.id);
    }
    const smartstore = new Set<string>();
    for (const row of ssRows) {
      const p = row.product_id ? productMap.get(row.product_id) : undefined;
      if (!p) continue;
      const target = computeSmartstoreTargetPrice(p, rateMap);
      if (target != null && target > 0 && row.sale_price !== target) smartstore.add(p.id);
    }

    return NextResponse.json({
      coupang: [...coupang],
      smartstore: [...smartstore],
      counts: { coupang: coupang.size, smartstore: smartstore.size },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[marketplace-reconcile] 검산 오류:", message);
    return NextResponse.json({ error: "가격 검산 실패" }, { status: 500 });
  }
}
