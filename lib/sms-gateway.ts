// SMS Gate(안드로이드 휴대폰 게이트웨이) 클라우드 릴레이 클라이언트.
// 솔라피(lib/solapi.ts)와 짝을 이루는 v2 발송 엔진.
// 웹앱에서 발송 명령을 클라우드로 보내면 등록된 내 휴대폰이 통신사망으로 실제 발송한다.
// → 내 문자 무제한 요금제를 쓰므로 발송비 0원, [Web발신] 태그도 붙지 않음.
// 문서: https://docs.sms-gate.app

export { getByteLength, getMessageType, substituteTemplate } from "./sms-utils";

const SMS_GATEWAY_BASE_URL =
  process.env.SMS_GATEWAY_BASE_URL || "https://api.sms-gate.app/3rdparty/v1";

function getAuthHeader(): string {
  const username = process.env.SMS_GATEWAY_USERNAME;
  const password = process.env.SMS_GATEWAY_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "SMS_GATEWAY_USERNAME 또는 SMS_GATEWAY_PASSWORD 환경변수가 설정되지 않았습니다."
    );
  }
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

/** 국내 전화번호를 E.164(+82...) 형식으로 변환 (게이트웨이 발송 필수 형식) */
export function toE164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("82")) return `+${digits}`;
  if (digits.startsWith("0")) return `+82${digits.slice(1)}`;
  return `+${digits}`;
}

interface GatewaySendResponse {
  id: string;
  state: string;
  recipients?: Array<{ phoneNumber: string; state: string }>;
}

/**
 * 휴대폰 게이트웨이로 단일 메시지 발송.
 * 클라우드 릴레이에 발송 명령을 큐잉하고 즉시 messageId를 반환한다.
 * 실제 발송은 폰이 통신사망으로 비동기 처리(폰 측 속도제한으로 스팸 차단 방지).
 */
export async function sendGatewayMessage(
  to: string,
  text: string
): Promise<{ messageId: string; state: string }> {
  const res = await fetch(`${SMS_GATEWAY_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify({
      textMessage: { text },
      phoneNumbers: [toE164(to)],
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`SMS 게이트웨이 오류 (${res.status}): ${errorBody}`);
  }

  const data = (await res.json()) as GatewaySendResponse;
  return { messageId: data.id, state: data.state };
}
