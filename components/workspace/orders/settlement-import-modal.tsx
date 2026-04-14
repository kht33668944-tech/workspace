"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { Upload, X, FileSpreadsheet, Check, AlertTriangle, ChevronDown } from "lucide-react";
import { parseSettlementExcel } from "@/lib/excel-parser";
import type { SettlementRow } from "@/lib/excel-parser";
import type { Order, OrderUpdate } from "@/types/database";

interface SettlementImportModalProps {
  orders: Order[];
  onUpdate: (id: string, updates: OrderUpdate, skipUndo?: boolean) => void;
  onClose: () => void;
  startBatchUndo: () => void;
  endBatchUndo: () => void;
  refetch: () => Promise<void>;
}

type MatchStatus = "matched" | "multiple" | "unmatched";

interface MatchResult {
  row: SettlementRow;
  status: MatchStatus;
  candidates: Order[];
  selectedOrderId: string | null;
}

// 매칭 로직: 수령인명 + 판매금액(매출) + 판매처
function matchRows(settlementRows: SettlementRow[], orders: Order[]): MatchResult[] {
  return settlementRows.map((row) => {
    // 1차: 수령인명으로 후보 필터
    let candidates = orders.filter(
      (o) => o.recipient_name?.trim() === row.recipientName
    );

    // 판매처가 있으면 추가 필터
    if (row.marketplace && candidates.length > 1) {
      const filtered = candidates.filter(
        (o) => o.marketplace === row.marketplace
      );
      if (filtered.length > 0) candidates = filtered;
    }

    // 2차: 판매금액(매출)이 일치하는 후보
    if (candidates.length > 1 && row.saleAmount > 0) {
      const amountMatch = candidates.filter(
        (o) => o.revenue === row.saleAmount
      );
      if (amountMatch.length > 0) candidates = amountMatch;
    }

    // 3차: 상품명 부분 일치
    if (candidates.length > 1 && row.productName) {
      const nameNorm = row.productName.toLowerCase().replace(/\s+/g, "");
      const nameMatch = candidates.filter((o) => {
        const orderName = (o.product_name || "").toLowerCase().replace(/\s+/g, "");
        return orderName.includes(nameNorm) || nameNorm.includes(orderName);
      });
      if (nameMatch.length > 0) candidates = nameMatch;
    }

    if (candidates.length === 1) {
      return { row, status: "matched" as MatchStatus, candidates, selectedOrderId: candidates[0].id };
    } else if (candidates.length > 1) {
      return { row, status: "multiple" as MatchStatus, candidates, selectedOrderId: null };
    } else {
      return { row, status: "unmatched" as MatchStatus, candidates: [], selectedOrderId: null };
    }
  });
}

export default function SettlementImportModal({
  orders,
  onUpdate,
  onClose,
  startBatchUndo,
  endBatchUndo,
  refetch,
}: SettlementImportModalProps) {
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [matchResults, setMatchResults] = useState<MatchResult[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    setMatchResults(null);

    try {
      const { rows } = await parseSettlementExcel(file);
      if (rows.length === 0) {
        setError("정산 데이터가 없습니다. 엑셀 양식을 확인해주세요.");
        return;
      }
      const results = matchRows(rows, orders);
      setMatchResults(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [orders]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleCandidateSelect = useCallback((index: number, orderId: string) => {
    setMatchResults((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = { ...next[index], selectedOrderId: orderId, status: "matched" };
      return next;
    });
  }, []);

  const stats = useMemo(() => {
    if (!matchResults) return { matched: 0, multiple: 0, unmatched: 0, total: 0 };
    const matched = matchResults.filter((r) => r.status === "matched").length;
    const multiple = matchResults.filter((r) => r.status === "multiple").length;
    const unmatched = matchResults.filter((r) => r.status === "unmatched").length;
    return { matched, multiple, unmatched, total: matchResults.length };
  }, [matchResults]);

  // 이미 정산금액이 있는 매칭 건수
  const existingSettlementCount = useMemo(() => {
    if (!matchResults) return 0;
    return matchResults.filter((r) => {
      if (!r.selectedOrderId) return false;
      const order = orders.find((o) => o.id === r.selectedOrderId);
      return order && order.settlement > 0;
    }).length;
  }, [matchResults, orders]);

  const applyableCount = useMemo(() => {
    if (!matchResults) return 0;
    return matchResults.filter((r) => {
      if (!r.selectedOrderId) return false;
      if (!overwriteExisting) {
        const order = orders.find((o) => o.id === r.selectedOrderId);
        if (order && order.settlement > 0) return false;
      }
      return true;
    }).length;
  }, [matchResults, orders, overwriteExisting]);

  const handleApply = async () => {
    if (!matchResults || applyableCount === 0) return;
    setApplying(true);

    startBatchUndo();
    for (const result of matchResults) {
      if (!result.selectedOrderId) continue;
      if (!overwriteExisting) {
        const order = orders.find((o) => o.id === result.selectedOrderId);
        if (order && order.settlement > 0) continue;
      }
      onUpdate(result.selectedOrderId, { settlement: result.row.settlementAmount }, false);
    }
    endBatchUndo();

    await refetch();
    setApplying(false);
    onClose();
  };

  const statusColor = (status: MatchStatus) => {
    switch (status) {
      case "matched": return "text-green-400";
      case "multiple": return "text-yellow-400";
      case "unmatched": return "text-red-400";
    }
  };

  const statusBg = (status: MatchStatus) => {
    switch (status) {
      case "matched": return "";
      case "multiple": return "bg-yellow-500/10";
      case "unmatched": return "bg-red-500/10";
    }
  };

  const statusLabel = (status: MatchStatus) => {
    switch (status) {
      case "matched": return "매칭";
      case "multiple": return "선택 필요";
      case "unmatched": return "미매칭";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-sm">
      <div className="w-full max-w-3xl mx-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">정산금액 가져오기</h2>
          <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {!matchResults ? (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                className={`
                  flex flex-col items-center justify-center py-16 border-2 border-dashed rounded-xl cursor-pointer transition-colors
                  ${dragOver ? "border-blue-400 bg-blue-500/10" : "border-[var(--border-strong)] hover:border-[var(--border-strong)] bg-[var(--bg-hover)]"}
                `}
              >
                <Upload className="w-10 h-10 text-[var(--text-muted)] mb-3" />
                <p className="text-[var(--text-tertiary)] text-sm">옥션/지마켓 정산 엑셀 파일을 드래그하거나 클릭해서 선택</p>
                <p className="text-[var(--text-muted)] text-xs mt-1">수령인명 기준으로 발주서와 매칭합니다 (.xlsx, .xls)</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
            </>
          ) : (
            <>
              {/* 파일 정보 + 통계 */}
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <FileSpreadsheet className="w-5 h-5 text-blue-400" />
                <span className="text-[var(--text-primary)] text-sm">{fileName}</span>
                <span className="text-[var(--text-muted)] text-sm">({stats.total}건)</span>
              </div>

              {/* 매칭 요약 */}
              <div className="flex items-center gap-4 mb-4 p-3 bg-[var(--bg-hover)] rounded-lg text-xs">
                <span className="text-green-400">
                  매칭 <strong>{stats.matched}</strong>건
                </span>
                {stats.multiple > 0 && (
                  <span className="text-yellow-400">
                    선택 필요 <strong>{stats.multiple}</strong>건
                  </span>
                )}
                {stats.unmatched > 0 && (
                  <span className="text-red-400">
                    미매칭 <strong>{stats.unmatched}</strong>건
                  </span>
                )}
              </div>

              {/* 덮어쓰기 옵션 */}
              {existingSettlementCount > 0 && (
                <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={overwriteExisting}
                      onChange={(e) => setOverwriteExisting(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-yellow-400 text-xs">
                      이미 정산금액이 있는 {existingSettlementCount}건도 덮어쓰기
                    </span>
                  </label>
                </div>
              )}

              {/* 매칭 결과 테이블 */}
              <div className="max-h-80 overflow-auto rounded-lg border border-[var(--border)]">
                <table className="w-full text-xs text-[var(--text-secondary)]">
                  <thead className="bg-[var(--bg-hover)] sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">상태</th>
                      <th className="px-3 py-2 text-left">수령인명</th>
                      <th className="px-3 py-2 text-left">판매처</th>
                      <th className="px-3 py-2 text-left">상품명 (엑셀)</th>
                      <th className="px-3 py-2 text-right">판매금액</th>
                      <th className="px-3 py-2 text-right">정산예정금액</th>
                      <th className="px-3 py-2 text-left">매칭 대상</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchResults.map((result, i) => (
                      <tr key={i} className={`border-t border-[var(--border-subtle)] ${statusBg(result.status)}`}>
                        <td className={`px-3 py-1.5 font-medium ${statusColor(result.status)}`}>
                          {statusLabel(result.status)}
                        </td>
                        <td className="px-3 py-1.5">{result.row.recipientName}</td>
                        <td className="px-3 py-1.5">{result.row.marketplace || "-"}</td>
                        <td className="px-3 py-1.5 max-w-40 truncate">{result.row.productName || "-"}</td>
                        <td className="px-3 py-1.5 text-right">{result.row.saleAmount.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-blue-400">
                          {result.row.settlementAmount.toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5">
                          {result.status === "matched" && result.selectedOrderId && (
                            <span className="text-green-400 text-xs">
                              {orders.find((o) => o.id === result.selectedOrderId)?.product_name?.slice(0, 20) || "매칭됨"}
                            </span>
                          )}
                          {result.status === "multiple" && (
                            <div className="relative">
                              <select
                                value={result.selectedOrderId || ""}
                                onChange={(e) => handleCandidateSelect(i, e.target.value)}
                                className="w-full px-1.5 py-1 bg-[var(--bg-hover)] border border-yellow-500/40 rounded text-xs text-[var(--text-primary)] outline-none"
                              >
                                <option value="">선택...</option>
                                {result.candidates.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.product_name?.slice(0, 25)} ({c.revenue?.toLocaleString()}원)
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                          {result.status === "unmatched" && (
                            <span className="text-red-400/60 text-xs">발주서에 없음</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </div>

        {matchResults && applyableCount > 0 && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border)]">
            <button
              onClick={() => { setMatchResults(null); setFileName(""); setError(null); }}
              className="px-4 py-2 text-sm text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            >
              다시 선택
            </button>
            <button
              onClick={handleApply}
              disabled={applying}
              className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Check className="w-4 h-4" />
              {applying ? "적용 중..." : `${applyableCount}건 정산금액 적용`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
