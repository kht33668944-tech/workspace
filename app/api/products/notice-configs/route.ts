import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const token = getAccessToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("playauto_notice_configs")
    .select("schema_code, field_values")
    .order("schema_code");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const token = getAccessToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { configs } = (await req.json()) as {
    configs: Array<{ schema_code: string; field_values: string[] }>;
  };

  if (!configs || configs.length === 0) {
    return NextResponse.json({ error: "설정 데이터 없음" }, { status: 400 });
  }

  const rows = configs.map((c) => ({
    user_id: user.id,
    schema_code: c.schema_code,
    field_values: c.field_values,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("playauto_notice_configs")
    .upsert(rows, { onConflict: "user_id,schema_code" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
