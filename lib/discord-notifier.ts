export type AutomationNotifyStatus = "success" | "partial" | "failed" | "cancelled";

interface AutomationNotifyField {
  name: string;
  value: string | number;
}

/** 디스코드 채널 (채널별 웹훅 환경변수). 없으면 DISCORD_WEBHOOK_URL 로 */
export type DiscordChannel = "orders" | "tracking" | "purchase" | "price" | "ai" | "default";

const CHANNEL_ENV: Record<DiscordChannel, string> = {
  orders: "DISCORD_WEBHOOK_ORDERS",     // 주문수집-자동화: 주문 수집·취소요청·정산
  tracking: "DISCORD_WEBHOOK_TRACKING", // 운송장수집-자동화: 운송장 수집·송장 전송·ESM 엑셀
  purchase: "DISCORD_WEBHOOK_PURCHASE", // 구매자동화
  price: "DISCORD_WEBHOOK_PRICE",       // 가격재고-자동화
  ai: "DISCORD_WEBHOOK_AI",             // AI 상세페이지 등
  default: "DISCORD_WEBHOOK_URL",
};

/** 제목으로 채널 추론 (channel 을 명시하지 않은 기존 호출부용) */
export function inferDiscordChannel(title: string): DiscordChannel {
  if (/운송장|송장/.test(title)) return "tracking";
  if (/구매/.test(title)) return "purchase";
  if (/가격|재고|최저가/.test(title)) return "price";
  if (/주문|정산|취소|클레임/.test(title)) return "orders";
  if (/AI|상세페이지/.test(title)) return "ai";
  return "default";
}

interface AutomationNotifyInput {
  title: string;
  status: AutomationNotifyStatus;
  summary: string;
  fields?: AutomationNotifyField[];
  /** 보낼 채널. 생략 시 제목으로 추론 */
  channel?: DiscordChannel;
}

const STATUS_LABEL: Record<AutomationNotifyStatus, string> = {
  success: "완료",
  partial: "일부 실패",
  failed: "실패",
  cancelled: "취소",
};

const STATUS_COLOR: Record<AutomationNotifyStatus, number> = {
  success: 0x22c55e,
  partial: 0xf59e0b,
  failed: 0xef4444,
  cancelled: 0x64748b,
};

function trimForDiscord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getWebhookUrl(channel: DiscordChannel): string | null {
  const specific = process.env[CHANNEL_ENV[channel]]?.trim();
  if (specific && specific.startsWith("https://")) return specific;
  const url = process.env.DISCORD_WEBHOOK_URL?.trim();
  return url && url.startsWith("https://") ? url : null;
}

export async function notifyAutomationResult(input: AutomationNotifyInput): Promise<void> {
  const webhookUrl = getWebhookUrl(input.channel ?? inferDiscordChannel(input.title));
  if (!webhookUrl) return;

  const embed = {
    title: trimForDiscord(`${input.title} ${STATUS_LABEL[input.status]}`, 256),
    description: trimForDiscord(input.summary, 4096),
    color: STATUS_COLOR[input.status],
    fields: input.fields?.slice(0, 10).map((field) => ({
      name: trimForDiscord(field.name, 256),
      value: trimForDiscord(String(field.value), 1024),
      inline: true,
    })),
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(`[discord-notifier] 알림 전송 실패: ${response.status} ${text.slice(0, 200)}`);
    }
  } catch (error) {
    console.warn("[discord-notifier] 알림 전송 오류:", error instanceof Error ? error.message : String(error));
  }
}
