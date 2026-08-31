"use client";

// app_settings 의 { enabled: boolean } 형 설정 공용 토글 (취소요청 자동승인·AI 문의 자동답변 등)
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

export default function AppSettingToggle({ settingKey, icon, title, description, confirmText, onMessage, offMessage }: {
  settingKey: string;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  /** 켤 때 confirm 으로 물어볼 문구 */
  confirmText: string;
  onMessage: string;
  offMessage: string;
}) {
  const { session } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/app-settings", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = (await res.json()) as Record<string, { enabled?: boolean } | undefined>;
      setEnabled(!!data[settingKey]?.enabled);
    } catch { /* 기본값 */ } finally { setLoading(false); }
  }, [session?.access_token, settingKey]);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    if (!session?.access_token) return;
    const next = !enabled;
    if (next && !confirm(confirmText)) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/app-settings", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ key: settingKey, value: { enabled: next } }) });
      if (!res.ok) { const d = (await res.json()) as { error?: string }; setMsg(d.error ?? "저장 실패"); return; }
      setEnabled(next);
      setMsg(next ? onMessage : offMessage);
    } catch { setMsg("저장 중 오류"); } finally { setSaving(false); }
  };

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">{icon} {title}</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">{description}</p>
          {msg && <p className="text-xs text-[var(--text-secondary)] mt-2">{msg}</p>}
        </div>
        <button onClick={toggle} disabled={loading || saving} className={`shrink-0 px-4 py-2 text-sm rounded-lg disabled:opacity-50 ${enabled ? "bg-green-600 text-white" : "bg-[var(--bg-hover)] text-[var(--text-secondary)]"}`}>
          {loading || saving ? <Loader2 className="w-4 h-4 animate-spin" /> : enabled ? "켜짐" : "꺼짐"}
        </button>
      </div>
    </section>
  );
}
