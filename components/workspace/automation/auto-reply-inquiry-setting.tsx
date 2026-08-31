"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Bot } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

export default function AutoReplyInquirySetting() {
  const { session } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/app-settings", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = (await res.json()) as { auto_reply_inquiry?: { enabled?: boolean } };
      setEnabled(!!data.auto_reply_inquiry?.enabled);
    } catch { /* 기본값 */ } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    if (!session?.access_token) return;
    const next = !enabled;
    if (next && !confirm("배송 확인처럼 주문 데이터로 확답 가능한 단순 문의는 AI가 사람 확인 없이 자동으로 답변을 전송합니다 (회당 최대 5건). 켤까요?")) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/app-settings", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ key: "auto_reply_inquiry", value: { enabled: next } }) });
      if (!res.ok) { const d = (await res.json()) as { error?: string }; setMsg(d.error ?? "저장 실패"); return; }
      setEnabled(next);
      setMsg(next ? "AI 자동답변이 켜졌습니다. 다음 문의 수집부터 적용됩니다." : "AI 자동답변을 껐습니다. AI는 초안만 준비합니다.");
    } catch { setMsg("저장 중 오류"); } finally { setSaving(false); }
  };

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2"><Bot className="w-4 h-4 text-[var(--text-muted)]" /> AI 문의 자동답변</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            문의 수집(1시간마다) 때 <b>배송 진행·운송장 확인처럼 주문 데이터로 확답 가능한 단순 문의만</b> AI가 자동으로 답변합니다.
            취소·반품·상품 스펙 등 판단이 필요한 문의는 항상 초안만 준비하고 대기합니다. 꺼져 있으면 모든 문의가 대기(초안만)입니다.
          </p>
          {msg && <p className="text-xs text-[var(--text-secondary)] mt-2">{msg}</p>}
        </div>
        <button onClick={toggle} disabled={loading || saving} className={`shrink-0 px-4 py-2 text-sm rounded-lg disabled:opacity-50 ${enabled ? "bg-green-600 text-white" : "bg-[var(--bg-hover)] text-[var(--text-secondary)]"}`}>
          {loading || saving ? <Loader2 className="w-4 h-4 animate-spin" /> : enabled ? "켜짐" : "꺼짐"}
        </button>
      </div>
    </section>
  );
}
