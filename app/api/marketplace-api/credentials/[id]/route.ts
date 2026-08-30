import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { encrypt } from "@/lib/crypto";
import { toPublicMarketplaceCredential, type StoredMarketplaceApiCredential } from "@/lib/marketplace-api-helpers";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { id } = await params;
  let body: {
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

  const updateData: Record<string, unknown> = {};
  if (body.label !== undefined) updateData.label = body.label?.trim() || null;
  if (body.account_id !== undefined) updateData.account_id = body.account_id.trim();
  if (body.access_key) updateData.access_key_encrypted = encrypt(body.access_key.trim());
  if (body.secret_key) updateData.secret_key_encrypted = encrypt(body.secret_key.trim());
  if (body.client_id) updateData.client_id_encrypted = encrypt(body.client_id.trim());
  if (body.client_secret) updateData.client_secret_encrypted = encrypt(body.client_secret.trim());
  if (body.meta && typeof body.meta === "object") updateData.meta = body.meta;

  const supabase = getSupabaseClient(token);
  const { data, error } = await supabase
    .from("marketplace_api_credentials")
    .update(updateData)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[marketplace-api-credentials] 수정 실패:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(toPublicMarketplaceCredential(data as StoredMarketplaceApiCredential));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const { id } = await params;
  const supabase = getSupabaseClient(token);
  const { error } = await supabase
    .from("marketplace_api_credentials")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("[marketplace-api-credentials] 삭제 실패:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
