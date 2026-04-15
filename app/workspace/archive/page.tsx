"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Archive, Download, Trash2, Loader2, Clock, FileSpreadsheet, Truck, Package } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { downloadExcelFromBase64 } from "@/lib/excel-export";
import type { ExcelArchive } from "@/types/database";

type ArchiveMeta = Omit<ExcelArchive, "file_data">;
type TabType = "playauto_tracking" | "order_export" | "playauto_product";

export default function ArchivePage() {
  const { session } = useAuth();
  const [archives, setArchives] = useState<ArchiveMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>("playauto_tracking");
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

  // 탭 전환 시 선택 초기화
  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    setSelectedIds(new Set());
  };

  const tabArchives = archives.filter((a) => a.file_type === activeTab);

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
    if (selectedIds.size === tabArchives.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tabArchives.map((a) => a.id)));
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

  const { trackingCount, orderCount, productCount } = useMemo(() => {
    let t = 0, o = 0, p = 0;
    for (const a of archives) {
      if (a.file_type === "playauto_tracking") t++;
      else if (a.file_type === "order_export") o++;
      else if (a.file_type === "playauto_product") p++;
    }
    return { trackingCount: t, orderCount: o, productCount: p };
  }, [archives]);

  const retentionLabel = activeTab === "playauto_product" ? "30일 보관" : "7일 보관";

  const groupedByDate = useMemo(() => {
    if (activeTab !== "playauto_product") return [];
    const groups: Record<string, ArchiveMeta[]> = {};
    tabArchives.forEach((a) => {
      const dateKey = new Date(a.created_at).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(a);
    });
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [tabArchives, activeTab]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Archive className="w-5 h-5 text-blue-400" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">보관함</h1>
          <span className="text-xs text-[var(--text-muted)] ml-2">자동 저장된 엑셀 파일 ({retentionLabel})</span>
        </div>

        {selectedIds.size > 0 && (
          <button
            onClick={handleBulkDelete}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50 text-sm rounded-lg transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? "삭제 중..." : `${selectedIds.size}개 삭제`}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="overflow-x-auto scrollbar-hide border-b border-[var(--border-subtle)]">
      <div className="flex gap-1 min-w-max">
        <button
          onClick={() => handleTabChange("playauto_tracking")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px min-h-[44px] ${
            activeTab === "playauto_tracking"
              ? "border-purple-400 text-purple-400"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          }`}
        >
          <Truck className="w-4 h-4" />
          플레이오토 운송장
          {trackingCount > 0 && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === "playauto_tracking" ? "bg-purple-500/20 text-purple-400" : "bg-[var(--bg-hover)] text-[var(--text-muted)]"}`}>
              {trackingCount}
            </span>
          )}
        </button>
        <button
          onClick={() => handleTabChange("order_export")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px min-h-[44px] ${
            activeTab === "order_export"
              ? "border-blue-400 text-blue-400"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          }`}
        >
          <FileSpreadsheet className="w-4 h-4" />
          발주서
          {orderCount > 0 && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === "order_export" ? "bg-blue-500/20 text-blue-400" : "bg-[var(--bg-hover)] text-[var(--text-muted)]"}`}>
              {orderCount}
            </span>
          )}
        </button>
        <button
          onClick={() => handleTabChange("playauto_product")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px min-h-[44px] ${
            activeTab === "playauto_product"
              ? "border-violet-400 text-violet-400"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          }`}
        >
          <Package className="w-4 h-4" />
          대량등록엑셀
          {productCount > 0 && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === "playauto_product" ? "bg-violet-500/20 text-violet-400" : "bg-[var(--bg-hover)] text-[var(--text-muted)]"}`}>
              {productCount}
            </span>
          )}
        </button>
      </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-[var(--text-muted)] animate-spin" />
        </div>
      ) : tabArchives.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-[var(--text-muted)]">
          <Archive className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">보관된 파일이 없습니다</p>
          <p className="text-xs mt-1">
            {activeTab === "playauto_tracking"
              ? "운송장 수집 후 자동으로 저장됩니다"
              : activeTab === "playauto_product"
              ? "플레이오토 내보내기 시 자동으로 저장됩니다"
              : "발주서 엑셀 내보내기 시 자동으로 저장됩니다"}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto scrollbar-hide">
        <div className="space-y-1 min-w-[600px]">
          {/* 전체 선택 헤더 */}
          <div className="flex items-center gap-3 px-4 py-2 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={selectedIds.size === tabArchives.length && tabArchives.length > 0}
              onChange={handleSelectAll}
              className="w-3.5 h-3.5 rounded border-[var(--border-strong)] bg-[var(--bg-hover)] accent-blue-500"
            />
            <span className="w-48">파일명</span>
            <span className="w-16 text-center">건수</span>
            <span className="w-40">생성일</span>
            <span className="w-20 text-center">남은 기간</span>
            <span className="w-20 text-center ml-auto">다운로드</span>
          </div>

          {activeTab === "playauto_product" ? (
            // 대량등록엑셀: 날짜별 그룹핑
            groupedByDate.map(([dateLabel, items]) => (
              <div key={dateLabel}>
                <div className="px-4 py-1.5 text-xs font-medium text-violet-400 bg-violet-500/5 border-l-2 border-violet-400 mt-2 first:mt-0">
                  {dateLabel}
                  <span className="text-[var(--text-muted)] ml-2">{items.length}개</span>
                </div>
                {items.map((archive) => (
                  <ArchiveRow key={archive.id} archive={archive} activeTab={activeTab} selectedIds={selectedIds} downloading={downloading} onToggle={handleSelectToggle} onDownload={handleDownload} formatDate={formatDate} getRemainingDays={getRemainingDays} />
                ))}
              </div>
            ))
          ) : (
            tabArchives.map((archive) => (
              <ArchiveRow key={archive.id} archive={archive} activeTab={activeTab} selectedIds={selectedIds} downloading={downloading} onToggle={handleSelectToggle} onDownload={handleDownload} formatDate={formatDate} getRemainingDays={getRemainingDays} />
            ))
          )}
        </div>
        </div>
      )}
    </div>
  );
}

function ArchiveRow({ archive, activeTab, selectedIds, downloading, onToggle, onDownload, formatDate, getRemainingDays }: {
  archive: ArchiveMeta;
  activeTab: TabType;
  selectedIds: Set<string>;
  downloading: string | null;
  onToggle: (id: string) => void;
  onDownload: (id: string, fileName: string) => void;
  formatDate: (d: string) => string;
  getRemainingDays: (d: string) => number;
}) {
  const Icon = activeTab === "order_export" ? FileSpreadsheet : activeTab === "playauto_product" ? Package : Truck;
  const iconColor = activeTab === "order_export" ? "text-blue-400" : activeTab === "playauto_product" ? "text-violet-400" : "text-purple-400";
  const remaining = getRemainingDays(archive.expires_at);
  const isExpiringSoon = activeTab === "playauto_product" ? remaining <= 5 : remaining <= 2;

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${
        selectedIds.has(archive.id)
          ? "bg-blue-500/10 border-blue-500/20"
          : "bg-[var(--bg-subtle)] border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
      }`}
    >
      <input
        type="checkbox"
        checked={selectedIds.has(archive.id)}
        onChange={() => onToggle(archive.id)}
        className="w-3.5 h-3.5 rounded border-[var(--border-strong)] bg-[var(--bg-hover)] accent-blue-500"
      />
      <div className="w-48 flex items-center gap-2 min-w-0">
        <Icon className={`w-4 h-4 shrink-0 ${iconColor}`} />
        <span className="text-sm text-[var(--text-primary)] truncate">{archive.file_name}</span>
      </div>
      <span className="w-16 text-sm text-[var(--text-tertiary)] text-center">{archive.order_count}건</span>
      <span className="w-40 text-xs text-[var(--text-muted)]">{formatDate(archive.created_at)}</span>
      <div className="w-20 flex items-center justify-center gap-1">
        <Clock className={`w-3 h-3 ${isExpiringSoon ? "text-red-400" : "text-[var(--text-muted)]"}`} />
        <span className={`text-xs ${isExpiringSoon ? "text-red-400" : "text-[var(--text-muted)]"}`}>
          {remaining}일
        </span>
      </div>
      <button
        onClick={() => onDownload(archive.id, archive.file_name)}
        disabled={downloading === archive.id}
        className="w-20 ml-auto flex items-center justify-center gap-1 px-2 py-1.5 min-h-[44px] bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-50 transition-colors"
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
}
