import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

// GET: 개별 파일 데이터 조회 (다운로드용)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { id } = await params;
  const supabase = getSupabaseClient(token);

  const { data, error } = await supabase
    .from("excel_archives")
    .select("file_name, file_data")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "파일을 찾을 수 없습니다" }, { status: 404 });
  }

  return NextResponse.json(data);
}
