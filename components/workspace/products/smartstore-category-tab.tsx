"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, Upload, Save, Search, X } from "lucide-react";
import * as XLSX from "xlsx";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import type { SmartStoreCategoryCode } from "@/types/database";

interface Row {
  id: string | null; // null = 신규 (미저장)
  category_code: string;
  category_type: string;
  category_name: string;
  dirty: boolean; // 수정됨 여부
}

let tempId = 0;
function newTempId() {
  return `__new__${++tempId}`;
}

export default function SmartStoreCategoryTab() {
  const { session } = useAuth();
  const { showToast: addToast } = useToast();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const userId = session?.user?.id;
  const authHeader = { "x-user-id": userId ?? "" };

  // 초기 로드
  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    fetch("/api/products/smartstore-categories", { headers: authHeader })
      .then((r) => r.json())
      .then((json: { codes?: SmartStoreCategoryCode[] }) => {
        setRows(
          (json.codes ?? []).map((c) => ({
            id: c.id,
            category_code: c.category_code,
            category_type: c.category_type,
            category_name: c.category_name,
            dirty: false,
          }))
        );
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // 필터링
  const filtered = search
    ? rows.filter(
        (r) =>
          r.category_code.includes(search) ||
          r.category_type.includes(search) ||
          r.category_name.includes(search)
      )
    : rows;

  const dirtyCount = rows.filter((r) => r.dirty || r.id === null).length;

  function handleAddRow() {
    setRows((prev) => [
      ...prev,
      { id: newTempId(), category_code: "", category_type: "", category_name: "", dirty: true },
    ]);
  }

  function handleChange(rowId: string, field: keyof Row, value: string) {
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, [field]: value, dirty: true } : r))
    );
  }

  function handleToggleSelect(rowId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function handleSelectAll() {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((r) => r.id ?? "")));
    }
  }

  async function handleDeleteSelected() {
    if (selectedIds.size === 0) return;

    // 신규(미저장) 행은 로컬에서만 제거
    const newIds = [...selectedIds].filter((id) => id.startsWith("__new__"));
    const savedIds = [...selectedIds].filter((id) => !id.startsWith("__new__"));

    if (savedIds.length > 0) {
      const res = await fetch("/api/products/smartstore-categories/delete", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: savedIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        console.error("DELETE failed:", res.status, err);
        addToast(err.error ?? "삭제 실패", "error");
        return;
      }
    }

    setRows((prev) => prev.filter((r) => !selectedIds.has(r.id ?? "")));
    setSelectedIds(new Set());
    if (newIds.length + savedIds.length > 0) {
      addToast(`${newIds.length + savedIds.length}개 삭제됨`, "success");
    }
  }

  async function handleSave() {
    const toSave = rows.filter((r) => r.dirty || r.id === null || r.id.startsWith("__new__"));
    if (toSave.length === 0) return;

    // 빈 코드 행 검증
    const invalid = toSave.filter((r) => !r.category_code.trim());
    if (invalid.length > 0) {
      addToast("카테고리코드가 비어있는 행이 있습니다.", "error");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/products/smartstore-categories", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          codes: toSave.map((r) => ({
            category_code: r.category_code,
            category_type: r.category_type,
            category_name: r.category_name,
          })),
        }),
      });

      if (!res.ok) {
        const json = await res.json() as { error?: string };
        addToast(json.error ?? "저장 실패", "error");
        return;
      }

      // 저장 후 전체 재로드
      const listRes = await fetch("/api/products/smartstore-categories", { headers: authHeader });
      const listJson = await listRes.json() as { codes?: SmartStoreCategoryCode[] };
      setRows(
        (listJson.codes ?? []).map((c) => ({
          id: c.id,
          category_code: c.category_code,
          category_type: c.category_type,
          category_name: c.category_name,
          dirty: false,
        }))
      );
      addToast(`${toSave.length}개 저장됨`, "success");
    } finally {
      setSaving(false);
    }
  }

  function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws, { defval: "" });

        const newRows: Row[] = json
          .map((row) => {
            // 헤더 유연하게 처리 (한글 or 영문 컬럼명)
            const code = String(
              row["표준카테고리코드"] ?? row["카테고리코드"] ?? row["category_code"] ?? row["A"] ?? ""
            ).trim();
            const type = String(
              row["분류명"] ?? row["분류"] ?? row["category_type"] ?? row["B"] ?? ""
            ).trim();
            const name = String(
              row["카테고리명"] ?? row["category_name"] ?? row["C"] ?? ""
            ).trim();
            return { id: newTempId(), category_code: code, category_type: type, category_name: name, dirty: true };
          })
          .filter((r) => r.category_code !== "");

        if (newRows.length === 0) {
          addToast("유효한 데이터가 없습니다.", "error");
          return;
        }

        // 기존 코드와 중복되는 항목은 건너뛰고 새 항목만 추가
        const existingCodes = new Set(rows.map((r) => r.category_code));
        const unique = newRows.filter((r) => !existingCodes.has(r.category_code));
        const skipped = newRows.length - unique.length;

        if (unique.length === 0) {
          addToast(`모든 항목(${newRows.length}개)이 이미 등록되어 있습니다.`, "info");
        } else {
          setRows((prev) => [...prev, ...unique]);
          if (skipped > 0) {
            addToast(`${unique.length}개 추가, ${skipped}개 중복 건너뜀. 저장 버튼을 눌러 저장하세요.`, "info");
          } else {
            addToast(`${unique.length}개 항목을 불러왔습니다. 저장 버튼을 눌러 저장하세요.`, "info");
          }
        }
      } catch {
        addToast("엑셀 파일 읽기 실패", "error");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  if (loading) {
    return <div className="text-sm text-[var(--text-muted)] py-8 text-center">불러오는 중...</div>;
  }

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">플레이오토 카테고리코드</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            플레이오토 대량등록 시 카테고리코드(B열)에 사용되는 카테고리 목록입니다. (옥션/지마켓/11번가/멸치쇼핑/쿠팡 등 전 플랫폼 공통)
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {dirtyCount > 0 && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saving ? "저장 중..." : `저장 (${dirtyCount})`}
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 rounded-lg transition-colors"
          >
            <Upload className="w-4 h-4" />
            엑셀 업로드
          </button>
          <button
            onClick={handleAddRow}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-[var(--bg-card)] border border-[var(--border)] hover:border-blue-400 text-[var(--text-primary)] rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            행 추가
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleExcelUpload}
          />
        </div>
      </div>

      {/* 검색 + 삭제 툴바 */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="코드, 분류, 카테고리명 검색..."
            className="w-full pl-9 pr-8 py-2 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-400"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {selectedIds.size > 0 && (
          <button
            onClick={handleDeleteSelected}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {selectedIds.size}개 삭제
          </button>
        )}

        <span className="text-xs text-[var(--text-muted)] ml-auto">
          총 <strong className="text-[var(--text-primary)]">{rows.length}</strong>개
          {search && ` (검색결과 ${filtered.length}개)`}
        </span>
      </div>

      {/* 테이블 */}
      <div className="border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--bg-card)] border-b border-[var(--border)]">
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && selectedIds.size === filtered.length}
                    onChange={handleSelectAll}
                    className="rounded"
                  />
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-[var(--text-muted)] w-40">
                  카테고리코드
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-[var(--text-muted)] w-36">
                  분류
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">
                  카테고리명
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-sm text-[var(--text-muted)]">
                    {search ? "검색 결과가 없습니다." : "카테고리코드가 없습니다. 행 추가 또는 엑셀 업로드로 등록하세요."}
                  </td>
                </tr>
              ) : (
                filtered.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-[var(--border)] last:border-0 transition-colors ${
                      row.dirty ? "bg-blue-500/5" : "hover:bg-[var(--bg-card)]"
                    } ${selectedIds.has(row.id ?? "") ? "bg-blue-500/10" : ""}`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id ?? "")}
                        onChange={() => handleToggleSelect(row.id ?? "")}
                        className="rounded"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={row.category_code}
                        onChange={(e) => handleChange(row.id!, "category_code", e.target.value)}
                        placeholder="예: 6219426"
                        className="w-full px-2 py-1 text-sm bg-transparent border border-transparent hover:border-[var(--border)] focus:border-blue-400 rounded outline-none text-[var(--text-primary)]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={row.category_type}
                        onChange={(e) => handleChange(row.id!, "category_type", e.target.value)}
                        placeholder="예: 가공식품"
                        className="w-full px-2 py-1 text-sm bg-transparent border border-transparent hover:border-[var(--border)] focus:border-blue-400 rounded outline-none text-[var(--text-primary)]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={row.category_name}
                        onChange={(e) => handleChange(row.id!, "category_name", e.target.value)}
                        placeholder="예: 생수"
                        className="w-full px-2 py-1 text-sm bg-transparent border border-transparent hover:border-[var(--border)] focus:border-blue-400 rounded outline-none text-[var(--text-primary)]"
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 엑셀 양식 안내 */}
      <div className="text-xs text-[var(--text-muted)] bg-[var(--bg-card)] rounded-lg px-4 py-3 border border-[var(--border)]">
        <strong className="text-[var(--text-primary)]">엑셀 업로드 양식:</strong>{" "}
        A열 = 표준카테고리코드, B열 = 분류명, C열 = 카테고리명 &nbsp;|&nbsp;
        첫 번째 행은 헤더(카테고리코드 / 분류 / 카테고리명)이거나 데이터 행이어도 무방합니다.
        이미 등록된 코드는 자동으로 건너뜁니다.
      </div>
    </div>
  );
}
