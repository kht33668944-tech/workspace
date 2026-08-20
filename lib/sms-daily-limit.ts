// KT 일일 문자 발송 한도 대응.
// KT는 일 300건 초과 시 경고 문자, 일 500건 도달 시 당일 발송을 차단한다.
// 차단 상태에서도 SMS Gate는 요청을 정상 접수하고 sms_logs에 success로 남기지만
// 통신사가 실제 발송을 막아, TTL(6시간) 만료로 조용히 소멸한다.
// → 화면상 전건 성공인데 고객에겐 한 통도 안 가는 사태를 막기 위한 사전 차단 로직.
import type { SupabaseClient } from "@supabase/supabase-js";

/** 이 값을 초과하는 발송은 차단한다. */
export const SMS_DAILY_LIMIT = Number(process.env.SMS_DAILY_LIMIT) || 500;
/** 이 값을 초과하면 경고를 표시한다(발송은 허용). */
export const SMS_DAILY_WARN = Number(process.env.SMS_DAILY_WARN) || 300;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 오늘(KST) 자정을 UTC Date로 반환.
 * 서버 타임존에 의존하지 않도록 UTC 기준으로 명시 계산한다.
 * (Railway 컨테이너는 UTC라 로컬 날짜를 쓰면 KST 날짜 경계와 최대 9시간 어긋난다.)
 */
export function getKstMidnightUtc(now: Date = new Date()): Date {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const midnightKstAsUtc = Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate()
  );
  return new Date(midnightKstAsUtc - KST_OFFSET_MS);
}

/**
 * 오늘(KST) 휴대폰 경로로 접수한 문자 건수.
 * SOLAPI는 KT 회선을 쓰지 않으므로 제외한다.
 * 실제 발송(Sent) 기준이 아니라 큐 접수 기준이라 실제보다 크거나 같게 잡히는데,
 * 한도 판단에서는 보수적인 방향이라 의도된 동작이다.
 * 집계 실패 시 null을 반환한다(카운터는 보조 장치이므로 발송을 막지 않는다).
 */
export async function countTodayPhoneSms(
  supabase: SupabaseClient,
  userId: string
): Promise<number | null> {
  try {
    const since = getKstMidnightUtc().toISOString();
    const { count, error } = await supabase
      .from("sms_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("provider", "phone")
      .gte("created_at", since);

    if (error) {
      console.warn(`[sms-daily-limit] 사용량 집계 실패: ${error.message}`);
      return null;
    }
    return count ?? 0;
  } catch (e) {
    console.warn(
      `[sms-daily-limit] 사용량 집계 예외: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}
