// app_settings (user_id, key, value jsonb) — 사용자별 기능 설정 (자동 승인 등)

import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

export type AppSettingKey = "auto_approve_cancel" | "auto_reply_inquiry" | "auto_purchase" | "return_sms";

export interface ReturnSmsSetting {
  enabled: boolean;
  /** sms_templates.name — 지마켓 반품신청 완료 직후 보낼 템플릿 (기본 "반품 신청") */
  templateName?: string;
}

export interface AutoApproveCancelSetting {
  enabled: boolean;
}

export interface AutoReplyInquirySetting {
  enabled: boolean;
}

export interface AutoPurchaseSetting {
  enabled: boolean;
  /** 플랫폼별 기본 구매계정 login_id (purchase_credentials 매칭) — 예: { gmarket: "joker3733" } */
  accounts: Record<string, string>;
}

export const APP_SETTING_DEFAULTS: Record<AppSettingKey, unknown> = {
  auto_approve_cancel: { enabled: false } satisfies AutoApproveCancelSetting,
  // AI가 단순 배송문의에 자동 답변. 기본 꺼짐 — 쿠팡 고객센터 문의는 링크 응답 등
  // 일반 답변으로 해결 안 되는 건이 있어 사람이 확인 후 전송하는 것을 기본으로 한다
  auto_reply_inquiry: { enabled: false } satisfies AutoReplyInquirySetting,
  // 주문수집 직후 원가갱신→계정배정→자동구매까지 무인 실행. 기본 꺼짐 —
  // 실결제가 발생하므로 자동화 전담 PC에서만 설정 페이지 토글로 켠다
  auto_purchase: { enabled: false, accounts: {} } satisfies AutoPurchaseSetting,
  // 지마켓 반품신청 자동화가 한 주문의 반품 신청을 모두 마친 직후, 마켓이 재발급한 안심번호(주문자번호)로
  // "반품 신청" 템플릿 문자를 휴대폰 경로로 1통 보낸다. 기본 꺼짐 — 자동화 페이지 토글로 켠다
  return_sms: { enabled: false, templateName: "반품 신청" } satisfies ReturnSmsSetting,
};

export const RETURN_SMS_DEFAULT_TEMPLATE = "반품 신청";

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
