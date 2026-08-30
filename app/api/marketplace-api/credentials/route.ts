import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { encrypt } from "@/lib/crypto";
import { toPublicMarketplaceCredential, type StoredMarketplaceApiCredential } from "@/lib/marketplace-api-helpers";

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("marketplace_api_credentials")
    .select("*")
    .order("platform")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(((data ?? []) as StoredMarketplaceApiCredential[]).map(toPublicMarketplaceCredential));
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  let body: {
    platform?: string;
    label?: string;
    account_id?: string;
    access_key?: string;
    secret_key?: string;
    client_id?: string;
    client_secret?: string;
    meta?: Record<string, unknown>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }

  if (body.platform !== "coupang" && body.platform !== "smartstore" && body.platform !== "esm") {
    return NextResponse.json({ error: "지원하지 않는 판매처입니다." }, { status: 400 });
  }
  if (body.platform === "smartstore" && (!body.client_id?.trim() || !body.client_secret?.trim())) {
    return NextResponse.json({ error: "스마트스토어 애플리케이션 ID와 시크릿이 필요합니다." }, { status: 400 });
  }
  // 스마트스토어는 채널번호를 연결확인 시 자동으로 채우므로 비워둘 수 있다
  if (body.platform === "smartstore" && !body.account_id?.trim()) body.account_id = "-";
  if (!body.account_id?.trim()) {
    return NextResponse.json({ error: "계정 식별값이 필요합니다." }, { status: 400 });
  }
  if (body.platform === "coupang" && (!body.access_key?.trim() || !body.secret_key?.trim())) {
    return NextResponse.json({ error: "쿠팡 Access Key와 Secret Key가 필요합니다." }, { status: 400 });
  }

  const supabase = getSupabaseClient(token);
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

  const { data, error } = await supabase
    .from("marketplace_api_credentials")
    .insert({
      user_id: userData.user.id,
      platform: body.platform,
      label: body.label?.trim() || body.account_id.trim(),
      account_id: body.account_id.trim(),
      access_key_encrypted: body.access_key ? encrypt(body.access_key.trim()) : null,
      secret_key_encrypted: body.secret_key ? encrypt(body.secret_key.trim()) : null,
      client_id_encrypted: body.client_id ? encrypt(body.client_id.trim()) : null,
      client_secret_encrypted: body.client_secret ? encrypt(body.client_secret.trim()) : null,
      meta: body.meta && typeof body.meta === "object" ? body.meta : {},
    })
    .select("*")
    .single();

  if (error) {
    console.error("[marketplace-api-credentials] 저장 실패:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(toPublicMarketplaceCredential(data as StoredMarketplaceApiCredential), { status: 201 });
}
