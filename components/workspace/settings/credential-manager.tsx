"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Eye, EyeOff, Save, KeyRound, AlertCircle, CheckCircle, Loader2, Pencil } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { PurchaseCredential, PurchasePlatform } from "@/types/database";
import { PLATFORM_LABELS } from "@/types/database";

const PLATFORMS: PurchasePlatform[] = ["gmarket", "auction", "ohouse", "coupang", "smartstore", "11st"];

const PLATFORM_COLORS: Record<PurchasePlatform, string> = {
  gmarket: "bg-green-500/10 text-green-400 border-green-500/20",
  auction: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  ohouse: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  coupang: "bg-red-500/10 text-red-400 border-red-500/20",
  smartstore: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  "11st": "bg-pink-500/10 text-pink-400 border-pink-500/20",
};

export default function CredentialManager() {
  const { session } = useAuth();
  const [credentials, setCredentials] = useState<PurchaseCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // 폼 상태
  const [formPlatform, setFormPlatform] = useState<PurchasePlatform>("gmarket");
  const [formLoginId, setFormLoginId] = useState("");
  const [formLoginPw, setFormLoginPw] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchCredentials = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/credentials", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        setCredentials(await res.json());
      }
    } catch {
      setError("계정 목록 불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const resetForm = () => {
    setFormPlatform("gmarket");
    setFormLoginId("");
    setFormLoginPw("");
    setFormLabel("");
    setShowPw(false);
    setEditingId(null);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!formLoginId || !formLoginPw) {
      setError("아이디와 비밀번호를 입력해주세요.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const isEdit = !!editingId;
      const url = isEdit ? `/api/credentials/${editingId}` : "/api/credentials";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          platform: formPlatform,
          login_id: formLoginId,
          login_pw: formLoginPw,
          label: formLabel,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "저장 실패");
        setSaving(false);
        return;
      }

      setSuccess(isEdit ? "계정 정보가 수정되었습니다." : "계정이 등록되었습니다.");
      setTimeout(() => setSuccess(""), 3000);
      resetForm();
      fetchCredentials();
    } catch {
      setError("저장 중 오류 발생");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (cred: PurchaseCredential) => {
    setEditingId(cred.id);
    setFormPlatform(cred.platform);
    setFormLoginId(cred.login_id);
    setFormLoginPw("");
    setFormLabel(cred.label || "");
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("이 계정을 삭제하시겠습니까?")) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/credentials/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });

      if (res.ok) {
        setSuccess("계정이 삭제되었습니다.");
        setTimeout(() => setSuccess(""), 3000);
        fetchCredentials();
      } else {
        setError("삭제 실패");
      }
    } catch {
      setError("삭제 중 오류 발생");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="bg-[#1a1a2e] border border-white/10 rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-blue-400" />
          <h2 className="text-base font-semibold text-white">구매처 계정 관리</h2>
          <span className="text-xs text-white/30 ml-1">배송 조회 자동 수집에 사용됩니다</span>
        </div>
        {!showForm && (
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            계정 추가
          </button>
        )}
      </div>

      <div className="p-6 space-y-4">
        {/* 알림 */}
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-xs bg-red-500/10 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
            <button onClick={() => setError("")} className="ml-auto text-red-400/60 hover:text-red-400">x</button>
          </div>
        )}
        {success && (
          <div className="flex items-center gap-2 text-green-400 text-xs bg-green-500/10 rounded-lg px-3 py-2">
            <CheckCircle className="w-4 h-4 shrink-0" />
            {success}
          </div>
        )}

        {/* 등록 폼 */}
        {showForm && (
          <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-medium text-white">
              {editingId ? "계정 수정" : "새 계정 등록"}
            </h3>

            {/* 플랫폼 선택 */}
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">구매처</label>
              <div className="flex flex-wrap gap-2">
                {PLATFORMS.map((p) => (
                  <button
                    key={p}
                    onClick={() => !editingId && setFormPlatform(p)}
                    disabled={!!editingId}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      formPlatform === p
                        ? PLATFORM_COLORS[p]
                        : "bg-white/5 text-white/30 border-white/10 hover:text-white/50"
                    } ${editingId ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {PLATFORM_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>

            {/* 별칭 */}
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">별칭 (선택)</label>
              <input
                type="text"
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder={`예: ${PLATFORM_LABELS[formPlatform]} 메인계정`}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 outline-none focus:border-blue-500/50"
              />
            </div>

            {/* 아이디 */}
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">아이디</label>
              <input
                type="text"
                value={formLoginId}
                onChange={(e) => setFormLoginId(e.target.value)}
                placeholder="구매처 로그인 아이디"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 outline-none focus:border-blue-500/50"
              />
            </div>

            {/* 비밀번호 */}
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">
                비밀번호 {editingId && <span className="text-white/20">(변경 시에만 입력)</span>}
              </label>
              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  value={formLoginPw}
                  onChange={(e) => setFormLoginPw(e.target.value)}
                  placeholder={editingId ? "새 비밀번호 입력" : "비밀번호 입력"}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 pr-10 text-sm text-white placeholder:text-white/20 outline-none focus:border-blue-500/50"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-white/20 mt-1">비밀번호는 AES-256으로 암호화되어 안전하게 저장됩니다.</p>
            </div>

            {/* 버튼 */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={resetForm}
                className="px-4 py-2 rounded-lg text-sm text-white/50 bg-white/5 hover:bg-white/10 transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !formLoginId || (!editingId && !formLoginPw)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-30 transition-colors"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {editingId ? "수정" : "등록"}
              </button>
            </div>
          </div>
        )}

        {/* 계정 목록 */}
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-white/30 animate-spin" />
          </div>
        ) : credentials.length === 0 && !showForm ? (
          <div className="text-center py-10">
            <KeyRound className="w-10 h-10 text-white/10 mx-auto mb-3" />
            <p className="text-sm text-white/30">등록된 구매처 계정이 없습니다.</p>
            <p className="text-xs text-white/20 mt-1">계정을 등록하면 배송 조회 시 자동으로 로그인합니다.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {credentials.map((cred) => (
              <div
                key={cred.id}
                className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 group hover:border-white/20 transition-colors"
              >
                {/* 플랫폼 뱃지 */}
                <span className={`px-2.5 py-1 rounded-md text-xs font-medium border ${PLATFORM_COLORS[cred.platform]}`}>
                  {PLATFORM_LABELS[cred.platform]}
                </span>

                {/* 정보 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white font-medium">{cred.login_id}</span>
                    {cred.label && (
                      <span className="text-xs text-white/30">({cred.label})</span>
                    )}
                  </div>
                  <p className="text-xs text-white/20">
                    등록: {new Date(cred.created_at).toLocaleDateString("ko-KR")}
                  </p>
                </div>

                {/* 액션 */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleEdit(cred)}
                    className="p-1.5 rounded-lg text-white/30 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
                    title="수정"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(cred.id)}
                    disabled={deletingId === cred.id}
                    className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="삭제"
                  >
                    {deletingId === cred.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
