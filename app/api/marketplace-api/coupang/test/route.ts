import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCoupangClientFromCredential } from "@/lib/marketplace-api-helpers";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const { credentialId } = await request.json() as { credentialId?: string };
    if (!credentialId) return NextResponse.json({ error: "쿠팡 API 계정을 선택하세요." }, { status: 400 });

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

    const { client } = await getCoupangClientFromCredential(supabase, credentialId);
    const result = await client.testConnection();
    const status = result.ok ? "success" : "failed";
    const message = result.ok ? "쿠팡 API 연결이 확인되었습니다." : result.message;

    await supabase
      .from("marketplace_api_credentials")
      .update({
        last_tested_at: new Date().toISOString(),
        last_test_status: status,
        last_test_message: message,
      })
      .eq("id", credentialId);

    await supabase.from("marketplace_api_logs").insert({
      user_id: userData.user.id,
      platform: "coupang",
      credential_id: credentialId,
      action: "test",
      status,
      response_payload: typeof result.body === "object" ? result.body : { body: result.body },
      error_message: result.ok ? null : message,
    });

    return NextResponse.json({ success: result.ok, message, status: result.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[coupang-api] 연결 테스트 오류:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
