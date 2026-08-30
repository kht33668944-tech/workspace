"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

export default function AutoApproveSetting() {
  const { session } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/app-settings", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = (await res.json()) as { auto_approve_cancel?: { enabled?: boolean } };
      setEnabled(!!data.auto_approve_cancel?.enabled);
    } catch { /* 기본값 */ } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    if (!session?.access_token) return;
    const next = !enabled;
    if (next && !confirm("운송장이 없고 아직 구매(발주)하지 않은 취소요청은 사람 확인 없이 자동 승인됩니다. 켤까요?")) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/app-settings", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ key: "auto_approve_cancel", value: { enabled: next } }) });
      if (!res.ok) { const d = (await res.json()) as { error?: string }; setMsg(d.error ?? "저장 실패"); return; }
      setEnabled(next);
      setMsg(next ? "자동 승인이 켜졌습니다. 다음 주문 수집부터 적용됩니다." : "자동 승인을 껐습니다.");
    } catch { setMsg("저장 중 오류"); } finally { setSaving(false); }
  };

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-[var(--text-muted)]" /> 취소요청 자동 승인</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            주문 수집(1시간마다) 때 새로 들어온 구매자 취소요청 중 <b>운송장이 없고 아직 구매하지 않은 건</b>만 자동으로 승인합니다.
            운송장이 있거나 이미 구매한 건은 디스코드로 알리고 사람이 승인/거절합니다.
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
