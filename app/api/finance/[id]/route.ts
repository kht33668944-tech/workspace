import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { recalcTotals } from "@/lib/finance-utils";
import type { CardEntry, PlatformEntry, CashEntry } from "@/types/database";

// PUT: 스냅샷 업데이트
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { id } = await params;
  const supabase = getSupabaseClient(token);
  const body = await request.json();

  // totals 재계산이 필요한 경우
  const updateData: Record<string, unknown> = { ...body };

  if (body.cards || body.platforms || body.cash || body.pending_purchase !== undefined) {
    // 현재 스냅샷의 기존 데이터를 가져와서 병합
    const { data: current } = await supabase
      .from("daily_snapshots")
      .select("cards, platforms, cash, pending_purchase")
      .eq("id", id)
      .single();

    if (current) {
      const cards = (body.cards ?? current.cards) as CardEntry[];
      const platforms = (body.platforms ?? current.platforms) as PlatformEntry[];
      const cash = (body.cash ?? current.cash) as CashEntry[];
      const pending = body.pending_purchase ?? current.pending_purchase;
      const totals = recalcTotals(cards, platforms, cash, pending);
      Object.assign(updateData, totals);
    }
  }

  // id, user_id, created_at 등은 업데이트 불가
  delete updateData.id;
  delete updateData.user_id;
  delete updateData.created_at;
  delete updateData.updated_at;

  const { data, error } = await supabase
    .from("daily_snapshots")
    .update(updateData)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 전일 스냅샷도 함께 반환
  const { data: prevSnapshot } = await supabase
    .from("daily_snapshots")
    .select("*")
    .lt("date", data.date)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ snapshot: data, prevSnapshot });
}

// DELETE: 스냅샷 삭제
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { id } = await params;
  const supabase = getSupabaseClient(token);

  const { error } = await supabase
    .from("daily_snapshots")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
