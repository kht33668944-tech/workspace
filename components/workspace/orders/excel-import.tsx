"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { Upload, X, FileSpreadsheet, Check, AlertTriangle } from "lucide-react";
import { parseExcelFile, parseExcelSheet } from "@/lib/excel-parser";
import type { OrderInsert } from "@/types/database";

interface ExcelImportProps {
  onImport: (orders: OrderInsert[]) => Promise<{ error: string | null }>;
  onClose: () => void;
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

export default function ExcelImport({ onImport, onClose }: ExcelImportProps) {
  const [dragOver, setDragOver] = useState(false);
  const [parsedOrders, setParsedOrders] = useState<OrderInsert[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState(0);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawFile, setRawFile] = useState<File | null>(null);
  const [manualDate, setManualDate] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 날짜가 없는 주문이 있는지 확인
  const dateInfo = useMemo(() => {
    if (!parsedOrders || parsedOrders.length === 0) return { hasDates: true, missingCount: 0 };
    const missingCount = parsedOrders.filter(o => !o.order_date).length;
    return { hasDates: missingCount === 0, missingCount };
  }, [parsedOrders]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    setRawFile(file);
    setManualDate("");

    // 파일명에서 날짜 추출 시도
    const filenameDate = extractDateFromFilename(file.name);
    if (filenameDate) {
      setManualDate(filenameDate);
    }

    try {
      const result = await parseExcelFile(file, 0);
      if (result.orders.length === 0 && result.sheetNames.length > 1) {
        for (let i = 1; i < result.sheetNames.length; i++) {
          const orders = await parseExcelSheet(file, i);
          if (orders.length > 0) {
            setSheetNames(result.sheetNames);
            setSelectedSheet(i);
            setParsedOrders(orders);
            return;
          }
        }
      }
      setSheetNames(result.sheetNames);
      setParsedOrders(result.orders);
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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleConfirm = async () => {
    if (!parsedOrders || parsedOrders.length === 0) return;
    setImporting(true);

    // 날짜가 없는 주문에 수동 날짜 적용
    let ordersToImport = parsedOrders;
    if (dateInfo.missingCount > 0 && manualDate) {
      const dateValue = `${manualDate}T00:00:00Z`;
      ordersToImport = parsedOrders.map(o =>
        o.order_date ? o : { ...o, order_date: dateValue }
      );
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 bg-[#1e1e2e] border border-white/10 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white">엑셀 가져오기</h2>
          <button onClick={onClose} className="p-1 text-white/40 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {!parsedOrders ? (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                className={`
                  flex flex-col items-center justify-center py-16 border-2 border-dashed rounded-xl cursor-pointer transition-colors
                  ${dragOver ? "border-blue-400 bg-blue-500/10" : "border-white/20 hover:border-white/40 bg-white/5"}
                `}
              >
                <Upload className="w-10 h-10 text-white/40 mb-3" />
                <p className="text-white/60 text-sm">플레이오토 엑셀 파일을 드래그하거나 클릭해서 선택</p>
                <p className="text-white/30 text-xs mt-1">.xlsx, .xls, .csv 지원</p>
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
                <span className="text-white text-sm">{fileName}</span>
                <span className="text-white/40 text-sm">({parsedOrders.length}건)</span>

                {sheetNames.length > 1 && (
                  <select
                    value={selectedSheet}
                    onChange={(e) => handleSheetChange(Number(e.target.value))}
                    className="ml-auto px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-white outline-none"
                  >
                    {sheetNames.map((name, i) => (
                      <option key={i} value={i}>{name}</option>
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
                    <label className="text-white/50 text-xs">주문 날짜:</label>
                    <input
                      type="date"
                      value={manualDate}
                      onChange={(e) => setManualDate(e.target.value)}
                      className="px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-white outline-none"
                    />
                    {manualDate && (
                      <span className="text-green-400 text-xs">
                        → {manualDate.slice(0, 7)} 월에 저장됩니다
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="max-h-64 overflow-auto rounded-lg border border-white/10">
                <table className="w-full text-xs text-white/70">
                  <thead className="bg-white/5 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">묶음번호</th>
                      <th className="px-3 py-2 text-left">주문일시</th>
                      <th className="px-3 py-2 text-left">판매처</th>
                      <th className="px-3 py-2 text-left">수취인명</th>
                      <th className="px-3 py-2 text-left">상품명</th>
                      <th className="px-3 py-2 text-right">매출</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedOrders.slice(0, 20).map((order, i) => (
                      <tr key={i} className="border-t border-white/5">
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
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsedOrders.length > 20 && (
                  <p className="text-center text-white/30 text-xs py-2">... 외 {parsedOrders.length - 20}건</p>
                )}
              </div>
            </>
          )}

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </div>

        {parsedOrders && parsedOrders.length > 0 && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/10">
            <button
              onClick={() => { setParsedOrders(null); setFileName(""); setRawFile(null); setSheetNames([]); setManualDate(""); }}
              className="px-4 py-2 text-sm text-white/60 hover:text-white transition-colors"
            >
              다시 선택
            </button>
            <button
              onClick={handleConfirm}
              disabled={importing || (dateInfo.missingCount > 0 && !manualDate)}
              className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Check className="w-4 h-4" />
              {importing ? "가져오는 중..." : `${parsedOrders.length}건 가져오기`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
