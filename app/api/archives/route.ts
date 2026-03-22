import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

// GET: 보관함 목록 조회 (만료된 항목 자동 삭제 후 반환)
export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);

  // 만료된 항목 자동 삭제
  await supabase
    .from("excel_archives")
    .delete()
    .lt("expires_at", new Date().toISOString());

  // 목록 조회 (file_data 제외 - 용량 절약)
  const { data, error } = await supabase
    .from("excel_archives")
    .select("id, file_name, file_type, order_count, created_at, expires_at")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST: 보관함에 저장
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const body = await request.json();
  const { file_name, file_type, file_data, order_count } = body;

  if (!file_name || !file_type || !file_data) {
    return NextResponse.json({ error: "필수 필드 누락" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("excel_archives")
    .insert({
      user_id: user.id,
      file_name,
      file_type,
      file_data,
      order_count: order_count || 0,
    })
    .select("id, file_name, file_type, order_count, created_at, expires_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE: 선택한 항목 삭제
export async function DELETE(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const body = await request.json();
  const { ids } = body as { ids: string[] };

  if (!ids || ids.length === 0) {
    return NextResponse.json({ error: "삭제할 항목 없음" }, { status: 400 });
  }

  const { error } = await supabase
    .from("excel_archives")
    .delete()
    .in("id", ids);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, deletedCount: ids.length });
}
