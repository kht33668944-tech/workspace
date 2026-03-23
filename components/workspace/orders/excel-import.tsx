"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { Upload, X, FileSpreadsheet, Check, AlertTriangle, Copy, Link } from "lucide-react";
import { parseExcelFile, parseExcelSheet } from "@/lib/excel-parser";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { OrderInsert } from "@/types/database";

interface ExcelImportProps {
  onImport: (orders: OrderInsert[]) => Promise<{ error: string | null }>;
  onClose: () => void;
  checkDuplicates?: (rows: OrderInsert[]) => Promise<Set<number>>;
}

// 파일명에서 날짜 추출 (발주양식_20260307225752207.xlsx → 2026-03-07)
function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{4})(\d{2})(\d{2})/);
  if (match) {
    const [, y, m, d] = match;
    const num = Number(y);
    if (num >= 2020 && num <= 2099 && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return `${y}-${m}-${d}`;
    }
  }
  return null;
}

// 상품명 정규화: 공백 통일, 소문자 변환
function normalizeProductName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export default function ExcelImport({ onImport, onClose, checkDuplicates }: ExcelImportProps) {
  const { user } = useAuth();
  const [dragOver, setDragOver] = useState(false);
  const [parsedOrders, setParsedOrders] = useState<OrderInsert[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState(0);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawFile, setRawFile] = useState<File | null>(null);
  const [manualDate, setManualDate] = useState<string>("");
  const [duplicateIndices, setDuplicateIndices] = useState<Set<number>>(new Set());
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [matchedUrlCount, setMatchedUrlCount] = useState(0);
  const enrichedRef = useRef(false); // 중복 매칭 방지
  const fileRef = useRef<HTMLInputElement>(null);

  // parsedOrders 변경 시 중복 체크 실행
  useEffect(() => {
    if (!parsedOrders || parsedOrders.length === 0 || !checkDuplicates) {
      setDuplicateIndices(new Set());
      return;
    }
    let cancelled = false;
    setCheckingDuplicates(true);
    checkDuplicates(parsedOrders).then((dupes) => {
      if (!cancelled) {
        setDuplicateIndices(dupes);
        setCheckingDuplicates(false);
      }
    });
    return () => { cancelled = true; };
  }, [parsedOrders, checkDuplicates]);

  // 상품소싱에서 구매 URL 매칭
  useEffect(() => {
    if (!parsedOrders || parsedOrders.length === 0 || !user) {
      setMatchedUrlCount(0);
      return;
    }
    // 이미 매칭 완료된 결과면 스킵 (무한 루프 방지)
    if (enrichedRef.current) {
      enrichedRef.current = false;
      return;
    }
    let cancelled = false;

    (async () => {
      // purchase_url이 없는 주문의 상품명 수집
      const ordersNeedingUrl = parsedOrders
        .map((o, i) => ({ index: i, name: o.product_name }))
        .filter((o) => o.name);
      if (ordersNeedingUrl.length === 0) return;

      // 사용자의 전체 상품 목록 조회 (product_name, purchase_url만)
      const PAGE_SIZE = 1000;
      const allProducts: { product_name: string; purchase_url: string }[] = [];
      let from = 0;
      let hasMore = true;
      while (hasMore) {
        const { data } = await supabase
          .from("products")
          .select("product_name, purchase_url")
          .eq("user_id", user.id)
          .not("purchase_url", "is", null)
          .range(from, from + PAGE_SIZE - 1);
        if (!data || data.length === 0) break;
        allProducts.push(...data);
        hasMore = data.length === PAGE_SIZE;
        from += PAGE_SIZE;
      }
      if (cancelled || allProducts.length === 0) return;

      // 정규화된 상품명 → purchase_url 맵 생성
      const productUrlMap = new Map<string, string>();
      for (const p of allProducts) {
        if (p.product_name && p.purchase_url) {
          productUrlMap.set(normalizeProductName(p.product_name), p.purchase_url);
        }
      }

      // 주문에 purchase_url 매칭
      let matched = 0;
      const enriched = parsedOrders.map((order) => {
        // 이미 purchase_url이 있으면 스킵
        if (order.purchase_url) return order;
        if (!order.product_name) return order;

        const normalized = normalizeProductName(order.product_name);
        const url = productUrlMap.get(normalized);
        if (url) {
          matched++;
          return { ...order, purchase_url: url };
        }
        return order;
      });

      if (!cancelled && matched > 0) {
        enrichedRef.current = true;
        setParsedOrders(enriched);
        setMatchedUrlCount(matched);
      }
    })();

    return () => { cancelled = true; };
  }, [parsedOrders, user]); // eslint-disable-line react-hooks/exhaustive-deps

  const duplicateCount = duplicateIndices.size;

  // 날짜가 없는 주문이 있는지 확인
  const dateInfo = useMemo(() => {
    if (!parsedOrders || parsedOrders.length === 0) return { hasDates: true, missingCount: 0 };
    const missingCount = parsedOrders.filter(o => !o.order_date).length;
    return { hasDates: missingCount === 0, missingCount };
  }, [parsedOrders]);

  const [isLegacy, setIsLegacy] = useState(false);
  const [sheetCounts, setSheetCounts] = useState<number[]>([]);
  const [showSheetPicker, setShowSheetPicker] = useState(false);
  const [pendingFile, setPendingFile] = useState<{ file: File; sheetNames: string[]; counts: number[]; isLegacy: boolean } | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    setRawFile(file);
    setManualDate("");
    setIsLegacy(false);
    setSheetCounts([]);
    setShowSheetPicker(false);
    setPendingFile(null);

    // 파일명에서 날짜 추출 시도
    const filenameDate = extractDateFromFilename(file.name);
    if (filenameDate) {
      setManualDate(filenameDate);
    }

    try {
      const result = await parseExcelFile(file, 0);
      setIsLegacy(result.isLegacyFormat || false);

      // 여러 시트 + 데이터 있는 시트가 2개 이상이면 시트 선택 팝업
      if (result.sheetNames.length > 1 && result.sheetOrderCounts) {
        const sheetsWithData = result.sheetOrderCounts.filter((c) => c > 0).length;
        setSheetCounts(result.sheetOrderCounts);

        if (sheetsWithData > 1) {
          setPendingFile({
            file,
            sheetNames: result.sheetNames,
            counts: result.sheetOrderCounts,
            isLegacy: result.isLegacyFormat || false,
          });
          setShowSheetPicker(true);
          return;
        }
      }

      setSheetNames(result.sheetNames);
      setParsedOrders(result.orders);
      if (result.sheetOrderCounts) setSheetCounts(result.sheetOrderCounts);
      if (result.orders.length === 0) {
        setError("파싱된 데이터가 없습니다. 엑셀 형식을 확인해주세요.");
      }
    } catch {
      setError("엑셀 파일을 읽을 수 없습니다.");
    }
  }, []);

  const handleSheetChange = useCallback(async (index: number) => {
    if (!rawFile) return;
    setSelectedSheet(index);
    setError(null);
    try {
      const orders = await parseExcelSheet(rawFile, index);
      setParsedOrders(orders);
      if (orders.length === 0) {
        setError("이 시트에는 데이터가 없습니다.");
      }
    } catch {
      setError("시트를 읽을 수 없습니다.");
    }
  }, [rawFile]);

  const handleSheetPick = useCallback(async (index: number) => {
    if (!pendingFile) return;
    setShowSheetPicker(false);
    setSheetNames(pendingFile.sheetNames);
    setSheetCounts(pendingFile.counts);
    setSelectedSheet(index);
    setIsLegacy(pendingFile.isLegacy);
    setRawFile(pendingFile.file);
    try {
      const orders = await parseExcelSheet(pendingFile.file, index);
      setParsedOrders(orders);
      if (orders.length === 0) {
        setError("이 시트에는 데이터가 없습니다.");
      }
    } catch {
      setError("시트를 읽을 수 없습니다.");
    }
    setPendingFile(null);
  }, [pendingFile]);

  const handleImportAllSheets = useCallback(async () => {
    if (!pendingFile) return;
    setShowSheetPicker(false);
    setSheetNames(pendingFile.sheetNames);
    setSheetCounts(pendingFile.counts);
    setIsLegacy(pendingFile.isLegacy);
    setRawFile(pendingFile.file);

    const allOrders: OrderInsert[] = [];
    for (let i = 0; i < pendingFile.sheetNames.length; i++) {
      if (pendingFile.counts[i] === 0) continue;
      try {
        const orders = await parseExcelSheet(pendingFile.file, i);
        allOrders.push(...orders);
      } catch { /* skip */ }
    }
    setParsedOrders(allOrders);
    if (allOrders.length === 0) {
      setError("파싱된 데이터가 없습니다.");
    }
    setPendingFile(null);
  }, [pendingFile]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const doImport = async (excludeDuplicates: boolean) => {
    if (!parsedOrders || parsedOrders.length === 0) return;
    setImporting(true);

    // 날짜가 없는 주문에 수동 날짜 적용
    let ordersToImport = parsedOrders.map((o, i) => {
      let order = o;
      if (!o.order_date && manualDate) {
        order = { ...order, order_date: `${manualDate}T00:00:00Z` };
      }
      // 중복 표시 (전체 가져오기 시)
      if (!excludeDuplicates && duplicateIndices.has(i)) {
        order = { ...order, is_duplicate: true };
      }
      return order;
    });

    // 중복 제외
    if (excludeDuplicates && duplicateCount > 0) {
      ordersToImport = ordersToImport.filter((_, i) => !duplicateIndices.has(i));
    }

    if (ordersToImport.length === 0) {
      setError("가져올 주문이 없습니다 (모두 중복).");
      setImporting(false);
      return;
    }

    const { error } = await onImport(ordersToImport);
    if (error) {
      setError(error);
      setImporting(false);
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">엑셀 가져오기</h2>
          <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {showSheetPicker && pendingFile ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="w-5 h-5 text-green-400" />
                <span className="text-[var(--text-primary)] text-sm">{fileName}</span>
                {pendingFile.isLegacy && (
                  <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 text-xs rounded">기존 발주서</span>
                )}
              </div>
              <p className="text-[var(--text-tertiary)] text-sm">여러 시트가 감지되었습니다. 가져올 시트를 선택하세요.</p>
              <div className="space-y-2">
                {pendingFile.sheetNames.map((name, i) => (
                  <button
                    key={i}
                    onClick={() => handleSheetPick(i)}
                    disabled={pendingFile.counts[i] === 0}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border transition-colors ${
                      pendingFile.counts[i] > 0
                        ? "border-[var(--border)] bg-[var(--bg-hover)] hover:bg-[var(--bg-active)] text-[var(--text-primary)] cursor-pointer"
                        : "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--text-disabled)] cursor-not-allowed"
                    }`}
                  >
                    <span className="text-sm font-medium">{name}</span>
                    <span className={`text-xs ${pendingFile.counts[i] > 0 ? "text-[var(--text-tertiary)]" : "text-[var(--text-disabled)]"}`}>
                      {pendingFile.counts[i]}건
                    </span>
                  </button>
                ))}
              </div>
              <button
                onClick={handleImportAllSheets}
                className="w-full px-4 py-2.5 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 text-sm font-medium rounded-lg transition-colors"
              >
                전체 시트 합쳐서 가져오기 ({pendingFile.counts.reduce((a, b) => a + b, 0)}건)
              </button>
            </div>
          ) : !parsedOrders ? (
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
                <p className="text-[var(--text-tertiary)] text-sm">엑셀 파일을 드래그하거나 클릭해서 선택</p>
                <p className="text-[var(--text-muted)] text-xs mt-1">플레이오토 양식 · 기존 발주서 양식 자동 인식 (.xlsx, .xls, .csv)</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <FileSpreadsheet className="w-5 h-5 text-green-400" />
                <span className="text-[var(--text-primary)] text-sm">{fileName}</span>
                <span className="text-[var(--text-muted)] text-sm">({parsedOrders.length}건)</span>
                {isLegacy && (
                  <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 text-xs rounded">기존 발주서</span>
                )}

                {sheetNames.length > 1 && (
                  <select
                    value={selectedSheet}
                    onChange={(e) => handleSheetChange(Number(e.target.value))}
                    className="ml-auto px-2 py-1 bg-[var(--bg-hover)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] outline-none"
                  >
                    {sheetNames.map((name, i) => (
                      <option key={i} value={i} className="bg-[var(--bg-elevated)] text-[var(--text-primary)]">
                        {name}{sheetCounts[i] !== undefined ? ` (${sheetCounts[i]}건)` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* 날짜 누락 경고 + 날짜 선택 */}
              {dateInfo.missingCount > 0 && (
                <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
                    <span className="text-yellow-400 text-xs font-medium">
                      주문일시가 없는 데이터 {dateInfo.missingCount}건 — 날짜를 지정해주세요
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[var(--text-tertiary)] text-xs">주문 날짜:</label>
                    <input
                      type="date"
                      value={manualDate}
                      onChange={(e) => setManualDate(e.target.value)}
                      className="px-2 py-1 bg-[var(--bg-hover)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] outline-none"
                    />
                    {manualDate && (
                      <span className="text-green-400 text-xs">
                        → {manualDate.slice(0, 7)} 월에 저장됩니다
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* 중복 경고 */}
              {duplicateCount > 0 && !checkingDuplicates && (
                <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Copy className="w-4 h-4 text-yellow-400 shrink-0" />
                    <span className="text-yellow-400 text-xs font-medium">
                      기존 발주서와 중복되는 주문이 {duplicateCount}건 있습니다
                    </span>
                  </div>
                  <p className="text-[var(--text-muted)] text-xs mt-1 ml-6">
                    중복 행은 노란색으로 표시됩니다. 중복 포함 시 발주서에서도 표시됩니다.
                  </p>
                </div>
              )}
              {checkingDuplicates && (
                <div className="mb-4 text-xs text-[var(--text-muted)]">중복 확인 중...</div>
              )}

              {/* 상품소싱 URL 매칭 결과 */}
              {matchedUrlCount > 0 && (
                <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Link className="w-4 h-4 text-green-400 shrink-0" />
                    <span className="text-green-400 text-xs font-medium">
                      상품소싱에서 구매 URL {matchedUrlCount}건이 자동 매칭되었습니다
                    </span>
                  </div>
                </div>
              )}

              <div className="max-h-64 overflow-auto rounded-lg border border-[var(--border)]">
                <table className="w-full text-xs text-[var(--text-secondary)]">
                  <thead className="bg-[var(--bg-hover)] sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">묶음번호</th>
                      <th className="px-3 py-2 text-left">주문일시</th>
                      <th className="px-3 py-2 text-left">판매처</th>
                      <th className="px-3 py-2 text-left">수취인명</th>
                      <th className="px-3 py-2 text-left">상품명</th>
                      <th className="px-3 py-2 text-right">매출</th>
                      {isLegacy && (
                        <>
                          <th className="px-3 py-2 text-right">정산</th>
                          <th className="px-3 py-2 text-right">원가</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {parsedOrders.slice(0, 20).map((order, i) => (
                      <tr key={i} className={`border-t border-[var(--border-subtle)] ${duplicateIndices.has(i) ? "bg-yellow-500/15" : ""}`}>
                        <td className="px-3 py-1.5">{i + 1}</td>
                        <td className="px-3 py-1.5">{order.bundle_no ?? "-"}</td>
                        <td className="px-3 py-1.5">
                          {order.order_date
                            ? order.order_date.slice(0, 10)
                            : manualDate
                              ? <span className="text-yellow-400">{manualDate}</span>
                              : <span className="text-red-400">없음</span>
                          }
                        </td>
                        <td className="px-3 py-1.5">{order.marketplace ?? "-"}</td>
                        <td className="px-3 py-1.5">{order.recipient_name ?? "-"}</td>
                        <td className="px-3 py-1.5 max-w-48 truncate">{order.product_name ?? "-"}</td>
                        <td className="px-3 py-1.5 text-right">{order.revenue?.toLocaleString() ?? 0}</td>
                        {isLegacy && (
                          <>
                            <td className="px-3 py-1.5 text-right">{order.settlement?.toLocaleString() ?? 0}</td>
                            <td className="px-3 py-1.5 text-right">{order.cost?.toLocaleString() ?? 0}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsedOrders.length > 20 && (
                  <p className="text-center text-[var(--text-muted)] text-xs py-2">... 외 {parsedOrders.length - 20}건</p>
                )}
              </div>
            </>
          )}

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </div>

        {parsedOrders && parsedOrders.length > 0 && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border)]">
            <button
              onClick={() => { setParsedOrders(null); setFileName(""); setRawFile(null); setSheetNames([]); setManualDate(""); setDuplicateIndices(new Set()); setMatchedUrlCount(0); enrichedRef.current = false; }}
              className="px-4 py-2 text-sm text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            >
              다시 선택
            </button>
            {duplicateCount > 0 && !checkingDuplicates ? (
              <>
                <button
                  onClick={() => doImport(true)}
                  disabled={importing || (dateInfo.missingCount > 0 && !manualDate)}
                  className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-[var(--text-primary)] text-sm font-medium rounded-lg transition-colors"
                >
                  <Check className="w-4 h-4" />
                  {importing ? "가져오는 중..." : `중복 제외 ${parsedOrders.length - duplicateCount}건 가져오기`}
                </button>
                <button
                  onClick={() => doImport(false)}
                  disabled={importing || (dateInfo.missingCount > 0 && !manualDate)}
                  className="flex items-center gap-2 px-4 py-2 bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30 disabled:opacity-50 text-sm font-medium rounded-lg transition-colors"
                >
                  {importing ? "가져오는 중..." : `전체 ${parsedOrders.length}건 가져오기`}
                </button>
              </>
            ) : (
              <button
                onClick={() => doImport(false)}
                disabled={importing || checkingDuplicates || (dateInfo.missingCount > 0 && !manualDate)}
                className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-[var(--text-primary)] text-sm font-medium rounded-lg transition-colors"
              >
                <Check className="w-4 h-4" />
                {importing ? "가져오는 중..." : `${parsedOrders.length}건 가져오기`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
