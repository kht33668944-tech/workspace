// SMS Gate(안드로이드 휴대폰 게이트웨이) 클라우드 릴레이 클라이언트.
// 솔라피(lib/solapi.ts)와 짝을 이루는 v2 발송 엔진.
// 웹앱에서 발송 명령을 클라우드로 보내면 등록된 내 휴대폰이 통신사망으로 실제 발송한다.
// → 내 문자 무제한 요금제를 쓰므로 발송비 0원, [Web발신] 태그도 붙지 않음.
// 문서: https://docs.sms-gate.app

export { getByteLength, getMessageType, substituteTemplate } from "./sms-utils";

const SMS_GATEWAY_BASE_URL =
  process.env.SMS_GATEWAY_BASE_URL || "https://api.sms-gate.app/3rdparty/v1";

// 문자 유통기한(초). 폰이 오프라인이라 이 시간 안에 발송 못 하면 큐에서 자동 만료.
// 퍼블릭 클라우드의 "미처리 24시간" 한도에 걸려 신규 발송이 통째로 막히는 사태를 방지.
// 기본 6시간(24h보다 충분히 짧게). SMS_GATEWAY_TTL_SECONDS로 조정 가능.
const SMS_GATEWAY_TTL_SECONDS = Number(process.env.SMS_GATEWAY_TTL_SECONDS) || 21600;

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

/**
 * 게이트웨이로 보낼 수신번호 포맷을 결정한다.
 * - 실제 휴대폰(010/011/016/017/018/019) → E.164(+82...). 검증된 정상 발송 경로.
 * - 그 외(안심번호 0502/0504, 070 등) → 로컬 형식(숫자만, 앞자리 0 유지) 그대로.
 *   안심번호는 휴대폰 메시지 앱에서 직접 0502...로 보내듯 국내번호 형식이어야
 *   통신사 안심번호 릴레이가 실번호로 포워딩한다. E.164(+82 50...)는 국제표기로
 *   해석돼 국내 안심번호 라우팅이 깨질 수 있어 변환하지 않는다.
 *   (이 경우 발송 요청 시 skipPhoneValidation=true 로 게이트웨이의 E.164 검증을 끈다.)
 */
export function formatGatewayNumber(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (/^01[016789]/.test(digits)) return toE164(digits);
  return digits;
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
  // skipPhoneValidation=true: 게이트웨이의 E.164/모바일 검증을 끈다.
  // (안심번호 050x 등 비-모바일 번호도 발송 큐잉되도록)
  const res = await fetch(`${SMS_GATEWAY_BASE_URL}/messages?skipPhoneValidation=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify({
      textMessage: { text },
      phoneNumbers: [formatGatewayNumber(to)],
      ttl: SMS_GATEWAY_TTL_SECONDS, // 미발송 시 자동 만료 → 큐 적체·24h 차단 방지
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`SMS 게이트웨이 오류 (${res.status}): ${errorBody}`);
  }

  const data = (await res.json()) as GatewaySendResponse;
  return { messageId: data.id, state: data.state };
}

interface GatewayDeviceRaw {
  id: string;
  name?: string;
  lastSeen?: string;
  last_seen?: string;
}

/** 게이트웨이에 등록된 발송 폰 목록 조회 (lastSeen = 마지막 클라우드 접속 시각). */
export async function getGatewayDevices(): Promise<
  Array<{ id: string; name: string; lastSeen: string | null }>
> {
  const res = await fetch(`${SMS_GATEWAY_BASE_URL}/devices`, {
    headers: { Authorization: getAuthHeader() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SMS 게이트웨이 기기 조회 오류 (${res.status}): ${body}`);
  }
  const data = (await res.json()) as GatewayDeviceRaw | GatewayDeviceRaw[];
  const list = Array.isArray(data) ? data : [data];
  return list.map((d) => ({
    id: d.id,
    name: d.name || "",
    lastSeen: d.lastSeen || d.last_seen || null,
  }));
}

/**
 * 발송 폰(SMS Gate 앱)이 최근 maxOfflineMinutes 내에 접속했는지 확인.
 * 오프라인이면 online=false + 사람이 읽을 사유 반환. 조회 실패 시엔 발송을 막지 않도록 online=true.
 * 배치 발송 직전 사전 점검용 — 폰이 죽어있는데 조용히 큐에 쌓이는 사태를 미리 경고.
 */
export async function checkGatewayOnline(
  maxOfflineMinutes = 30
): Promise<{ online: boolean; reason?: string; lastSeen?: string; offlineMinutes?: number }> {
  try {
    const devices = await getGatewayDevices();
    if (devices.length === 0) {
      return { online: false, reason: "등록된 발송 폰이 없습니다. SMS Gate 앱을 확인하세요." };
    }
    // 가장 최근에 접속한 기기 기준으로 판단
    let newest: { lastSeen: string | null } | null = null;
    for (const d of devices) {
      if (!d.lastSeen) continue;
      if (!newest || new Date(d.lastSeen) > new Date(newest.lastSeen!)) newest = d;
    }
    if (!newest?.lastSeen) {
      return { online: false, reason: "발송 폰의 접속 기록이 없습니다. SMS Gate 앱을 여세요." };
    }
    const offlineMinutes = Math.round(
      (Date.now() - new Date(newest.lastSeen).getTime()) / 60000
    );
    if (offlineMinutes > maxOfflineMinutes) {
      return {
        online: false,
        lastSeen: newest.lastSeen,
        offlineMinutes,
        reason: `발송 폰(SMS Gate 앱)이 약 ${offlineMinutes}분째 오프라인입니다. 폰에서 앱을 열어 재접속하세요. (그대로 발송 시 문자가 지연·만료될 수 있음)`,
      };
    }
    return { online: true, lastSeen: newest.lastSeen, offlineMinutes };
  } catch (e) {
    // 상태 조회 자체가 실패하면 발송을 막지 않고 통과(경고만).
    return { online: true, reason: `기기 상태 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}
