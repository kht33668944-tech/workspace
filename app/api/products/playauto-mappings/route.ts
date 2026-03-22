import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabaseClient } from "@/lib/api-helpers";
import { suggestPlayautoCategories } from "@/lib/gemini";
import { PLAYAUTO_SCHEMAS } from "@/lib/playauto-schema";

/** GET: 현재 사용자의 매핑 목록 조회 */
export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getServiceSupabaseClient();
  const { data, error } = await supabase
    .from("playauto_category_mappings")
    .select("user_category, playauto_code")
    .eq("user_id", userId)
    .order("user_category");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ mappings: data ?? [] });
}

/** POST: 매핑 일괄 저장 (upsert) */
export async function POST(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { mappings } = (await req.json()) as {
    mappings: Array<{ user_category: string; playauto_code: string }>;
  };
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return NextResponse.json({ error: "매핑 데이터가 없습니다." }, { status: 400 });
  }

  const supabase = getServiceSupabaseClient();
  const rows = mappings.map((m) => ({
    user_id: userId,
    user_category: m.user_category,
    playauto_code: m.playauto_code,
  }));

  const { error } = await supabase
    .from("playauto_category_mappings")
    .upsert(rows, { onConflict: "user_id,user_category" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** PUT: Gemini로 자동 매핑 제안 */
export async function PUT(req: NextRequest) {
  const { categories } = (await req.json()) as { categories: string[] };
  if (!Array.isArray(categories) || categories.length === 0) {
    return NextResponse.json({ error: "카테고리 목록이 없습니다." }, { status: 400 });
  }

  const codes = await suggestPlayautoCategories(categories, PLAYAUTO_SCHEMAS);
  const suggestions = categories.map((cat, i) => ({
    user_category: cat,
    playauto_code: codes[i],
  }));

  return NextResponse.json({ suggestions });
}
