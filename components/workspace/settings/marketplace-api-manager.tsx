"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, KeyRound, Loader2, Pencil, PlugZap, Save, Trash2, XCircle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { MarketplaceApiCredential } from "@/types/database";

type ApiCredential = MarketplaceApiCredential;

export default function MarketplaceApiManager() {
  const { session } = useAuth();
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const fetchCredentials = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/marketplace-api/credentials", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("목록 조회 실패");
      const data = (await res.json()) as ApiCredential[];
      setCredentials(data.filter((c) => c.platform === "coupang"));
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
    setLabel("");
    setVendorId("");
    setAccessKey("");
    setSecretKey("");
    setShowForm(false);
  };

  const handleEdit = (credential: ApiCredential) => {
    setEditingId(credential.id);
    setLabel(credential.label ?? "");
    setVendorId(credential.account_id);
    setAccessKey("");
    setSecretKey("");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!vendorId.trim()) {
      setMessage({ type: "error", text: "Vendor ID를 입력하세요." });
      return;
    }
    if (!editingId && (!accessKey.trim() || !secretKey.trim())) {
      setMessage({ type: "error", text: "Access Key와 Secret Key를 입력하세요." });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(editingId ? `/api/marketplace-api/credentials/${editingId}` : "/api/marketplace-api/credentials", {
        method: editingId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          platform: "coupang",
          label: label || vendorId,
          account_id: vendorId,
          access_key: accessKey || undefined,
          secret_key: secretKey || undefined,
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setMessage({ type: "error", text: data.error ?? "저장 실패" });
        return;
      }
      setMessage({ type: "success", text: editingId ? "쿠팡 API 계정을 수정했습니다." : "쿠팡 API 계정을 저장했습니다." });
      resetForm();
      fetchCredentials();
    } catch {
      setMessage({ type: "error", text: "저장 중 오류가 발생했습니다." });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setMessage(null);
    try {
      const res = await fetch("/api/marketplace-api/coupang/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ credentialId: id }),
      });
      const data = await res.json() as { success?: boolean; message?: string; error?: string };
      setMessage({
        type: res.ok && data.success ? "success" : "error",
        text: data.message ?? data.error ?? "연결 확인 실패",
      });
      fetchCredentials();
    } catch {
      setMessage({ type: "error", text: "연결 확인 중 오류가 발생했습니다." });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("이 쿠팡 API 계정을 삭제하시겠습니까?")) return;
    setDeletingId(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/marketplace-api/credentials/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (!res.ok) throw new Error("삭제 실패");
      setMessage({ type: "success", text: "쿠팡 API 계정을 삭제했습니다." });
      fetchCredentials();
    } catch {
      setMessage({ type: "error", text: "삭제 중 오류가 발생했습니다." });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <PlugZap className="w-4 h-4 text-red-400" />
            공식 API 연동
          </h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">쿠팡윙 API 키를 저장하고 상품 가격·재고를 직접 반영합니다.</p>
        </div>
        <button
          onClick={() => showForm ? resetForm() : setShowForm(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors"
        >
          <KeyRound className="w-4 h-4" />
          쿠팡 API 추가
        </button>
      </div>

      {message && (
        <div className={`mb-4 flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
          message.type === "success" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
        }`}>
          {message.type === "success" ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {message.text}
        </div>
      )}

      {showForm && (
        <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-3 p-4 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg">
          <div>
            <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">별칭</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: 쿠팡 메인 계정" className="w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none focus:border-red-500/50" />
          </div>
          <div>
            <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">Vendor ID</label>
            <input value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="A00000000" className="w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none focus:border-red-500/50" />
          </div>
          <div>
            <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">Access Key</label>
            <input value={accessKey} onChange={(e) => setAccessKey(e.target.value)} placeholder={editingId ? "변경 시에만 입력" : "Access Key"} className="w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none focus:border-red-500/50" />
          </div>
          <div>
            <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">Secret Key</label>
            <input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={editingId ? "변경 시에만 입력" : "Secret Key"} className="w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none focus:border-red-500/50" />
          </div>
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
        <div className="text-sm text-[var(--text-muted)] bg-[var(--bg-hover)] rounded-lg p-4">등록된 쿠팡 API 계정이 없습니다.</div>
      ) : (
        <div className="space-y-2">
          {credentials.map((credential) => (
            <div key={credential.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{credential.label || credential.account_id}</span>
                  <span className="px-2 py-0.5 text-xs rounded bg-red-500/10 text-red-400">쿠팡</span>
                  {credential.last_test_status === "success" && <CheckCircle className="w-4 h-4 text-green-400" />}
                  {credential.last_test_status === "failed" && <XCircle className="w-4 h-4 text-red-400" />}
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">Vendor ID: {credential.account_id}</p>
                {credential.last_test_message && <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{credential.last_test_message}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => handleTest(credential.id)} disabled={testingId === credential.id} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-green-600/20 text-green-400 hover:bg-green-600/30 rounded-lg disabled:opacity-50">
                  {testingId === credential.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                  연결 확인
                </button>
                <button onClick={() => handleEdit(credential)} className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] rounded-lg">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => handleDelete(credential.id)} disabled={deletingId === credential.id} className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg disabled:opacity-50">
                  {deletingId === credential.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
