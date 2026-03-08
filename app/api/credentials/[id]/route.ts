import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { encrypt } from "@/lib/crypto";

function getSupabaseClient(accessToken: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
}

function getAccessToken(request: NextRequest): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// PUT: 자격증명 수정
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const { login_id, login_pw, label } = body;

  const supabase = getSupabaseClient(token);

  const updateData: Record<string, string> = { updated_at: new Date().toISOString() };
  if (login_id) updateData.login_id = login_id;
  if (login_pw) updateData.login_pw_encrypted = encrypt(login_pw);
  if (label !== undefined) updateData.label = label || "";

  const { data, error } = await supabase
    .from("purchase_credentials")
    .update(updateData)
    .eq("id", id)
    .select("id, user_id, platform, login_id, label, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "찾을 수 없음" }, { status: 404 });

  return NextResponse.json(data);
}

// DELETE: 자격증명 삭제
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { id } = await params;
  const supabase = getSupabaseClient(token);

  const { error } = await supabase
    .from("purchase_credentials")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
