"use client";

import { useState, useEffect, useCallback } from "react";
import { Archive, Download, Trash2, Loader2, Clock, FileSpreadsheet, Truck } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { downloadExcelFromBase64 } from "@/lib/excel-export";
import type { ExcelArchive } from "@/types/database";

type ArchiveMeta = Omit<ExcelArchive, "file_data">;

export default function ArchivePage() {
  const { session } = useAuth();
  const [archives, setArchives] = useState<ArchiveMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const fetchArchives = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/archives", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setArchives(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    fetchArchives();
  }, [fetchArchives]);

  const handleDownload = async (id: string, fileName: string) => {
    if (!session?.access_token) return;
    setDownloading(id);
    try {
      const res = await fetch(`/api/archives/${id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        downloadExcelFromBase64(data.file_data, fileName);
      }
    } catch {
      alert("다운로드 실패");
    } finally {
      setDownloading(null);
    }
  };

  const handleSelectToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === archives.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(archives.map((a) => a.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size}개 파일을 삭제하시겠습니까?`)) return;
    if (!session?.access_token) return;

    setDeleting(true);
    try {
      const res = await fetch("/api/archives", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      if (res.ok) {
        setArchives((prev) => prev.filter((a) => !selectedIds.has(a.id)));
        setSelectedIds(new Set());
      } else {
        alert("삭제 실패");
      }
    } catch {
      alert("삭제 실패");
    } finally {
      setDeleting(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const getRemainingDays = (expiresAt: string) => {
    const now = new Date();
    const expires = new Date(expiresAt);
    const diff = expires.getTime() - now.getTime();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return Math.max(0, days);
  };

  const fileTypeLabel = (type: string) => {
    return type === "order_export" ? "발주서" : "플레이오토 운송장";
  };

  const fileTypeIcon = (type: string) => {
    return type === "order_export" ? FileSpreadsheet : Truck;
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Archive className="w-5 h-5 text-blue-400" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">보관함</h1>
          <span className="text-xs text-[var(--text-muted)] ml-2">자동 저장된 엑셀 파일 (7일 보관)</span>
        </div>

        {selectedIds.size > 0 && (
          <button
            onClick={handleBulkDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-2 bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50 text-sm rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? "삭제 중..." : `${selectedIds.size}개 삭제`}
          </button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
        </div>
      ) : archives.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-[var(--text-muted)]">
          <Archive className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">보관된 파일이 없습니다</p>
          <p className="text-xs mt-1">배송조회 수집 후 엑셀 내보내기를 하면 자동으로 저장됩니다</p>
        </div>
      ) : (
        <div className="space-y-1">
          {/* 전체 선택 */}
          <div className="flex items-center gap-3 px-4 py-2 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={selectedIds.size === archives.length && archives.length > 0}
              onChange={handleSelectAll}
              className="w-3.5 h-3.5 rounded border-[var(--border-strong)] bg-[var(--bg-hover)] accent-blue-500"
            />
            <span className="w-48">파일명</span>
            <span className="w-24">유형</span>
            <span className="w-16 text-center">건수</span>
            <span className="w-40">생성일</span>
            <span className="w-20 text-center">남은 기간</span>
            <span className="w-20 text-center ml-auto">다운로드</span>
          </div>

          {archives.map((archive) => {
            const Icon = fileTypeIcon(archive.file_type);
            const remaining = getRemainingDays(archive.expires_at);
            const isExpiringSoon = remaining <= 2;

            return (
              <div
                key={archive.id}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${
                  selectedIds.has(archive.id)
                    ? "bg-blue-500/10 border-blue-500/20"
                    : "bg-[var(--bg-subtle)] border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(archive.id)}
                  onChange={() => handleSelectToggle(archive.id)}
                  className="w-3.5 h-3.5 rounded border-[var(--border-strong)] bg-[var(--bg-hover)] accent-blue-500"
                />

                <div className="w-48 flex items-center gap-2 min-w-0">
                  <Icon className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                  <span className="text-sm text-[var(--text-primary)] truncate">{archive.file_name}</span>
                </div>

                <span className={`w-24 text-xs px-2 py-0.5 rounded-full border text-center ${
                  archive.file_type === "order_export"
                    ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                    : "bg-purple-500/10 text-purple-400 border-purple-500/20"
                }`}>
                  {fileTypeLabel(archive.file_type)}
                </span>

                <span className="w-16 text-sm text-[var(--text-tertiary)] text-center">{archive.order_count}건</span>

                <span className="w-40 text-xs text-[var(--text-muted)]">{formatDate(archive.created_at)}</span>

                <div className="w-20 flex items-center justify-center gap-1">
                  <Clock className={`w-3 h-3 ${isExpiringSoon ? "text-red-400" : "text-[var(--text-muted)]"}`} />
                  <span className={`text-xs ${isExpiringSoon ? "text-red-400" : "text-[var(--text-muted)]"}`}>
                    {remaining}일
                  </span>
                </div>

                <button
                  onClick={() => handleDownload(archive.id, archive.file_name)}
                  disabled={downloading === archive.id}
                  className="w-20 ml-auto flex items-center justify-center gap-1 px-2 py-1.5 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-50 transition-colors"
                >
                  {downloading === archive.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" />
                      받기
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
