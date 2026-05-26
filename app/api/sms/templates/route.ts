import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("sms_templates")
    .select("*")
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const body = await request.json();
  const { name, content, is_default } = body as { name: string; content: string; is_default?: boolean };

  if (!name?.trim() || !content?.trim()) {
    return NextResponse.json({ error: "이름과 내용은 필수입니다." }, { status: 400 });
  }

  if (is_default) {
    await supabase
      .from("sms_templates")
      .update({ is_default: false })
      .eq("user_id", user.id)
      .eq("is_default", true);
  }

  const { data, error } = await supabase
    .from("sms_templates")
    .insert({ user_id: user.id, name: name.trim(), content: content.trim(), is_default: is_default || false })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function PUT(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const body = await request.json();
  const { id, name, content, is_default } = body as { id: string; name?: string; content?: string; is_default?: boolean };

  if (!id) return NextResponse.json({ error: "id 필수" }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name.trim();
  if (content !== undefined) updates.content = content.trim();
  if (is_default !== undefined) updates.is_default = is_default;

  if (is_default) {
    await supabase
      .from("sms_templates")
      .update({ is_default: false })
      .eq("user_id", user.id)
      .eq("is_default", true);
  }

  const { data, error } = await supabase
    .from("sms_templates")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) return NextResponse.json({ error: "id 필수" }, { status: 400 });

  const { error } = await supabase.from("sms_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
