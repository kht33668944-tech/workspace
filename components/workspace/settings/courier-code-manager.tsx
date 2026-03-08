"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronUp, Save, Loader2, RotateCcw, Search, Truck } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { DEFAULT_COURIER_CODES, type CourierCode } from "@/lib/courier-codes";

export default function CourierCodeManager() {
  const { session } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [codes, setCodes] = useState<CourierCode[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [search, setSearch] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  const fetchCodes = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/courier-codes", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json() as CourierCode[];
        if (data.length > 0) {
          setCodes(data);
        } else {
          // 저장된 데이터가 없으면 기본값 로드
          loadDefaults();
        }
      }
    } catch {
      loadDefaults();
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, [session?.access_token]);

  const loadDefaults = () => {
    const defaultCodes = Object.entries(DEFAULT_COURIER_CODES).map(([name, code]) => ({
      courier_name: name,
      courier_code: code,
    }));
    setCodes(defaultCodes);
  };

  useEffect(() => {
    if (expanded && !initialized) {
      fetchCodes();
    }
  }, [expanded, initialized, fetchCodes]);

  const handleSave = async () => {
    if (!session?.access_token) return;
    setSaving(true);
    try {
      const res = await fetch("/api/courier-codes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          codes: codes.map((c) => ({
            courier_name: c.courier_name,
            courier_code: c.courier_code,
          })),
        }),
      });
      if (!res.ok) {
        alert("저장 실패");
      }
    } catch {
      alert("저장 중 오류 발생");
    } finally {
      setSaving(false);
    }
  };

  const handleCodeChange = (idx: number, value: string) => {
    const num = parseInt(value, 10);
    if (isNaN(num)) return;
    setCodes((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], courier_code: num };
      return next;
    });
  };

  const handleNameChange = (idx: number, value: string) => {
    setCodes((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], courier_name: value };
      return next;
    });
  };

  const filteredCodes = search
    ? codes.filter((c) =>
        c.courier_name.toLowerCase().includes(search.toLowerCase()) ||
        String(c.courier_code).includes(search)
      )
    : codes;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl">
      {/* Header - 항상 보임 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-[var(--bg-subtle)] transition-colors rounded-2xl"
      >
        <div className="flex items-center gap-2">
          <Truck className="w-5 h-5 text-purple-400" />
          <h2 className="text-base font-semibold text-[var(--text-primary)]">택배사 코드 관리</h2>
          <span className="text-xs text-[var(--text-muted)] ml-1">플레이오토 운송장 전송용</span>
        </div>
        {expanded ? (
          <ChevronUp className="w-5 h-5 text-[var(--text-muted)]" />
        ) : (
          <ChevronDown className="w-5 h-5 text-[var(--text-muted)]" />
        )}
      </button>

      {/* Content - 펼쳤을 때만 */}
      {expanded && (
        <div className="px-6 pb-6 space-y-3 border-t border-[var(--border)] pt-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-[var(--text-muted)] animate-spin" />
            </div>
          ) : (
            <>
              {/* 상단 액션 */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-xs">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="택배사명 또는 코드 검색..."
                    className="w-full pl-9 pr-3 py-1.5 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-purple-500/50"
                  />
                </div>
                <button
                  onClick={() => { loadDefaults(); }}
                  className="flex items-center gap-1 px-2.5 py-1.5 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-tertiary)] transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  기본값 복원
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1 px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  저장
                </button>
              </div>

              <p className="text-xs text-[var(--text-disabled)]">총 {codes.length}개 택배사 등록됨 {search && `(${filteredCodes.length}개 표시)`}</p>

              {/* 코드 테이블 */}
              <div className="max-h-80 overflow-y-auto rounded-lg border border-[var(--border)]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[var(--bg-card)] z-10">
                    <tr className="border-b border-[var(--border)]">
                      <th className="text-left text-[var(--text-muted)] font-medium px-3 py-2 w-12">#</th>
                      <th className="text-left text-[var(--text-muted)] font-medium px-3 py-2">택배사명</th>
                      <th className="text-left text-[var(--text-muted)] font-medium px-3 py-2 w-24">코드</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCodes.map((c, i) => {
                      const realIdx = codes.indexOf(c);
                      return (
                        <tr
                          key={`${c.courier_name}-${c.courier_code}`}
                          className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)] transition-colors"
                        >
                          <td className="px-3 py-1.5 text-[var(--text-disabled)]">{realIdx + 1}</td>
                          <td className="px-3 py-1.5">
                            {editingIdx === realIdx ? (
                              <input
                                value={c.courier_name}
                                onChange={(e) => handleNameChange(realIdx, e.target.value)}
                                onBlur={() => setEditingIdx(null)}
                                autoFocus
                                className="bg-[var(--bg-hover)] border border-purple-500/30 rounded px-2 py-0.5 text-[var(--text-primary)] text-xs outline-none w-full"
                              />
                            ) : (
                              <span
                                onClick={() => setEditingIdx(realIdx)}
                                className="text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]"
                              >
                                {c.courier_name}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              type="number"
                              value={c.courier_code}
                              onChange={(e) => handleCodeChange(realIdx, e.target.value)}
                              className="bg-[var(--bg-hover)] border border-[var(--border)] rounded px-2 py-0.5 text-[var(--text-secondary)] text-xs outline-none w-16 focus:border-purple-500/30"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
