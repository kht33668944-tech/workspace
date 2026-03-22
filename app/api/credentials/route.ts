import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { encrypt } from "@/lib/crypto";

// GET: 본인의 자격증명 목록 조회 (비밀번호 제외)
export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("purchase_credentials")
    .select("id, user_id, platform, login_id, label, group_name, created_at, updated_at")
    .order("platform");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST: 새 자격증명 등록
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const body = await request.json();
  const { platform, login_id, login_pw, label, group_name } = body;

  if (!platform || !login_id || !login_pw) {
    return NextResponse.json({ error: "플랫폼, 아이디, 비밀번호는 필수입니다." }, { status: 400 });
  }

  const supabase = getSupabaseClient(token);
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

  const encryptedPw = encrypt(login_pw);

  const { data, error } = await supabase
    .from("purchase_credentials")
    .insert({
      user_id: userData.user.id,
      platform,
      login_id,
      login_pw_encrypted: encryptedPw,
      label: label || null,
      group_name: group_name || null,
    })
    .select("id, user_id, platform, login_id, label, group_name, created_at, updated_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "이미 등록된 계정입니다." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
