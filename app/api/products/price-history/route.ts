import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, fetchAllRows } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // RLS 적용 클라이언트 사용 — products.user_id = auth.uid() 자동 필터
  const sb = getSupabaseClient(token);
  const { searchParams } = new URL(request.url);

  const fromParam = searchParams.get("from"); // YYYY-MM-DD
  const to = searchParams.get("to");          // YYYY-MM-DD

  // from 미지정 시 기본 90일 윈도우로 범위를 제한 (무제한 누적 방지 + 1000행 무음 절단 방지)
  let from = fromParam;
  if (!from) {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    from = d.toISOString().slice(0, 10);
  }

  try {
    // 1000행 초과 무음 절단 방지: 윈도우 내 전건 페이지네이션
    const data = await fetchAllRows<Record<string, unknown>>(
      (rangeFrom, rangeTo) => {
        let query = sb
          .from("price_history")
          .select(`
            id, product_id, previous_price, new_price,
            change_amount, change_rate, source, scraped_at,
            products!inner(product_name, purchase_url, category, user_id)
          `)
          .order("scraped_at", { ascending: false })
          .gte("scraped_at", from!.includes("T") ? from! : `${from}T00:00:00`);
        if (to) query = query.lte("scraped_at", to.includes("T") ? to : `${to}T23:59:59`);
        return query.range(rangeFrom, rangeTo);
      },
    );
    return NextResponse.json({ history: data });
  } catch (e) {
    return NextResponse.json(
      { error: `[PriceHistory] ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
