"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Eye, EyeOff, Save, KeyRound, AlertCircle, CheckCircle, Loader2, Pencil, ChevronDown, ChevronRight } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { PurchaseCredential, PurchasePlatform } from "@/types/database";
import { PLATFORM_LABELS } from "@/types/database";
import { useIsMobile } from "@/hooks/use-mobile";
import MobileSheet from "@/components/ui/mobile-sheet";

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
  const isMobile = useIsMobile();
  const [credentials, setCredentials] = useState<PurchaseCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // 폼 상태
  const [formPlatform, setFormPlatform] = useState<PurchasePlatform>("gmarket");
  const [formLoginId, setFormLoginId] = useState("");
  const [formLoginPw, setFormLoginPw] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formGroup, setFormGroup] = useState("");
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
    setFormGroup("");
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
          label: formLabel || formLoginId,
          group_name: formGroup || null,
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
    setFormGroup(cred.group_name || "");
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

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // platform → group_name → credentials 로 그룹화
  type GroupedCredentials = {
    platform: PurchasePlatform;
    groupName: string | null;
    items: PurchaseCredential[];
  }[];

  const grouped: GroupedCredentials = [];
  for (const platform of PLATFORMS) {
    const platCreds = credentials.filter(c => c.platform === platform);
    if (platCreds.length === 0) continue;

    const groupNames = [...new Set(platCreds.map(c => c.group_name))].sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b);
    });

    for (const g of groupNames) {
      grouped.push({
        platform,
        groupName: g,
        items: platCreds.filter(c => c.group_name === g),
      });
    }
  }

  // 폼 내용 (MobileSheet / 인라인 양쪽에서 재사용)
  const formContent = (
    <div className="space-y-3">
      {/* 플랫폼 선택 */}
      <div>
        <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">구매처</label>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => !editingId && setFormPlatform(p)}
              disabled={!!editingId}
              className={`px-3 min-h-[44px] rounded-lg text-xs font-medium border transition-colors ${
                formPlatform === p
                  ? PLATFORM_COLORS[p]
                  : "bg-[var(--bg-hover)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-tertiary)]"
              } ${editingId ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {PLATFORM_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* 아이디 */}
      <div>
        <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">아이디</label>
        <input
          type="text"
          value={formLoginId}
          onChange={(e) => {
            setFormLoginId(e.target.value);
            if (!formLabel) setFormLabel(e.target.value);
          }}
          placeholder="구매처 로그인 아이디"
          className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-blue-500/50"
        />
      </div>

      {/* 비밀번호 */}
      <div>
        <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">
          비밀번호 {editingId && <span className="text-[var(--text-disabled)]">(변경 시에만 입력)</span>}
        </label>
        <div className="relative">
          <input
            type={showPw ? "text" : "password"}
            value={formLoginPw}
            onChange={(e) => setFormLoginPw(e.target.value)}
            placeholder={editingId ? "새 비밀번호 입력" : "비밀번호 입력"}
            className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] pr-12 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-blue-500/50"
          />
          <button
            type="button"
            onClick={() => setShowPw(!showPw)}
            className="absolute right-0 top-0 h-full px-3 min-w-[44px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-tertiary)]"
          >
            {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-xs text-[var(--text-disabled)] mt-1">비밀번호는 AES-256으로 암호화되어 안전하게 저장됩니다.</p>
      </div>

      {/* 그룹 + 별칭 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">그룹 (선택)</label>
          <input
            type="text"
            value={formGroup}
            onChange={(e) => setFormGroup(e.target.value)}
            placeholder="예: skssoul07"
            className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-blue-500/50"
          />
        </div>
        <div>
          <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">별칭 (선택)</label>
          <input
            type="text"
            value={formLabel}
            onChange={(e) => setFormLabel(e.target.value)}
            placeholder={`예: ${PLATFORM_LABELS[formPlatform]} 메인계정`}
            className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-blue-500/50"
          />
        </div>
      </div>

      {/* 버튼 */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={resetForm}
          className="px-4 min-h-[44px] rounded-lg text-sm text-[var(--text-tertiary)] bg-[var(--bg-hover)] hover:bg-[var(--bg-active)] transition-colors"
        >
          취소
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !formLoginId || (!editingId && !formLoginPw)}
          className="flex items-center gap-1.5 px-4 min-h-[44px] rounded-lg text-sm font-medium bg-blue-600 text-[var(--text-primary)] hover:bg-blue-700 disabled:opacity-30 transition-colors"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {editingId ? "수정" : "등록"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <KeyRound className="w-5 h-5 text-blue-400 shrink-0" />
          <h2 className="text-base font-semibold text-[var(--text-primary)]">구매처 계정 관리</h2>
          <span className="text-xs text-[var(--text-muted)] ml-1 hidden sm:inline">배송 조회 자동 수집에 사용됩니다</span>
        </div>
        {!showForm && (
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-1.5 px-3 min-h-[44px] rounded-lg text-sm font-medium bg-blue-600 text-[var(--text-primary)] hover:bg-blue-700 transition-colors shrink-0"
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

        {/* 등록 폼 - 모바일: MobileSheet, 데스크톱: 인라인 */}
        {showForm && isMobile ? (
          <MobileSheet
            open={showForm}
            onClose={resetForm}
            title={editingId ? "계정 수정" : "새 계정 등록"}
          >
            <div className="p-4">
              {formContent}
            </div>
          </MobileSheet>
        ) : showForm ? (
          <div className="bg-[var(--bg-hover)] border border-[var(--border)] rounded-xl p-4">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">
              {editingId ? "계정 수정" : "새 계정 등록"}
            </h3>
            {formContent}
          </div>
        ) : null}

        {/* 계정 목록 */}
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
          </div>
        ) : credentials.length === 0 && !showForm ? (
          <div className="text-center py-10">
            <KeyRound className="w-10 h-10 text-[var(--text-disabled)] mx-auto mb-3" />
            <p className="text-sm text-[var(--text-muted)]">등록된 구매처 계정이 없습니다.</p>
            <p className="text-xs text-[var(--text-disabled)] mt-1">계정을 등록하면 배송 조회 시 자동으로 로그인합니다.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {grouped.map(({ platform, groupName, items }) => {
              const groupKey = `${platform}-${groupName ?? "__none__"}`;
              const isCollapsed = collapsedGroups.has(groupKey);

              return (
                <div key={groupKey} className="border border-[var(--border)] rounded-xl overflow-hidden">
                  {/* 그룹 헤더 */}
                  <button
                    onClick={() => toggleGroup(groupKey)}
                    className="w-full flex items-center gap-2 px-4 min-h-[44px] bg-[var(--bg-hover)] hover:bg-[var(--bg-active)] transition-colors"
                  >
                    {isCollapsed
                      ? <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      : <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                    }
                    <span className={`px-2 py-0.5 rounded text-xs font-medium border ${PLATFORM_COLORS[platform]}`}>
                      {PLATFORM_LABELS[platform]}
                    </span>
                    {groupName && (
                      <span className="text-xs font-medium text-[var(--text-secondary)]">{groupName}</span>
                    )}
                    <span className="text-xs text-[var(--text-disabled)] ml-auto">{items.length}개</span>
                  </button>

                  {/* 계정 목록 */}
                  {!isCollapsed && (
                    <div className="divide-y divide-[var(--border)]">
                      {items.map((cred) => (
                        <div
                          key={cred.id}
                          className="flex items-center gap-3 px-4 py-2.5 group hover:bg-[var(--bg-hover)] transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-[var(--text-primary)]">{cred.login_id}</span>
                          </div>

                          {/* 액션 - 모바일: 항상 표시, 데스크톱: hover 시 표시 */}
                          <div className={`flex items-center gap-1 transition-opacity ${isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                            <button
                              onClick={() => handleEdit(cred)}
                              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
                              title="수정"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(cred.id)}
                              disabled={deletingId === cred.id}
                              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                              title="삭제"
                            >
                              {deletingId === cred.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
