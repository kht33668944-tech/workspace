import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

// GET: 택배사 코드 목록 조회
export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("courier_codes")
    .select("id, courier_name, courier_code")
    .order("courier_code");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST: 택배사 코드 일괄 저장 (기존 전체 삭제 후 재생성)
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const body = await request.json();
  const { codes } = body as { codes: { courier_name: string; courier_code: number }[] };

  if (!codes || !Array.isArray(codes)) {
    return NextResponse.json({ error: "유효하지 않은 데이터" }, { status: 400 });
  }

  const rows = codes.map((c) => ({
    user_id: user.id,
    courier_name: c.courier_name,
    courier_code: c.courier_code,
  }));

  if (rows.length > 0) {
    // upsert로 원자적 저장 (user_id + courier_code 기준)
    const { error: upsertError } = await supabase
      .from("courier_codes")
      .upsert(rows, { onConflict: "user_id,courier_code" });
    if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

    // upsert에 포함되지 않은 기존 코드 삭제
    const submittedCodes = codes.map((c) => c.courier_code);
    const { error: deleteError } = await supabase
      .from("courier_codes")
      .delete()
      .eq("user_id", user.id)
      .not("courier_code", "in", `(${submittedCodes.join(",")})`);
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });
  } else {
    // 빈 배열이면 전체 삭제
    const { error } = await supabase.from("courier_codes").delete().eq("user_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, count: codes.length });
}
