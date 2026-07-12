"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { X, Upload, Loader2, CheckCircle, AlertCircle, FileSpreadsheet, ChevronDown, ChevronUp, Package, Trash2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface Props {
  onClose: () => void;
  onImported?: (result: ImportResult) => void;
}

interface ImportResult {
  total: number;
  rowsUpserted: number;
  matched: number;
  productStatusUpdated?: number;
  unmatchedProductNames: string[];
}

interface StatusData {
  totalRows: number;
  matchedProductCount: number;
  lastImportedAt: string | null;
  matchedProducts: { id: string; product_name: string; optionCount: number }[];
}

export default function CoupangPriceImportModal({ onClose, onImported }: Props) {
  const { session } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [showMatchedList, setShowMatchedList] = useState(false);
  const [productFilter, setProductFilter] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchStatus = useCallback(async () => {
    if (!session?.access_token) return;
    setStatusLoading(true);
    try {
      const res = await fetch("/api/coupang-price-inventory/status", {
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
      const res = await fetch("/api/coupang-price-inventory/import", {
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
        productStatusUpdated: json.productStatusUpdated ?? 0,
        unmatchedProductNames: json.unmatchedProductNames ?? [],
      });
      onImported?.(json);
      fetchStatus(); // 임포트 후 상태 갱신
    } catch (e) {
      setError(e instanceof Error ? e.message : "업로드 실패");
    } finally {
      setUploading(false);
    }
  }, [file, session, onImported, fetchStatus]);

  const handleClear = useCallback(async () => {
    if (!session?.access_token || !status?.totalRows || clearing) return;
    const confirmed = window.confirm(
      `기존 쿠팡 가격수정 V2 정보 ${status.totalRows}행을 모두 삭제할까요?\n소싱 상품과 다른 판매처 정보는 삭제되지 않습니다.`
    );
    if (!confirmed) return;

    setClearing(true);
    setError(null);
    try {
      const res = await fetch("/api/coupang-price-inventory/clear", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const json = await res.json() as { deleted?: number; error?: string };
      if (!res.ok) {
        setError(json.error ?? "기존 정보 삭제 실패");
        return;
      }
      setResult(null);
      setFile(null);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "기존 정보 삭제 실패");
    } finally {
      setClearing(false);
    }
  }, [session, status, clearing, fetchStatus]);

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
            <h2 className="text-base font-semibold text-[var(--text-primary)]">쿠팡 가격수정 양식 임포트</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              쿠팡 셀러센터에서 다운받은 가격/재고 일괄변경 양식(.xlsx)을 업로드하세요
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* 현재 임포트 상태 패널 */}
          {!result && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-main)] p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4 text-orange-400" />
                <p className="text-xs font-medium text-[var(--text-primary)]">현재 임포트 상태</p>
              </div>
              {statusLoading ? (
                <p className="text-xs text-[var(--text-muted)]">불러오는 중...</p>
              ) : status ? (
                <>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)]">연결된 상품</p>
                      <p className="text-sm font-semibold text-green-400">{status.matchedProductCount}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)]">옵션 행</p>
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{status.totalRows}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)]">최근 임포트</p>
                      <p className="text-[11px] font-medium text-[var(--text-primary)]">{formatDate(status.lastImportedAt)}</p>
                    </div>
                  </div>
                  {status.totalRows > 0 && (
                    <button
                      onClick={handleClear}
                      disabled={clearing}
                      className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                    >
                      {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      {clearing ? "기존 정보 비우는 중..." : "기존 쿠팡 가격수정 정보 비우기"}
                    </button>
                  )}
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
                        className="w-full px-2 py-1 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] outline-none focus:border-orange-400"
                      />
                      <div className="max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-card)] divide-y divide-[var(--border)]">
                        {filteredProducts.length === 0 ? (
                          <p className="text-xs text-[var(--text-muted)] p-2 text-center">검색 결과 없음</p>
                        ) : (
                          filteredProducts.map(p => (
                            <div key={p.id} className="flex items-center justify-between px-2 py-1.5 text-xs">
                              <span className="text-[var(--text-primary)] truncate flex-1 mr-2">{p.product_name}</span>
                              <span className="text-orange-400 shrink-0">옵션 {p.optionCount}</span>
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
                  dragOver ? "border-orange-400 bg-orange-400/10" : "border-[var(--border)] hover:border-orange-400/60"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                />
                <FileSpreadsheet className="w-10 h-10 text-orange-400 mx-auto mb-2" />
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
                <p>• 양식의 H열(업체 등록 상품명)과 우리 상품명이 <strong>정확히 일치</strong>해야 매칭됩니다.</p>
                <p>• 옵션 ID 기준으로 저장됩니다. 동일 양식 재업로드 시 기존 행이 갱신됩니다.</p>
                <p>• 새 상품을 쿠팡에 등록한 뒤에는 양식을 다시 임포트하세요.</p>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30">
                <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                <p className="text-sm text-green-400">임포트 완료</p>
              </div>

              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-main)] py-3">
                  <p className="text-xs text-[var(--text-muted)]">연결된 상품</p>
                  <p className="text-lg font-semibold text-green-400">{result.productStatusUpdated ?? 0}</p>
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-main)] py-3">
                  <p className="text-xs text-[var(--text-muted)]">미매칭 상품</p>
                  <p className="text-lg font-semibold text-amber-400">{result.unmatchedProductNames.length}</p>
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-main)] py-3">
                  <p className="text-xs text-[var(--text-muted)]">옵션 행</p>
                  <p className="text-lg font-semibold text-[var(--text-primary)]">{result.total}</p>
                </div>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-main)] py-3">
                  <p className="text-xs text-[var(--text-muted)]">매칭 행</p>
                  <p className="text-lg font-semibold text-blue-400">{result.matched}</p>
                </div>
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                상품 수를 먼저 보여줍니다. 옵션 행은 쿠팡 옵션/판매 단위 때문에 상품 수보다 클 수 있습니다.
              </p>

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
                className="px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? "업로드 중..." : "임포트"}
              </button>
            </>
          ) : (
            <button onClick={onClose} className="px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition-colors">
              확인
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
