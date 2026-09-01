import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const { credentialId } = (await request.json()) as { credentialId?: string };
    if (!credentialId) return NextResponse.json({ error: "스마트스토어 API 계정을 선택하세요." }, { status: 400 });

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

    const { client, credential } = await getNaverClientFromCredential(supabase, credentialId);
    const result = await client.getChannels();
    const channels = result.ok && Array.isArray(result.body) ? result.body : [];
    const status = result.ok ? "success" : "failed";
    const channelNames = channels.map((c) => `${c.name}(${c.channelNo})`).join(", ");
    const message = result.ok ? `스마트스토어 API 연결 확인: ${channelNames || "채널 없음"}` : result.message;

    const update: Record<string, unknown> = {
      last_tested_at: new Date().toISOString(),
      last_test_status: status,
      last_test_message: message,
    };
    const first = channels[0];
    if (first) {
      update.meta = { ...(credential.meta ?? {}), channelName: first.name, channelUrl: first.url ?? null };
      // account_id 가 임시값이면 첫 채널번호로 채운다
      if (!credential.account_id || credential.account_id === "-" || credential.account_id === "smartstore") {
        update.account_id = String(first.channelNo);
      }
    }
    await supabase.from("marketplace_api_credentials").update(update).eq("id", credentialId);

    await supabase.from("marketplace_api_logs").insert({
      user_id: userData.user.id,
      platform: "smartstore",
      credential_id: credentialId,
      action: "test",
      status,
      response_payload: typeof result.body === "object" ? { channels: result.body } : { body: result.body },
      error_message: result.ok ? null : message,
    });

    return NextResponse.json({ success: result.ok, message, status: result.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[smartstore-api] 연결 테스트 오류:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
