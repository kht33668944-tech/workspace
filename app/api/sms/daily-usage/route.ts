import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { countTodayPhoneSms, SMS_DAILY_LIMIT, SMS_DAILY_WARN } from "@/lib/sms-daily-limit";

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const userSupabase = getSupabaseClient(token);
  const { data: { user } } = await userSupabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const used = await countTodayPhoneSms(getServiceSupabaseClient(), user.id);

  return NextResponse.json({
    used,
    limit: SMS_DAILY_LIMIT,
    warnAt: SMS_DAILY_WARN,
  });
}
