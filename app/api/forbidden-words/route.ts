import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const token = getAccessToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("forbidden_words")
    .select("id, word, created_at")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ words: data ?? [] });
}

export async function POST(req: NextRequest) {
  const token = getAccessToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { word } = (await req.json()) as { word?: string };
  const trimmed = (word ?? "").trim();
  if (!trimmed) return NextResponse.json({ error: "금지어를 입력하세요" }, { status: 400 });
  if (trimmed.length > 50) return NextResponse.json({ error: "50자 이하" }, { status: 400 });

  const { data, error } = await supabase
    .from("forbidden_words")
    .insert({ word: trimmed })
    .select("id, word, created_at")
    .single();

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "이미 등록된 금지어입니다" }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ word: data });
}

export async function DELETE(req: NextRequest) {
  const token = getAccessToken(req);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { id } = (await req.json()) as { id?: string };
  if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });

  const { error } = await supabase.from("forbidden_words").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
