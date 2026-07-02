import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { notifyAutomationResult } from "@/lib/discord-notifier";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

  await notifyAutomationResult({
    title: "디스코드 알림 테스트",
    status: "success",
    summary: "테스트 알림입니다. 이 메시지가 보이면 디스코드 연동이 정상입니다.",
    fields: [
      { name: "결과", value: "연동 정상" },
    ],
  });

  return NextResponse.json({ ok: true });
}
