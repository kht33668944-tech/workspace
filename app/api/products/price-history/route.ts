import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient, fetchAllRows } from "@/lib/api-helpers";

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

export async function DELETE(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({})) as { productIds?: string[]; from?: string };
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    const from = typeof body.from === "string" && body.from ? body.from : null;

    if (productIds.length === 0) {
      return NextResponse.json({ error: "초기화할 상품이 없습니다." }, { status: 400 });
    }
    if (!from) {
      return NextResponse.json({ error: "초기화 기준 시간이 없습니다." }, { status: 400 });
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = [...new Set(productIds.filter((id) => typeof id === "string" && UUID_RE.test(id)))];
    if (ids.length === 0) {
      return NextResponse.json({ cleared: 0, productCount: 0 });
    }

    const userSb = getSupabaseClient(token);
    const { data: { user } } = await userSb.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = getServiceSupabaseClient();
    const CHUNK = 100;
    let productCount = 0;
    let cleared = 0;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { data: owned, error: ownedErr } = await sb
        .from("products")
        .select("id")
        .eq("user_id", user.id)
        .in("id", chunk);
      if (ownedErr) {
        console.error("[price-history] 상품 확인 실패:", ownedErr.message);
        return NextResponse.json({ error: `상품 확인 실패: ${ownedErr.message}` }, { status: 400 });
      }

      const ownedIds = (owned ?? []).map((p) => p.id as string);
      productCount += ownedIds.length;
      if (ownedIds.length === 0) continue;

      const { data: historyRows, error: historyErr } = await sb
        .from("price_history")
        .select("id")
        .in("product_id", ownedIds)
        .gte("scraped_at", from);
      if (historyErr) {
        console.error("[price-history] 초기화 대상 조회 실패:", historyErr.message);
        return NextResponse.json({ error: `초기화 대상 조회 실패: ${historyErr.message}` }, { status: 400 });
      }

      const historyIds = (historyRows ?? []).map((row) => row.id as string);
      for (let j = 0; j < historyIds.length; j += CHUNK) {
        const historyChunk = historyIds.slice(j, j + CHUNK);
        if (historyChunk.length === 0) continue;

        const { error, count } = await sb
          .from("price_history")
          .delete({ count: "exact" })
          .in("id", historyChunk);

        if (error) {
          console.error("[price-history] 초기화 실패:", error.message);
          return NextResponse.json({ error: `초기화 실패: ${error.message}` }, { status: 400 });
        }
        cleared += count ?? historyChunk.length;
      }
    }

    console.log(`[price-history] 전일 대비 초기화 완료: 상품 ${productCount}개, 이력 ${cleared}건`);
    return NextResponse.json({ cleared, productCount });
  } catch (e) {
    console.error("[price-history] 전일 대비 초기화 오류:", e instanceof Error ? e.message : String(e));
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "전일 대비 초기화 실패" },
      { status: 500 },
    );
  }
}
