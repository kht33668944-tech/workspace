// 지마켓 반품신청 자동화 직후 고객 안내 문자 (설정 return_sms)
//  - 대상: 한 주문의 반품 신청을 모두 마친 반품 건 (교환 건은 템플릿이 반품용이라 보내지 않는다)
//  - 번호: 주문자번호 우선, 없으면 수령자번호 — 마켓 반품 접수 때 재발급된 안심번호가 이미 반영돼 있다 (order-sync applyClaim)
//  - 경로: 휴대폰(SMS Gate) — 단체문자와 같은 KT 일일 한도 검사, sms_logs 기록(provider phone, batch_id "auto-return:…")
//  - 같은 주문에 두 번 보내지 않는다 (sms_logs order_id + batch_id 접두어로 판정)
//  - 문자 실패는 반품 신청 결과에 영향을 주지 않는다 (호출 측에서 상태만 보고)

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { getAppSetting, RETURN_SMS_DEFAULT_TEMPLATE, type ReturnSmsSetting } from "@/lib/app-settings";
import { countTodayPhoneSms, SMS_DAILY_LIMIT } from "@/lib/sms-daily-limit";
import { checkGatewayOnline, sendGatewayMessage } from "@/lib/sms-gateway";
import { substituteTemplate } from "@/lib/sms-utils";
import { formatKoreanDateTime } from "@/lib/date-utils";

// eslint-disable-next-line
type AnySupabase = SupabaseClient<any, any, any>;

export const RETURN_SMS_BATCH_PREFIX = "auto-return:";

export type ReturnSmsStatus = "sent" | "skipped" | "failed";
export interface ReturnSmsResult {
  status: ReturnSmsStatus;
  message: string;
  /** 마스킹한 수신번호 */
  phone?: string;
}

interface OrderRow {
  id: string;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number | null;
  marketplace: string | null;
  courier: string | null;
  tracking_no: string | null;
  order_date: string | null;
  address: string | null;
  address_detail: string | null;
  delivery_memo: string | null;
  recipient_phone: string | null;
  orderer_phone: string | null;
}

const maskPhone = (p: string) => p.replace(/(\d{3,4})(\d{3,4})(\d{4})$/, "$1-****-$3");

/** 설정이 켜져 있으면 반품 안내 문자 1통 발송. 항상 결과를 돌려주고 throw 하지 않는다 */
export async function sendReturnRequestedSms(supabase: AnySupabase, userId: string, orderId: string): Promise<ReturnSmsResult> {
  try {
    const setting = await getAppSetting<ReturnSmsSetting>(supabase, userId, "return_sms");
    if (!setting?.enabled) return { status: "skipped", message: "자동 문자 꺼짐" };
    const templateName = setting.templateName?.trim() || RETURN_SMS_DEFAULT_TEMPLATE;

    // 중복 방지 — 이미 이 주문으로 자동 문자를 보냈으면 건너뛴다
    const { data: prior } = await supabase
      .from("sms_logs")
      .select("id")
      .eq("user_id", userId)
      .eq("order_id", orderId)
      .like("batch_id", `${RETURN_SMS_BATCH_PREFIX}%`)
      .eq("status", "success")
      .limit(1);
    if (prior && prior.length > 0) return { status: "skipped", message: "이미 발송됨" };

    const { data: tpl, error: tplErr } = await supabase
      .from("sms_templates")
      .select("content")
      .eq("user_id", userId)
      .eq("name", templateName)
      .limit(1)
      .maybeSingle();
    if (tplErr) return { status: "failed", message: `템플릿 조회 실패: ${tplErr.message}` };
    const content = (tpl as { content?: string } | null)?.content?.trim();
    if (!content) return { status: "failed", message: `템플릿 "${templateName}" 없음 — 단체문자 화면에서 만들어 두세요` };

    const { data: orderRow, error: orderErr } = await supabase
      .from("orders")
      .select("id, recipient_name, product_name, quantity, marketplace, courier, tracking_no, order_date, address, address_detail, delivery_memo, recipient_phone, orderer_phone")
      .eq("id", orderId)
      .eq("user_id", userId)
      .maybeSingle();
    if (orderErr || !orderRow) return { status: "failed", message: `주문 조회 실패: ${orderErr?.message ?? "없음"}` };
    const order = orderRow as OrderRow;

    const rawPhone = (order.orderer_phone || order.recipient_phone || "").replace(/[^0-9]/g, "");
    if (rawPhone.length < 10) return { status: "failed", message: "유효한 전화번호 없음" };

    // KT 일일 한도 — 단체문자와 같은 규칙
    const used = await countTodayPhoneSms(supabase, userId);
    if (used !== null && used + 1 > SMS_DAILY_LIMIT) {
      return { status: "failed", message: `KT 일일 한도(${SMS_DAILY_LIMIT}건) 초과 — 오늘 ${used}건` };
    }

    const text = substituteTemplate(content, {
      recipient_name: order.recipient_name || "",
      product_name: order.product_name || "",
      quantity: String(order.quantity || 1),
      marketplace: order.marketplace || "",
      courier: order.courier || "",
      tracking_no: order.tracking_no || "",
      order_date: order.order_date ? formatKoreanDateTime(order.order_date) : "",
      address: [order.address, order.address_detail].filter(Boolean).join(" "),
      delivery_memo: order.delivery_memo || "",
    });

    const batchId = `${RETURN_SMS_BATCH_PREFIX}${randomUUID()}`;
    const gw = await checkGatewayOnline(30);
    const offlineNote = gw.online ? "" : ` (발송 폰 오프라인 의심: ${gw.reason})`;
    try {
      const result = await sendGatewayMessage(rawPhone, text);
      await supabase.from("sms_logs").insert({
        user_id: userId, batch_id: batchId, order_id: orderId, phone: rawPhone, message: text,
        status: "success", error_message: null, message_id: result.messageId || null, provider: "phone",
      });
      return { status: "sent", message: `문자 발송 요청됨${offlineNote}`, phone: maskPhone(rawPhone) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase.from("sms_logs").insert({
        user_id: userId, batch_id: batchId, order_id: orderId, phone: rawPhone, message: text,
        status: "failed", error_message: msg, message_id: null, provider: "phone",
      });
      return { status: "failed", message: `문자 발송 실패: ${msg}`, phone: maskPhone(rawPhone) };
    }
  } catch (e) {
    return { status: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}
