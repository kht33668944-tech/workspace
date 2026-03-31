import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    // JWT 검증
    const userSb = getSupabaseClient(token);
    const { data: { user } } = await userSb.auth.getUser();
    if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

    const body = await request.json();
    const updates = body?.updates;

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json({ error: "업데이트할 데이터가 없습니다." }, { status: 400 });
    }

    const MAX_BATCH = 500;
    if (updates.length > MAX_BATCH) {
      return NextResponse.json({ error: `최대 ${MAX_BATCH}개까지 처리 가능합니다.` }, { status: 400 });
    }

    // 입력값 검증
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validated = updates.filter((u: Record<string, unknown>) =>
      typeof u.id === "string" && UUID_RE.test(u.id) &&
      typeof u.price === "number" && Number.isFinite(u.price) && u.price > 0 && u.price <= 100_000_000 &&
      typeof u.previous_price === "number" && Number.isFinite(u.previous_price) && u.previous_price >= 0
    ) as Array<{ id: string; price: number; previous_price: number }>;

    if (validated.length === 0) {
      return NextResponse.json({ error: "유효한 업데이트가 없습니다." }, { status: 400 });
    }

    const changed = validated.filter(u => u.price !== u.previous_price);
    if (changed.length === 0) {
      return NextResponse.json({ applied: 0 });
    }

    const supabase = getServiceSupabaseClient();

    // 소유권 검증: 요청된 상품이 모두 본인 소유인지 확인
    const ids = changed.map(u => u.id);
    const { data: owned } = await supabase
      .from("products")
      .select("id")
      .eq("user_id", user.id)
      .in("id", ids);
    const ownedIds = new Set((owned ?? []).map(p => p.id));
    const validUpdates = changed.filter(u => ownedIds.has(u.id));

    // 병렬 업데이트 (10개씩 배치)
    const BATCH = 10;
    let applied = 0;
    const historyRows: Array<Record<string, unknown>> = [];

    for (let i = 0; i < validUpdates.length; i += BATCH) {
      const batch = validUpdates.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(u =>
          supabase.from("products").update({ lowest_price: u.price }).eq("id", u.id).eq("lowest_price", u.previous_price)
        )
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const u = batch[j];
        if (r.status === "fulfilled" && !r.value.error) {
          applied++;
          if (u.previous_price > 0) {
            historyRows.push({
              product_id: u.id,
              previous_price: u.previous_price,
              new_price: u.price,
              change_amount: u.price - u.previous_price,
              change_rate: Math.round(((u.price - u.previous_price) / u.previous_price) * 10000) / 100,
              source: "scrape",
            });
          }
        } else {
          console.error(`[apply-price-updates] 업데이트 실패 (${u.id})`);
        }
      }
    }

    // 가격 이력 일괄 삽입
    if (historyRows.length > 0) {
      const { error: histErr } = await supabase.from("price_history").insert(historyRows);
      if (histErr) console.error("[apply-price-updates] 이력 저장 실패:", histErr.message);
    }

    console.log(`[apply-price-updates] 완료: ${applied}개 적용`);
    return NextResponse.json({ applied });
  } catch (err) {
    console.error("[apply-price-updates] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "가격 적용 실패" }, { status: 500 });
  }
}
