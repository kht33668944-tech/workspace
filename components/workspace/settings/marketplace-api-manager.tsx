"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, KeyRound, Loader2, Pencil, PlugZap, RefreshCw, Save, Trash2, XCircle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { MarketplaceApiCredential } from "@/types/database";

type ApiCredential = MarketplaceApiCredential;
type Platform = "coupang" | "smartstore";

const PLATFORM_LABEL: Record<Platform, string> = { coupang: "쿠팡", smartstore: "스마트스토어" };
const PLATFORM_BADGE: Record<Platform, string> = {
  coupang: "bg-red-500/10 text-red-400",
  smartstore: "bg-green-500/10 text-green-400",
};

/** 쿠팡 키 만료 D-day (meta.expires_at 기준) */
function daysLeft(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

export default function MarketplaceApiManager() {
  const { session } = useAuth();
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>("coupang");
  const [label, setLabel] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const authHeaders = useCallback(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` }),
    [session?.access_token],
  );

  const fetchCredentials = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/marketplace-api/credentials", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("목록 조회 실패");
      const data = (await res.json()) as ApiCredential[];
      setCredentials(data.filter((c) => c.platform === "coupang" || c.platform === "smartstore"));
    } catch {
      setMessage({ type: "error", text: "API 계정 목록을 불러오지 못했습니다." });
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const resetForm = () => {
    setEditingId(null);
    setPlatform("coupang");
    setLabel("");
    setAccountId("");
    setAccessKey("");
    setSecretKey("");
    setClientId("");
    setClientSecret("");
    setExpiresAt("");
    setShowForm(false);
  };

  const handleEdit = (credential: ApiCredential) => {
    setEditingId(credential.id);
    setPlatform(credential.platform === "smartstore" ? "smartstore" : "coupang");
    setLabel(credential.label ?? "");
    setAccountId(credential.account_id === "-" ? "" : credential.account_id);
    setAccessKey("");
    setSecretKey("");
    setClientId("");
    setClientSecret("");
    const exp = credential.meta?.expires_at;
    setExpiresAt(typeof exp === "string" ? exp.slice(0, 10) : "");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (platform === "coupang") {
      if (!accountId.trim()) return setMessage({ type: "error", text: "Vendor ID(업체코드)를 입력하세요." });
      if (!editingId && (!accessKey.trim() || !secretKey.trim())) {
        return setMessage({ type: "error", text: "Access Key와 Secret Key를 입력하세요." });
      }
    } else if (!editingId && (!clientId.trim() || !clientSecret.trim())) {
      return setMessage({ type: "error", text: "애플리케이션 ID와 시크릿을 입력하세요." });
    }

    setSaving(true);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {
        platform,
        label: label || accountId || PLATFORM_LABEL[platform],
        account_id: accountId.trim() || undefined,
        access_key: accessKey || undefined,
        secret_key: secretKey || undefined,
        client_id: clientId || undefined,
        client_secret: clientSecret || undefined,
      };
      if (platform === "coupang" && expiresAt) payload.meta = { expires_at: `${expiresAt}T00:00:00+09:00` };

      const res = await fetch(editingId ? `/api/marketplace-api/credentials/${editingId}` : "/api/marketplace-api/credentials", {
        method: editingId ? "PUT" : "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) return setMessage({ type: "error", text: data.error ?? "저장 실패" });
      setMessage({ type: "success", text: `${PLATFORM_LABEL[platform]} API 계정을 ${editingId ? "수정" : "저장"}했습니다.` });
      resetForm();
      fetchCredentials();
    } catch {
      setMessage({ type: "error", text: "저장 중 오류가 발생했습니다." });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (credential: ApiCredential) => {
    setTestingId(credential.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/marketplace-api/${credential.platform}/test`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ credentialId: credential.id }),
      });
      const data = (await res.json()) as { success?: boolean; message?: string; error?: string };
      setMessage({ type: res.ok && data.success ? "success" : "error", text: data.message ?? data.error ?? "연결 확인 실패" });
      fetchCredentials();
    } catch {
      setMessage({ type: "error", text: "연결 확인 중 오류가 발생했습니다." });
    } finally {
      setTestingId(null);
    }
  };

  const handleSync = async (credential: ApiCredential) => {
    setSyncingId(credential.id);
    setMessage(null);
    try {
      const res = await fetch("/api/marketplace-api/smartstore/sync", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ credentialId: credential.id }),
      });
      const data = (await res.json()) as {
        remoteCount?: number; matchedByNo?: number; matchedByName?: number; created?: number; unmatchedCount?: number; error?: string;
      };
      if (!res.ok) return setMessage({ type: "error", text: data.error ?? "동기화 실패" });
      setMessage({
        type: "success",
        text: `스마트스토어 상품 ${data.remoteCount}개 조회 — 번호매칭 ${data.matchedByNo}, 이름매칭 ${data.matchedByName}, 신규 ${data.created}, 미매칭 ${data.unmatchedCount}`,
      });
    } catch {
      setMessage({ type: "error", text: "동기화 중 오류가 발생했습니다." });
    } finally {
      setSyncingId(null);
    }
  };

  const handleDelete = async (credential: ApiCredential) => {
    if (!confirm(`이 ${PLATFORM_LABEL[credential.platform as Platform] ?? ""} API 계정을 삭제하시겠습니까?`)) return;
    setDeletingId(credential.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/marketplace-api/credentials/${credential.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (!res.ok) throw new Error("삭제 실패");
      setMessage({ type: "success", text: "API 계정을 삭제했습니다." });
      fetchCredentials();
    } catch {
      setMessage({ type: "error", text: "삭제 중 오류가 발생했습니다." });
    } finally {
      setDeletingId(null);
    }
  };

  const inputCls = "w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none focus:border-red-500/50";

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <PlugZap className="w-4 h-4 text-red-400" />
            공식 API 연동
          </h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">쿠팡윙·스마트스토어 API 키를 저장하고 가격·재고·주문취소를 직접 반영합니다.</p>
        </div>
        <button
          onClick={() => (showForm ? resetForm() : setShowForm(true))}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors"
        >
          <KeyRound className="w-4 h-4" />
          API 계정 추가
        </button>
      </div>

      {message && (
        <div className={`mb-4 flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${message.type === "success" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
          {message.type === "success" ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          {message.text}
        </div>
      )}

      {showForm && (
        <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-3 p-4 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg">
          <div>
            <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">판매처</label>
            <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)} disabled={!!editingId} className={inputCls}>
              <option value="coupang">쿠팡 (OpenAPI)</option>
              <option value="smartstore">스마트스토어 (커머스API)</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">별칭</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={platform === "coupang" ? "예: 쿠팡 메인 계정" : "예: 25시메가마트"} className={inputCls} />
          </div>

          {platform === "coupang" ? (
            <>
              <div>
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">Vendor ID (업체코드)</label>
                <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="A00000000" className={inputCls} />
              </div>
              <div>
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">키 만료일 (선택)</label>
                <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">Access Key</label>
                <input value={accessKey} onChange={(e) => setAccessKey(e.target.value)} placeholder={editingId ? "변경 시에만 입력" : "Access Key"} className={inputCls} />
              </div>
              <div>
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">Secret Key</label>
                <input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={editingId ? "변경 시에만 입력" : "Secret Key"} className={inputCls} />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">애플리케이션 ID</label>
                <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={editingId ? "변경 시에만 입력" : "커머스API센터 > 내 스토어 애플리케이션"} className={inputCls} />
              </div>
              <div>
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">애플리케이션 시크릿</label>
                <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={editingId ? "변경 시에만 입력" : "$2a$04$..."} className={inputCls} />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">채널번호 (선택 — 연결 확인 시 자동 입력)</label>
                <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="비워두면 연결 확인 시 자동" className={inputCls} />
              </div>
            </>
          )}

          <div className="md:col-span-2 flex justify-end gap-2">
            <button onClick={resetForm} className="px-4 py-2 text-sm border border-[var(--border)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-hover)]">취소</button>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              저장
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" />
          불러오는 중...
        </div>
      ) : credentials.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)] bg-[var(--bg-hover)] rounded-lg p-4">등록된 API 계정이 없습니다.</div>
      ) : (
        <div className="space-y-2">
          {credentials.map((credential) => {
            const p = (credential.platform === "smartstore" ? "smartstore" : "coupang") as Platform;
            const left = p === "coupang" ? daysLeft(credential.meta?.expires_at) : null;
            const channelName = typeof credential.meta?.channelName === "string" ? credential.meta.channelName : null;
            return (
              <div key={credential.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-[var(--text-primary)]">{credential.label || credential.account_id}</span>
                    <span className={`px-2 py-0.5 text-xs rounded ${PLATFORM_BADGE[p]}`}>{PLATFORM_LABEL[p]}</span>
                    {credential.last_test_status === "success" && <CheckCircle className="w-4 h-4 text-green-400" />}
                    {credential.last_test_status === "failed" && <XCircle className="w-4 h-4 text-red-400" />}
                    {left != null && left <= 14 && (
                      <span className={`px-2 py-0.5 text-xs rounded ${left <= 0 ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"}`}>
                        {left <= 0 ? "키 만료됨 — 재발급 필요" : `키 만료 D-${left} — 재발급 후 플레이오토도 갱신`}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    {p === "coupang" ? `Vendor ID: ${credential.account_id}` : `채널: ${channelName ?? "-"} (${credential.account_id})`}
                  </p>
                  {credential.last_test_message && <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{credential.last_test_message}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => handleTest(credential)} disabled={testingId === credential.id} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-green-600/20 text-green-400 hover:bg-green-600/30 rounded-lg disabled:opacity-50">
                    {testingId === credential.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                    연결 확인
                  </button>
                  {p === "smartstore" && (
                    <button onClick={() => handleSync(credential)} disabled={syncingId === credential.id} title="네이버 상품 목록을 읽어 원상품번호·가격·재고를 캐시에 채웁니다" className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg disabled:opacity-50">
                      {syncingId === credential.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      상품 동기화
                    </button>
                  )}
                  <button onClick={() => handleEdit(credential)} className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] rounded-lg">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(credential)} disabled={deletingId === credential.id} className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg disabled:opacity-50">
                    {deletingId === credential.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
