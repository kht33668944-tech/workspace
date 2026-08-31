"use client";

// 자동화 즉시 실행 공용 로직 (상태 카드·오류 센터에서 사용)

import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { AUTOMATION_BY_KEY, type AutomationKey } from "@/lib/automation-schedule";

export async function runAutomation(key: AutomationKey, token: string): Promise<{ ok: boolean; message: string }> {
  const def = AUTOMATION_BY_KEY[key];
  if (!def.runVia) return { ok: false, message: "즉시 실행을 지원하지 않는 자동화입니다." };

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

/** 즉시 실행 버튼 공용 훅 — 토스트·3초 뒤 새로고침·중복 클릭 방지까지 처리 */
export function useRunAutomation(onRefetch: () => Promise<void>) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (key: AutomationKey, busyKey: string = key) => {
    if (!session?.access_token || busyId) return;
    setBusyId(busyKey);
    try {
      const r = await runAutomation(key, session.access_token);
      showToast(r.message, r.ok ? "success" : "error");
      if (r.ok) setTimeout(() => { void onRefetch(); }, 3000);
    } finally {
      setBusyId(null);
    }
  };

  return { busyId, run };
}
