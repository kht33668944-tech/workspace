import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/** GET: 스마트스토어 카테고리코드 목록 조회 (페이지네이션으로 전체 로드) */
export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getSupabase();
  const PAGE = 1000;
  const allData: Array<Record<string, unknown>> = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("smartstore_category_codes")
      .select("id, category_code, category_type, category_name, created_at")
      .eq("user_id", userId)
      .order("category_type")
      .order("category_name")
      .range(from, from + PAGE - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    allData.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  return NextResponse.json({ codes: allData });
}

/** POST: 카테고리코드 일괄 저장 (upsert) */
export async function POST(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { codes } = (await req.json()) as {
    codes: Array<{ category_code: string; category_type: string; category_name: string }>;
  };
  if (!Array.isArray(codes) || codes.length === 0) {
    return NextResponse.json({ error: "데이터가 없습니다." }, { status: 400 });
  }

  const supabase = getSupabase();
  const rows = codes.map((c) => ({
    user_id: userId,
    category_code: c.category_code.trim(),
    category_type: c.category_type.trim(),
    category_name: c.category_name.trim(),
  }));

  const { error } = await supabase
    .from("smartstore_category_codes")
    .upsert(rows, { onConflict: "user_id,category_code" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

