// app_settings (user_id, key, value jsonb) — 사용자별 기능 설정 (자동 승인 등)

import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

export type AppSettingKey = "auto_approve_cancel";

export interface AutoApproveCancelSetting {
  enabled: boolean;
}

export const APP_SETTING_DEFAULTS: Record<AppSettingKey, unknown> = {
  auto_approve_cancel: { enabled: false } satisfies AutoApproveCancelSetting,
};

export async function getAppSetting<T>(supabase: AnySupabase, userId: string, key: AppSettingKey): Promise<T | null> {
  const { data, error } = await supabase.from("app_settings").select("value").eq("user_id", userId).eq("key", key).maybeSingle();
  if (error) {
    // 테이블이 아직 없으면(마이그레이션 전) 기본값
    console.warn("[app-settings] 조회 실패:", error.message);
    return (APP_SETTING_DEFAULTS[key] as T) ?? null;
  }
  return ((data as { value: T } | null)?.value ?? (APP_SETTING_DEFAULTS[key] as T)) ?? null;
}

export async function setAppSetting(supabase: AnySupabase, userId: string, key: AppSettingKey, value: unknown) {
  const { error } = await supabase.from("app_settings").upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
  if (error) throw new Error(`설정 저장 실패: ${error.message}`);
}
