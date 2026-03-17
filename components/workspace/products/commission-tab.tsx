"use client";

import React, { useState, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useCommissions, PLATFORM_FEE_FIELDS } from "@/hooks/use-commissions";
import type { CommissionPlatform, CommissionRate } from "@/types/database";
import { COMMISSION_PLATFORM_LABELS } from "@/types/database";

const PLATFORMS: CommissionPlatform[] = ["smartstore", "esm", "coupang", "esm_5pct"];

const PLATFORM_COLORS: Record<CommissionPlatform, { bg10: string; bg5: string; bg15: string; text: string }> = {
  smartstore: { bg10: "bg-green-500/10", bg5: "bg-green-500/5", bg15: "bg-green-500/15", text: "text-green-400" },
  esm: { bg10: "bg-yellow-500/10", bg5: "bg-yellow-500/5", bg15: "bg-yellow-500/15", text: "text-yellow-400" },
  coupang: { bg10: "bg-red-500/10", bg5: "bg-red-500/5", bg15: "bg-red-500/15", text: "text-red-400" },
  esm_5pct: { bg10: "bg-blue-500/10", bg5: "bg-blue-500/5", bg15: "bg-blue-500/15", text: "text-blue-400" },
};

export default function CommissionTab() {
  const { rates, categories, loading, updateRate, addCategory, deleteCategory } = useCommissions();
  const [editingCell, setEditingCell] = useState<{ id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

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
