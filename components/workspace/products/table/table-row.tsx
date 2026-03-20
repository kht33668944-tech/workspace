"use client";

import React, { useState, useRef, useEffect, useCallback, memo } from "react";
import type { Product, CommissionPlatform } from "@/types/database";
import { COLUMNS, EDITABLE_KEYS, COMPUTED_KEYS, formatCell, type Col } from "./table-utils";
import { REGISTRATION_STATUSES, REGISTRATION_STATUS_COLORS } from "@/lib/constants";

interface RowProps {
  product: Product; rowIdx: number; colWidths: Record<string, number>;
  isChecked: boolean; activeCol: number; editingCol: number;
  initialChar: string | null;
  selMinC: number; selMaxC: number;
  showFillHandle: boolean; fillHandleCol: number; fillHighlightCol: number;
  onCellMouseDown: (r: number, c: number) => void;
  onCellMouseEnter: (r: number, c: number) => void;
  onCellDoubleClick: (r: number, c: number) => void;
  onCommit: (r: number, c: number, v: string | null, dir: string) => void;
  onBlurSave: (r: number, c: number, v: string) => void;
  onEditValueChange: (r: number, c: number, v: string) => void;
  onSelectToggle: (id: string) => void;
  onFillStart: (r: number, c: number, v: unknown) => void;
  onStatusChange: (id: string, status: string) => void;
  isMobile?: boolean;
  visibleColumns?: Col[];
  rateMap: Record<string, Record<CommissionPlatform, number>>;
  categories: string[];
}

const MemoRow = memo(function Row({
  product, rowIdx, colWidths, isChecked, activeCol, editingCol, initialChar,
  selMinC, selMaxC, showFillHandle, fillHandleCol, fillHighlightCol,
  onCellMouseDown, onCellMouseEnter, onCellDoubleClick, onCommit, onBlurSave, onEditValueChange, onSelectToggle, onFillStart,
  onStatusChange, isMobile, visibleColumns, rateMap, categories,
}: RowProps) {
  const [editValue, setEditValue] = useState("");
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopyCell = useCallback((key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  }, []);
  const statusDropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const editRef = useRef("");

  const cols = visibleColumns || COLUMNS;

  useEffect(() => {
    if (editingCol >= 0) {
      const colKey = COLUMNS[editingCol].key;
      let initVal: string;
      if (initialChar !== null) {
        initVal = initialChar;
      } else {
        const val = product[colKey as keyof Product];
        initVal = val == null ? "" : String(val);
      }
      setEditValue(initVal);
      editRef.current = initVal;
      onEditValueChange(rowIdx, editingCol, initVal);

      if (colKey === "category") {
        setTimeout(() => selectRef.current?.focus(), 0);
      } else {
        setTimeout(() => {
          inputRef.current?.focus();
          if (initialChar !== null) {
            const len = initialChar.length;
            inputRef.current?.setSelectionRange(len, len);
          } else {
            inputRef.current?.select();
          }
        }, 0);
      }
    }
  }, [editingCol, initialChar]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
    editRef.current = e.target.value;
    if (editingCol >= 0) onEditValueChange(rowIdx, editingCol, e.target.value);
  }, [rowIdx, editingCol, onEditValueChange]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onCommit(rowIdx, editingCol, editRef.current, e.shiftKey ? "up" : "down"); }
    else if (e.key === "Tab") { e.preventDefault(); onCommit(rowIdx, editingCol, editRef.current, e.shiftKey ? "left" : "right"); }
    else if (e.key === "Escape") { e.preventDefault(); onCommit(rowIdx, editingCol, null, "none"); }
  }, [rowIdx, editingCol, onCommit]);

  const onBlur = useCallback(() => {
    if (editingCol >= 0) onBlurSave(rowIdx, editingCol, editRef.current);
  }, [rowIdx, editingCol, onBlurSave]);

  const handleSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    editRef.current = e.target.value;
    onCommit(rowIdx, editingCol, e.target.value, "none");
  }, [rowIdx, editingCol, onCommit]);

  useEffect(() => {
    if (!statusDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [statusDropdownOpen]);

  return (
    <tr className={`border-t border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)] ${isMobile ? "cursor-pointer active:bg-[var(--bg-hover)]" : ""}`}>
      <td className={`px-2 ${isMobile ? "py-2" : "py-1.5"} sticky left-0 bg-[var(--cell-sticky-bg)] z-10 border-r border-[var(--border-subtle)]`}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onSelectToggle(product.id)}
          onClick={(e) => e.stopPropagation()}
          className={`accent-blue-500 ${isMobile ? "w-5 h-5" : ""}`}
        />
      </td>
      <td className={`relative px-1.5 ${isMobile ? "py-2" : "py-1.5"} border-r border-(--border-subtle)`} style={isMobile ? undefined : { width: 72, minWidth: 72, maxWidth: 72 }}>
        <div ref={statusDropdownRef} className="relative">
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setStatusDropdownOpen(o => !o); }}
            className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity whitespace-nowrap ${REGISTRATION_STATUS_COLORS[product.registration_status] || "bg-gray-500/20 text-gray-400"}`}
          >
            {product.registration_status || "등록전"}
          </button>
          {statusDropdownOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 bg-(--bg-card) border border-(--border) rounded-lg shadow-xl min-w-[90px]" onClick={e => e.stopPropagation()}>
              {REGISTRATION_STATUSES.map(s => (
                <button
                  key={s}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onStatusChange(product.id, s); setStatusDropdownOpen(false); }}
                  className={`w-full text-left px-2.5 py-1.5 text-xs hover:bg-(--bg-hover) transition-colors flex items-center gap-1.5 ${product.registration_status === s ? "font-medium" : ""}`}
                >
                  <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${REGISTRATION_STATUS_COLORS[s]}`}>{s}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </td>
      {cols.map((col) => {
        const ci = COLUMNS.findIndex(c => c.key === col.key);
        const val = product[col.key as keyof Product];
        const isSelected = ci === activeCol;
        const isEditing = ci === editingCol;
        const inSel = selMinC >= 0 && ci >= selMinC && ci <= selMaxC;
        const isFillHL = ci === fillHighlightCol;
        const isEditable = EDITABLE_KEYS.has(col.key);
        const isComputed = COMPUTED_KEYS.has(col.key);

        return (
          <td
            key={col.key}
            className={`relative ${isMobile ? "px-1.5 py-2" : "px-2 py-1.5"} ${isEditing ? "overflow-visible" : "overflow-hidden"} border-r border-[var(--border-subtle)] ${col.align === "right" ? "text-right" : "text-left"} ${
              isComputed ? "bg-[var(--bg-subtle)]" :
              isFillHL ? "bg-blue-500/10 ring-1 ring-blue-500/30 ring-inset" :
              inSel && !isSelected ? "bg-blue-500/10" : ""
            }`}
            style={isMobile ? undefined : { width: colWidths[col.key], minWidth: colWidths[col.key], maxWidth: colWidths[col.key] }}
            onMouseDown={isMobile ? undefined : ((e) => { if (e.button === 0) { e.preventDefault(); onCellMouseDown(rowIdx, ci); } })}
            onMouseEnter={isMobile ? undefined : (() => onCellMouseEnter(rowIdx, ci))}
            onDoubleClick={isMobile ? undefined : (() => onCellDoubleClick(rowIdx, ci))}
          >
            {isEditing && isEditable && !isMobile ? (
              col.key === "category" ? (
                <select
                  ref={selectRef}
                  value={editValue}
                  onChange={handleSelectChange}
                  onBlur={onBlur}
                  onKeyDown={onKeyDown}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="absolute left-0 top-0 h-full min-w-[200px] w-max bg-[var(--bg-card)] border-2 border-blue-500 rounded px-1.5 text-xs text-[var(--text-primary)] outline-none z-30 shadow-lg"
                >
                  <option value="">선택</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              ) : (
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={onChange}
                  onKeyDown={onKeyDown}
                  onBlur={onBlur}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="absolute left-0 top-0 h-full min-w-[280px] w-max bg-[var(--bg-card)] border-2 border-blue-500 rounded px-1.5 text-xs text-[var(--text-primary)] outline-none z-30 shadow-lg"
                />
              )
            ) : (col.key === "thumbnail_url" || col.key === "detail_html") && val ? (
              <div
                className={`text-xs truncate min-h-[22px] leading-[22px] px-1 cursor-pointer transition-colors ${
                  copiedKey === col.key
                    ? "text-green-400"
                    : "hover:text-blue-400"
                } ${isSelected ? "ring-2 ring-blue-500/70 rounded bg-blue-500/5" : ""}`}
                title={copiedKey === col.key ? "복사됨!" : `클릭하여 전체 복사\n${String(val)}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); handleCopyCell(col.key, String(val)); }}
              >
                {copiedKey === col.key ? "✓ 복사됨" : formatCell(col.key, val, product, rateMap)}
              </div>
            ) : (
              <div className={`text-xs truncate min-h-[22px] leading-[22px] px-1 ${
                isSelected ? "ring-2 ring-blue-500/70 rounded bg-blue-500/5" : ""
              }`}>
                {formatCell(col.key, val, product, rateMap)}
              </div>
            )}
            {!isMobile && showFillHandle && ci === fillHandleCol && isEditable && (
              <div
                onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onFillStart(rowIdx, ci, val); }}
                className="absolute -bottom-1 -right-1 w-3 h-3 bg-blue-500 border-2 border-white rounded-sm cursor-crosshair z-10"
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}, (prev, next) =>
  prev.product === next.product &&
  prev.isChecked === next.isChecked &&
  prev.colWidths === next.colWidths &&
  prev.activeCol === next.activeCol &&
  prev.editingCol === next.editingCol &&
  prev.initialChar === next.initialChar &&
  prev.selMinC === next.selMinC &&
  prev.selMaxC === next.selMaxC &&
  prev.showFillHandle === next.showFillHandle &&
  prev.fillHandleCol === next.fillHandleCol &&
  prev.fillHighlightCol === next.fillHighlightCol &&
  prev.isMobile === next.isMobile &&
  prev.visibleColumns === next.visibleColumns &&
  prev.rateMap === next.rateMap &&
  prev.categories === next.categories &&
  prev.onStatusChange === next.onStatusChange
);

export default MemoRow;
