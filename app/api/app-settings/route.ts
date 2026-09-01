import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { APP_SETTING_DEFAULTS, getAppSetting, setAppSetting, type AppSettingKey } from "@/lib/app-settings";

const KEYS = Object.keys(APP_SETTING_DEFAULTS) as AppSettingKey[];

/** GET → { auto_approve_cancel: {...}, ... } */
export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const supabase = getSupabaseClient(token);
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
  const out: Record<string, unknown> = {};
  for (const k of KEYS) out[k] = await getAppSetting(supabase, userData.user.id, k);
  return NextResponse.json(out);
}

/** PUT { key, value } */
export async function PUT(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  try {
    const body = (await request.json()) as { key?: string; value?: unknown };
    if (!body.key || !KEYS.includes(body.key as AppSettingKey)) return NextResponse.json({ error: "알 수 없는 설정 키" }, { status: 400 });
    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    await setAppSetting(supabase, userData.user.id, body.key as AppSettingKey, body.value ?? {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[app-settings] 저장 오류:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
