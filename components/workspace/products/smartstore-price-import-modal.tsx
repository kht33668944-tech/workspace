"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { X, Upload, Loader2, CheckCircle, AlertCircle, AlertTriangle, FileSpreadsheet, ChevronDown, ChevronUp, Package } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface Props {
  onClose: () => void;
  onImported?: (result: ImportResult) => void;
}

interface ImportResult {
  total: number;
  rowsUpserted: number;
  matched: number;
  unmatchedProductNames: string[];
  optionRowCount: number;
}

interface StatusData {
  totalRows: number;
  matchedProductCount: number;
  lastImportedAt: string | null;
  matchedProducts: { id: string; product_name: string; smartstoreProductIds: string[]; hasOption: boolean }[];
}

export default function SmartstorePriceImportModal({ onClose, onImported }: Props) {
  const { session } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [showMatchedList, setShowMatchedList] = useState(false);
  const [productFilter, setProductFilter] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchStatus = useCallback(async () => {
    if (!session?.access_token) return;
    setStatusLoading(true);
    try {
      const res = await fetch("/api/smartstore-price-inventory/status", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const json = await res.json() as StatusData;
        setStatus(json);
      }
    } catch {
      // status는 부가 정보라 실패해도 무시
    } finally {
      setStatusLoading(false);
    }
  }, [session]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleFile = useCallback((f: File) => {
    if (!f.name.toLowerCase().endsWith(".xlsx")) {
      setError(".xlsx 파일만 업로드 가능합니다.");
      return;
    }
    setError(null);
    setFile(f);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleUpload = useCallback(async () => {
    if (!file || !session?.access_token) return;
    setUploading(true);
    setError(null);

    try {
      // FileReader로 base64 인코딩 (큰 파일에서 콜스택 초과 방지)
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result as string;
          const comma = r.indexOf(",");
          resolve(comma >= 0 ? r.slice(comma + 1) : r);
        };
        reader.onerror = () => reject(reader.error ?? new Error("파일 읽기 실패"));
        reader.readAsDataURL(file);
      });
      const res = await fetch("/api/smartstore-price-inventory/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ excelBase64: base64 }),
      });
      const json = await res.json() as ImportResult & { error?: string };
      if (!res.ok) {
        setError(json.error ?? `서버 오류 (${res.status})`);
        return;
      }
      setResult({
        total: json.total,
        rowsUpserted: json.rowsUpserted,
        matched: json.matched,
        unmatchedProductNames: json.unmatchedProductNames ?? [],
        optionRowCount: json.optionRowCount ?? 0,
      });
      onImported?.(json);
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "업로드 실패");
    } finally {
      setUploading(false);
    }
  }, [file, session, onImported, fetchStatus]);

  const copyUnmatched = () => {
    if (!result?.unmatchedProductNames.length) return;
    navigator.clipboard.writeText(result.unmatchedProductNames.join("\n"));
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "없음";
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  };

  const filteredProducts = status?.matchedProducts.filter(p =>
    !productFilter.trim() || p.product_name.toLowerCase().includes(productFilter.trim().toLowerCase())
  ) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">스마트스토어 일괄수정 임포트</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              스마트스토어 센터 → 상품관리 → 상품 일괄수정에서 받은 엑셀(.xlsx)을 업로드하세요
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {!result && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-main)] p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4 text-green-400" />
                <p className="text-xs font-medium text-[var(--text-primary)]">현재 임포트 상태</p>
              </div>
              {statusLoading ? (
                <p className="text-xs text-[var(--text-muted)]">불러오는 중...</p>
              ) : status ? (
                <>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)]">전체 행</p>
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{status.totalRows}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)]">매칭된 상품</p>
                      <p className="text-sm font-semibold text-green-400">{status.matchedProductCount}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)]">최근 임포트</p>
                      <p className="text-[11px] font-medium text-[var(--text-primary)]">{formatDate(status.lastImportedAt)}</p>
                    </div>
                  </div>
                  {status.matchedProductCount > 0 && (
                    <button
                      onClick={() => setShowMatchedList(v => !v)}
                      className="w-full flex items-center justify-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors mt-1"
                    >
                      {showMatchedList ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      매칭된 상품 목록 {showMatchedList ? "숨기기" : "보기"}
                    </button>
                  )}
                  {showMatchedList && (
                    <div className="space-y-2 pt-1">
                      <input
                        type="text"
                        value={productFilter}
                        onChange={(e) => setProductFilter(e.target.value)}
                        placeholder="상품명 검색..."
                        className="w-full px-2 py-1 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] outline-none focus:border-green-400"
                      />
                      <div className="max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-card)] divide-y divide-[var(--border)]">
                        {filteredProducts.length === 0 ? (
                          <p className="text-xs text-[var(--text-muted)] p-2 text-center">검색 결과 없음</p>
                        ) : (
                          filteredProducts.map(p => (
                            <div key={p.id} className="flex items-center justify-between px-2 py-1.5 text-xs gap-2">
                              <span className="text-[var(--text-primary)] truncate flex-1">{p.product_name}</span>
                              <span className="shrink-0 flex items-center gap-1.5">
                                {p.hasOption && (
                                  <span title="옵션 상품" className="text-amber-400">옵션</span>
                                )}
                                <span className="text-green-400 font-mono">{p.smartstoreProductIds[0] ?? ""}</span>
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                      <p className="text-[10px] text-[var(--text-muted)] text-right">
                        {productFilter ? `${filteredProducts.length} / ` : ""}{status.matchedProducts.length}개 상품
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">아직 임포트된 데이터가 없습니다.</p>
              )}
            </div>
          )}

          {!result ? (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                  dragOver ? "border-green-400 bg-green-400/10" : "border-[var(--border)] hover:border-green-400/60"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                />
                <FileSpreadsheet className="w-10 h-10 text-green-400 mx-auto mb-2" />
                {file ? (
                  <>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{file.name}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1">{(file.size / 1024).toFixed(1)} KB</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-[var(--text-primary)]">파일을 드래그하거나 클릭해서 선택</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1">.xlsx 양식만 가능 (최대 5MB)</p>
                  </>
                )}
              </div>

              {error && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-400 whitespace-pre-wrap">{error}</p>
                </div>
              )}

              <div className="text-xs text-[var(--text-muted)] space-y-1 px-1">
                <p>• 다운로드한 엑셀 그대로 업로드하세요 (시트행 3~5 가이드는 자동 제거됩니다).</p>
                <p>• D열(상품명)과 우리 상품명이 <strong>정확히 일치</strong>해야 매칭됩니다.</p>
                <p>• A열(상품번호) 기준으로 저장됩니다. 동일 양식 재업로드 시 기존 행이 갱신됩니다.</p>
                <p>• 옵션 상품은 옵션가가 자동 조정되지 않으니 별도 확인이 필요합니다.</p>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30">
                <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                <p className="text-sm text-green-400">임포트 완료</p>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-main)] py-3">
                  <p className="text-xs text-[var(--text-muted)]">전체 행</p>
                  <p className="text-lg font-semibold text-[var(--text-primary)]">{result.total}</p>
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-main)] py-3">
                  <p className="text-xs text-[var(--text-muted)]">매칭</p>
                  <p className="text-lg font-semibold text-green-400">{result.matched}</p>
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-main)] py-3">
                  <p className="text-xs text-[var(--text-muted)]">미매칭 상품</p>
                  <p className="text-lg font-semibold text-amber-400">{result.unmatchedProductNames.length}</p>
                </div>
              </div>

              {result.optionRowCount > 0 && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-300">
                    옵션형태가 단독형/조합형인 행이 {result.optionRowCount}건 있습니다. 내보내기 시 base 판매가만 교체되고
                    옵션가는 다운로드한 값 그대로 유지됩니다. 옵션 상품은 별도 확인이 필요합니다.
                  </p>
                </div>
              )}

              {result.unmatchedProductNames.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-amber-400">매칭 실패 상품명 (우리 DB에 없음)</p>
                    <button
                      onClick={copyUnmatched}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      목록 복사
                    </button>
                  </div>
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 max-h-48 overflow-y-auto p-3 space-y-1">
                    {result.unmatchedProductNames.map((name, i) => (
                      <p key={i} className="text-xs text-[var(--text-primary)] font-mono break-all">{name}</p>
                    ))}
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">
                    상품명을 우리 DB와 정확히 일치시키면 다음 임포트 시 매칭됩니다.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--border)] shrink-0">
          {!result ? (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                취소
              </button>
              <button
                onClick={handleUpload}
                disabled={!file || uploading}
                className="px-4 py-2 text-sm bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? "업로드 중..." : "임포트"}
              </button>
            </>
          ) : (
            <button onClick={onClose} className="px-4 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors">
              확인
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
