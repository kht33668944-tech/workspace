import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { notifyAutomationResult, type AutomationNotifyStatus, type DiscordChannel } from "@/lib/discord-notifier";

export const maxDuration = 30;

const VALID_STATUS: AutomationNotifyStatus[] = ["success", "partial", "failed", "cancelled"];
const VALID_CHANNELS: DiscordChannel[] = ["orders", "tracking", "purchase", "price", "ai", "default"];

interface NotifyBody {
  title?: string;
  status?: AutomationNotifyStatus;
  summary?: string;
  fields?: { name: string; value: string | number }[];
  /** 보낼 디스코드 채널. 생략 시 제목으로 추론 */
  channel?: DiscordChannel;
}

// 클라이언트가 다계정 작업 등을 합산해 디스코드 알림을 1회만 보내기 위한 범용 엔드포인트
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

  const body = (await request.json()) as NotifyBody;
  const status: AutomationNotifyStatus = body.status && VALID_STATUS.includes(body.status) ? body.status : "success";

  await notifyAutomationResult({
    title: body.title?.trim() || "자동화 작업",
    status,
    summary: body.summary?.trim() || "작업이 끝났습니다.",
    fields: Array.isArray(body.fields) ? body.fields.slice(0, 10) : undefined,
    channel: body.channel && VALID_CHANNELS.includes(body.channel) ? body.channel : undefined,
  });

  return NextResponse.json({ ok: true });
}
