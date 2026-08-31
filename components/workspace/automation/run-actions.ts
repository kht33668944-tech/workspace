// 자동화 즉시 실행 공용 로직 (상태 카드·오류 센터에서 사용)

import { AUTOMATIONS, type AutomationKey } from "@/lib/automation-schedule";

export async function runAutomation(key: AutomationKey, token: string): Promise<{ ok: boolean; message: string }> {
  const def = AUTOMATIONS.find((d) => d.key === key);
  if (!def || !def.runVia) return { ok: false, message: "즉시 실행을 지원하지 않는 자동화입니다." };

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  try {
    if (def.runVia === "api" && def.apiPath) {
      const res = await fetch(def.apiPath, { method: "POST", headers, body: JSON.stringify({ platform: "all" }) });
      const json = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) return { ok: false, message: json.error ?? `실행 실패 (${res.status})` };
      return { ok: true, message: `${def.label} 실행 완료` };
    }
    const res = await fetch("/api/automation/run", { method: "POST", headers, body: JSON.stringify({ task: key }) });
    const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
    if (!res.ok) return { ok: false, message: json.error ?? `실행 실패 (${res.status})` };
    return { ok: true, message: json.message ?? `${def.label} 시작됨` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
