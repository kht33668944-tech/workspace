import crypto from "crypto";

export { getByteLength, getMessageType, substituteTemplate } from "./sms-utils";

const SOLAPI_BASE_URL = "https://api.solapi.com";

interface SolapiMessage {
  to: string;
  from: string;
  text: string;
  type?: "SMS" | "LMS";
}

export interface SolapiResponse {
  groupId: string;
  messageCount: { total: number; sentTotal: number; sentFailed: number; sentSuccess: number };
  failedMessageList: Array<{
    to: string;
    statusCode: string;
    statusMessage: string;
    messageId: string;
  }>;
}

function getAuthHeader(): string {
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("SOLAPI_API_KEY 또는 SOLAPI_API_SECRET 환경변수가 설정되지 않았습니다.");
  }

  const date = new Date().toISOString();
  const salt = crypto.randomUUID();
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(date + salt)
    .digest("hex");

  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

import { getMessageType as _getMessageType } from "./sms-utils";

export async function sendMessages(
  messages: Array<{ to: string; text: string }>
): Promise<SolapiResponse> {
  const senderPhone = process.env.SOLAPI_SENDER_PHONE;
  if (!senderPhone) {
    throw new Error("SOLAPI_SENDER_PHONE 환경변수가 설정되지 않았습니다.");
  }

  const solapiMessages: SolapiMessage[] = messages.map((m) => ({
    to: m.to.replace(/[^0-9]/g, ""),
    from: senderPhone.replace(/[^0-9]/g, ""),
    text: m.text,
    type: _getMessageType(m.text),
  }));

  const res = await fetch(`${SOLAPI_BASE_URL}/messages/v4/send-many`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify({ messages: solapiMessages }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`솔라피 API 오류 (${res.status}): ${errorBody}`);
  }

  return res.json();
}
