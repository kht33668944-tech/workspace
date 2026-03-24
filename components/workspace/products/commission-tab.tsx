"use client";

import React, { useState, useCallback, useEffect } from "react";
import { Plus, Trash2, Sparkles, Save } from "lucide-react";
import { useCommissions, PLATFORM_FEE_FIELDS } from "@/hooks/use-commissions";
import { useAuth } from "@/context/AuthContext";
import type { CommissionPlatform, CommissionRate } from "@/types/database";
import { COMMISSION_PLATFORM_LABELS } from "@/types/database";
import { PLAYAUTO_SCHEMAS } from "@/lib/playauto-schema";

const PLATFORMS: CommissionPlatform[] = ["smartstore", "esm", "coupang", "esm_5pct", "myeolchi"];

const PLATFORM_COLORS: Record<CommissionPlatform, { bg10: string; bg5: string; bg15: string; text: string }> = {
  smartstore: { bg10: "bg-green-500/10", bg5: "bg-green-500/5", bg15: "bg-green-500/15", text: "text-green-400" },
  esm: { bg10: "bg-yellow-500/10", bg5: "bg-yellow-500/5", bg15: "bg-yellow-500/15", text: "text-yellow-400" },
  coupang: { bg10: "bg-red-500/10", bg5: "bg-red-500/5", bg15: "bg-red-500/15", text: "text-red-400" },
  esm_5pct: { bg10: "bg-blue-500/10", bg5: "bg-blue-500/5", bg15: "bg-blue-500/15", text: "text-blue-400" },
  myeolchi: { bg10: "bg-orange-500/10", bg5: "bg-orange-500/5", bg15: "bg-orange-500/15", text: "text-orange-400" },
};

export default function CommissionTab() {
  const { session } = useAuth();
  const { rates, categories, loading, updateRate, addCategory, deleteCategory } = useCommissions();
  const [editingCell, setEditingCell] = useState<{ id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  // 플레이오토 분류 매핑 상태
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [mappingLoading, setMappingLoading] = useState(false);
  const [mappingSaving, setMappingSaving] = useState(false);

  const userId = session?.user?.id;
  const accessToken = session?.access_token;

  // 매핑 로드
  useEffect(() => {
    if (!userId || !accessToken) return;
    fetch("/api/products/playauto-mappings", {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((d: { mappings?: Array<{ user_category: string; playauto_code: string }> }) => {
        const map: Record<string, string> = {};
        (d.mappings ?? []).forEach((m) => { map[m.user_category] = m.playauto_code; });
        setMappings(map);
      })
      .catch(() => {});
  }, [userId]);

  const handleMappingChange = (cat: string, code: string) => {
    setMappings((prev) => ({ ...prev, [cat]: code }));
  };

  const handleAutoMap = async () => {
    if (categories.length === 0) return;
    setMappingLoading(true);
    try {
      const res = await fetch("/api/products/playauto-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ categories }),
      });
      const d = await res.json() as { suggestions?: Array<{ user_category: string; playauto_code: string }> };
      const map: Record<string, string> = { ...mappings };
      (d.suggestions ?? []).forEach((s) => { map[s.user_category] = s.playauto_code; });
      setMappings(map);
    } catch { /* ignore */ } finally {
      setMappingLoading(false);
    }
  };

  const handleSaveMappings = async () => {
    if (!userId) return;
    setMappingSaving(true);
    try {
      const rows = Object.entries(mappings).map(([user_category, playauto_code]) => ({
        user_category,
        playauto_code,
      }));
      await fetch("/api/products/playauto-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ mappings: rows }),
      });
    } catch { /* ignore */ } finally {
      setMappingSaving(false);
    }
  };

  // 카테고리+플랫폼으로 rate 찾기
  const getRate = useCallback(
    (category: string, platform: CommissionPlatform): CommissionRate | undefined => {
      return rates.find((r) => r.category === category && r.platform === platform);
    },
    [rates]
  );

  const handleCellClick = (rate: CommissionRate, field: string) => {
    const value = field === "total_rate" ? rate.total_rate : (rate.rate_details[field] ?? 0);
    setEditingCell({ id: rate.id, field });
    setEditValue(String(value));
  };

  const handleSave = () => {
    if (!editingCell) return;
    const rate = rates.find((r) => r.id === editingCell.id);
    if (!rate) return;

    const numVal = parseFloat(editValue) || 0;

    if (editingCell.field === "total_rate") {
      updateRate(rate.id, { total_rate: numVal });
    } else {
      const newDetails = { ...rate.rate_details, [editingCell.field]: numVal };
      // 개별 항목 수정 시 총수수료는 건드리지 않음
      // (coupon_burden은 쿠폰부담률%, vat는 승수이므로 단순 합산 불가)
      updateRate(rate.id, { rate_details: newDetails });
    }
    setEditingCell(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      setEditingCell(null);
    }
  };

  const handleAddCategory = () => {
    const name = newCategoryName.trim();
    if (name) {
      addCategory(name);
      setNewCategoryName("");
      setShowAddForm(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-[var(--text-muted)]">
        <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mr-3" />
        수수료 데이터 로딩 중...
      </div>
    );
  }

  // 플랫폼별 컬럼 수 계산
  const platformColumns = PLATFORMS.map((p) => ({
    platform: p,
    label: COMMISSION_PLATFORM_LABELS[p],
    fields: PLATFORM_FEE_FIELDS[p],
    colSpan: PLATFORM_FEE_FIELDS[p].length + 1, // +1 for 총수수료
  }));

  return (
    <div className="space-y-4">
      {/* 안내 텍스트 */}
      <div className="text-xs text-[var(--text-muted)] px-1">
        * 셀을 클릭하여 수수료율을 수정할 수 있습니다. 개별 항목 수정 시 총수수료가 자동 재계산됩니다.
      </div>

      {/* 수수료 매트릭스 테이블 */}
      <div className="border border-[var(--border)] rounded-lg overflow-auto">
        <table className="w-full text-xs border-collapse">
          {/* 플랫폼 그룹 헤더 */}
          <thead>
            <tr className="bg-[var(--table-header-bg)]">
              <th
                rowSpan={2}
                className="border border-[var(--border)] px-3 py-2 text-left font-medium text-[var(--text-primary)] sticky left-0 bg-[var(--table-header-bg)] z-10 min-w-[140px]"
              >
                카테고리
              </th>
              {platformColumns.map(({ platform, label, colSpan }) => (
                <th
                  key={platform}
                  colSpan={colSpan}
                  className={`border border-[var(--border)] px-2 py-2 text-center font-medium text-[var(--text-primary)] ${PLATFORM_COLORS[platform].bg10}`}
                >
                  {label}
                </th>
              ))}
            </tr>
            {/* 세부 항목 헤더 */}
            <tr className="bg-[var(--table-header-bg)]">
              {platformColumns.map(({ platform, fields }) => (
                <React.Fragment key={`hdr-${platform}`}>
                  {fields.map((f) => (
                    <th
                      key={`${platform}-${f.key}`}
                      className={`border border-[var(--border)] px-2 py-1.5 text-center font-normal text-[var(--text-secondary)] min-w-[60px] ${PLATFORM_COLORS[platform].bg5}`}
                    >
                      {f.label}
                    </th>
                  ))}
                  <th
                    key={`${platform}-total`}
                    className={`border border-[var(--border)] px-2 py-1.5 text-center font-semibold text-[var(--text-primary)] min-w-[70px] ${PLATFORM_COLORS[platform].bg15}`}
                  >
                    총수수료
                  </th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat} className="hover:bg-[var(--bg-hover)] transition-colors">
                <td className="border border-[var(--border)] px-3 py-2 font-medium text-[var(--text-primary)] sticky left-0 bg-[var(--bg-card)] z-10">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{cat}</span>
                    <button
                      onClick={() => {
                        if (confirm(`"${cat}" 카테고리를 삭제하시겠습니까?`)) deleteCategory(cat);
                      }}
                      className="opacity-0 group-hover:opacity-100 hover:text-red-400 text-[var(--text-muted)] flex-shrink-0 transition-opacity"
                      title="카테고리 삭제"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </td>
                {PLATFORMS.map((platform) => {
                  const rate = getRate(cat, platform);
                  if (!rate) return null;
                  const fields = PLATFORM_FEE_FIELDS[platform];
                  return (
                    <React.Fragment key={`${cat}-${platform}`}>
                      {fields.map((f) => {
                        const isEditing = editingCell?.id === rate.id && editingCell?.field === f.key;
                        const value = rate.rate_details[f.key] ?? 0;
                        return (
                          <td
                            key={`${rate.id}-${f.key}`}
                            className="border border-[var(--border)] px-1 py-1 text-center text-[var(--text-secondary)] cursor-pointer hover:bg-[var(--bg-hover)]"
                            onClick={() => !isEditing && handleCellClick(rate, f.key)}
                          >
                            {isEditing ? (
                              <input
                                type="number"
                                step="0.01"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={handleSave}
                                onKeyDown={handleKeyDown}
                                autoFocus
                                className="w-full bg-transparent text-center text-[var(--text-primary)] outline-none border-b border-blue-400 py-0.5"
                              />
                            ) : (
                              <span>{value}%</span>
                            )}
                          </td>
                        );
                      })}
                      {/* 총수수료 */}
                      <td
                        key={`${rate.id}-total`}
                        className={`border border-[var(--border)] px-1 py-1 text-center font-semibold cursor-pointer hover:bg-[var(--bg-hover)] ${PLATFORM_COLORS[platform].text}`}
                        onClick={() => handleCellClick(rate, "total_rate")}
                      >
                        {editingCell?.id === rate.id && editingCell?.field === "total_rate" ? (
                          <input
                            type="number"
                            step="0.01"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleSave}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            className="w-full bg-transparent text-center text-[var(--text-primary)] outline-none border-b border-blue-400 py-0.5"
                          />
                        ) : (
                          <span>{rate.total_rate}%</span>
                        )}
                      </td>
                    </React.Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 플레이오토 상품분류 매핑 */}
      <div className="border border-[var(--border)] rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-[var(--text-primary)]">플레이오토 상품분류 매핑</h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">내보내기 시 상품분류코드와 상품정보제공고시 항목 수가 자동 적용됩니다.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAutoMap}
              disabled={mappingLoading || categories.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-violet-600/20 text-violet-400 hover:bg-violet-600/30 rounded-lg transition-colors disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {mappingLoading ? "분석 중..." : "Gemini 자동매핑"}
            </button>
            <button
              onClick={handleSaveMappings}
              disabled={mappingSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg transition-colors disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {mappingSaving ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {categories.map((cat) => (
            <div key={cat} className="flex items-center gap-2 bg-[var(--bg-main)] rounded-lg px-3 py-2">
              <span className="text-sm text-[var(--text-primary)] flex-1 truncate">{cat}</span>
              <select
                value={mappings[cat] ?? "35"}
                onChange={(e) => handleMappingChange(cat, e.target.value)}
                className="text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-secondary)] outline-none focus:border-blue-400 shrink-0"
              >
                {PLAYAUTO_SCHEMAS.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} - {s.name} ({s.fields.length}개)
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* 카테고리 추가 */}
      <div className="flex items-center gap-2">
        {showAddForm ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddCategory();
                if (e.key === "Escape") setShowAddForm(false);
              }}
              placeholder="카테고리명 입력"
              autoFocus
              className="px-3 py-1.5 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-400"
            />
            <button
              onClick={handleAddCategory}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
            >
              추가
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              취소
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            카테고리 추가
          </button>
        )}
      </div>
    </div>
  );
}
