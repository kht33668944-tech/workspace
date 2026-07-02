export type AutomationNotifyStatus = "success" | "partial" | "failed" | "cancelled";

interface AutomationNotifyField {
  name: string;
  value: string | number;
}

interface AutomationNotifyInput {
  title: string;
  status: AutomationNotifyStatus;
  summary: string;
  fields?: AutomationNotifyField[];
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

function getWebhookUrl(): string | null {
  const url = process.env.DISCORD_WEBHOOK_URL?.trim();
  return url && url.startsWith("https://") ? url : null;
}

export async function notifyAutomationResult(input: AutomationNotifyInput): Promise<void> {
  const webhookUrl = getWebhookUrl();
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
