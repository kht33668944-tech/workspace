"use client";

// 자동구매 설정 — enabled 토글 + 플랫폼별 기본 구매계정 (app_settings.auto_purchase)
// AppSettingToggle 은 { enabled } 전용이라 계정 입력이 있는 이 설정은 전용 컴포넌트로 만든다
import { useCallback, useEffect, useState } from "react";
import { Loader2, ShoppingCart } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface AutoPurchaseValue {
  enabled: boolean;
  accounts: Record<string, string>;
}

export default function AutoPurchaseSetting() {
  const { session } = useAuth();
  const [value, setValue] = useState<AutoPurchaseValue>({ enabled: false, accounts: {} });
  const [gmarketId, setGmarketId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/app-settings", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = (await res.json()) as Record<string, AutoPurchaseValue | undefined>;
      const v = data.auto_purchase ?? { enabled: false, accounts: {} };
      setValue({ enabled: !!v.enabled, accounts: v.accounts ?? {} });
      setGmarketId(v.accounts?.gmarket ?? "");
    } catch { /* 기본값 유지 */ } finally { setLoading(false); }
  }, [session?.access_token]);

  useEffect(() => { load(); }, [load]);

  const save = async (next: AutoPurchaseValue, doneMsg: string) => {
    if (!session?.access_token) return;
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/app-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ key: "auto_purchase", value: next }),
      });
      if (!res.ok) { const d = (await res.json()) as { error?: string }; setMsg(d.error ?? "저장 실패"); return; }
      setValue(next);
      setMsg(doneMsg);
    } catch { setMsg("저장 중 오류"); } finally { setSaving(false); }
  };

  const toggle = () => {
    const next = !value.enabled;
    if (next) {
      const account = gmarketId.trim();
      if (!account) { setMsg("먼저 지마켓 구매계정 아이디를 입력하고 저장하세요."); return; }
      if (!confirm(`주문수집(1시간마다) 직후, 마진이 나오는 지마켓 주문을 ${account} 계정으로 실제 결제까지 자동 진행합니다.\n품절·적자 주문은 건드리지 않고 디스코드로 알립니다. 켤까요?`)) return;
    }
    void save({ ...value, enabled: next, accounts: { ...value.accounts, gmarket: gmarketId.trim() } },
      next ? "자동구매가 켜졌습니다. 다음 주문수집부터 적용됩니다." : "자동구매를 껐습니다.");
  };

  const saveAccount = () => {
    void save({ ...value, accounts: { ...value.accounts, gmarket: gmarketId.trim() } }, "구매계정을 저장했습니다.");
  };

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-[var(--text-muted)]" /> 자동구매 (발주 후 무인 구매)
          </h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            주문수집 직후 새 발주건의 <b>원가를 갱신</b>하고, 품절·적자(원가×수량&gt;정산예정)가 아닌 지마켓 주문만
            아래 계정으로 <b>실제 결제까지</b> 자동 진행합니다. 결제 비밀번호는 자동화 PC의 환경설정(GMARKET_PAYMENT_PIN)에서 읽습니다.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <label className="text-sm text-[var(--text-secondary)] shrink-0">지마켓 구매계정</label>
            <input
              value={gmarketId}
              onChange={(e) => setGmarketId(e.target.value)}
              placeholder="예: joker3733"
              className="w-44 px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)]"
            />
            <button onClick={saveAccount} disabled={loading || saving}
              className="px-3 py-1.5 text-sm rounded-lg bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50">
              계정 저장
            </button>
          </div>
          {msg && <p className="text-xs text-[var(--text-secondary)] mt-2">{msg}</p>}
        </div>
        <button onClick={toggle} disabled={loading || saving}
          className={`shrink-0 px-4 py-2 text-sm rounded-lg disabled:opacity-50 ${value.enabled ? "bg-green-600 text-white" : "bg-[var(--bg-hover)] text-[var(--text-secondary)]"}`}>
          {loading || saving ? <Loader2 className="w-4 h-4 animate-spin" /> : value.enabled ? "켜짐" : "꺼짐"}
        </button>
      </div>
    </section>
  );
}
