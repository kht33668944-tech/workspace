"use client";

import React, { useState, useRef, useEffect, useCallback, memo } from "react";
import { DELIVERY_STATUS_COLORS } from "@/lib/constants";
import type { Order } from "@/types/database";
import { COLUMNS, EDITABLE_KEYS, FORMULA_KEYS, formatCell, type Col } from "./table-utils";

interface RowProps {
  order: Order; rowIdx: number; colWidths: Record<string, number>;
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
  onStartEdit: (r: number, c: number) => void;
  onRowClick?: (order: Order) => void;
  isMobile?: boolean;
  visibleColumns?: Col[];
}

const MemoRow = memo(function Row({
  order, rowIdx, colWidths, isChecked, activeCol, editingCol, initialChar,
  selMinC, selMaxC, showFillHandle, fillHandleCol, fillHighlightCol,
  onCellMouseDown, onCellMouseEnter, onCellDoubleClick, onCommit, onBlurSave, onEditValueChange, onSelectToggle, onFillStart,
  onStartEdit, onRowClick, isMobile, visibleColumns,
}: RowProps) {
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef("");
  const typingStartedRef = useRef(false);

  const cols = visibleColumns || COLUMNS;

  // 셀 선택 시 투명 input에 포커스
  useEffect(() => {
    if (activeCol >= 0 && editingCol < 0) {
      setEditValue("");
      editRef.current = "";
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [activeCol]); // eslint-disable-line react-hooks/exhaustive-deps

  // 편집 모드 진입 시 초기값 설정
  useEffect(() => {
    if (editingCol >= 0) {
      if (typingStartedRef.current) {
        // 투명 input에서 타이핑으로 시작 → 값 이미 설정됨, 리셋하지 않음
        typingStartedRef.current = false;
        onEditValueChange(rowIdx, editingCol, editRef.current);
        return;
      }
      // Enter/더블클릭으로 편집 시작
      let initVal: string;
      if (initialChar !== null) {
        initVal = initialChar;
      } else {
        const val = order[COLUMNS[editingCol].key as keyof Order];
        initVal = val == null ? "" : String(val);
      }
      setEditValue(initVal);
      editRef.current = initVal;
      onEditValueChange(rowIdx, editingCol, initVal);
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
  }, [editingCol, initialChar]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEditValue(value);
    editRef.current = value;
    if (editingCol >= 0) {
      // 이미 편집 중 — 일반 변경
      onEditValueChange(rowIdx, editingCol, value);
    } else if (activeCol >= 0) {
      // 투명 input에서 타이핑 → 편집 모드로 전환
      typingStartedRef.current = true;
      onStartEdit(rowIdx, activeCol);
    }
  }, [rowIdx, editingCol, activeCol, onEditValueChange, onStartEdit]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (editingCol >= 0) {
      // 편집 모드 키 처리
      if (e.key === "Enter") { e.preventDefault(); onCommit(rowIdx, editingCol, editRef.current, e.shiftKey ? "up" : "down"); }
      else if (e.key === "Tab") { e.preventDefault(); onCommit(rowIdx, editingCol, editRef.current, e.shiftKey ? "left" : "right"); }
      else if (e.key === "Escape") { e.preventDefault(); onCommit(rowIdx, editingCol, null, "none"); }
    }
    // 투명 input일 때는 이벤트가 테이블로 버블링되어 방향키 등 처리됨
  }, [rowIdx, editingCol, onCommit]);

  const onBlur = useCallback(() => {
    if (editingCol >= 0) onBlurSave(rowIdx, editingCol, editRef.current);
  }, [rowIdx, editingCol, onBlurSave]);

  const handleRowClick = useCallback(() => {
    if (isMobile && onRowClick) onRowClick(order);
  }, [isMobile, onRowClick, order]);

  return (
    <tr
      className={`border-t border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)] ${isMobile ? "cursor-pointer active:bg-[var(--bg-hover)]" : ""} ${order.is_duplicate ? "bg-yellow-500/10" : ""}`}
      onClick={isMobile ? handleRowClick : undefined}
    >
      <td className={`px-2 ${isMobile ? "py-2" : "py-1.5"} sticky left-0 bg-[var(--cell-sticky-bg)] z-10 border-r border-[var(--border-subtle)]`}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onSelectToggle(order.id)}
          onClick={(e) => e.stopPropagation()}
          className={`accent-blue-500 ${isMobile ? "w-5 h-5" : ""}`}
        />
      </td>
      {cols.map((col) => {
        const ci = COLUMNS.findIndex(c => c.key === col.key);
        const val = order[col.key as keyof Order];
        const isSelected = ci === activeCol;
        const isEditing = ci === editingCol;
        const inSel = selMinC >= 0 && ci >= selMinC && ci <= selMaxC;
        const isFillHL = ci === fillHighlightCol;
        const isEditable = EDITABLE_KEYS.has(col.key);
        const showInput = !isMobile && isEditable && (isSelected || isEditing);

        return (
          <td
            key={col.key}
            className={`relative ${isMobile ? "px-1.5 py-2" : "px-2 py-1.5"} ${isEditing ? "overflow-visible" : "overflow-hidden"} border-r border-[var(--border-subtle)] ${col.align === "right" ? "text-right" : "text-left"} ${
              isFillHL ? "bg-blue-500/10 ring-1 ring-blue-500/30 ring-inset" :
              inSel && !isSelected ? "bg-blue-500/10" : ""
            }`}
            style={isMobile ? undefined : { width: colWidths[col.key], minWidth: colWidths[col.key], maxWidth: colWidths[col.key] }}
            onMouseDown={isMobile ? undefined : ((e) => { if (e.button === 0) { e.preventDefault(); onCellMouseDown(rowIdx, ci); } })}
            onMouseEnter={isMobile ? undefined : (() => onCellMouseEnter(rowIdx, ci))}
            onDoubleClick={isMobile ? undefined : (() => onCellDoubleClick(rowIdx, ci))}
          >
            {col.key === "delivery_status" ? (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onRowClick?.(order); }}
                className={`inline-block rounded font-medium cursor-pointer hover:opacity-80 transition-opacity whitespace-nowrap ${isMobile ? "text-[11px] px-1.5 py-0.5" : "px-2 py-0.5 text-xs"} ${DELIVERY_STATUS_COLORS[String(val)] || "bg-gray-500/20 text-gray-400"}`}
                title="클릭하여 상담내역 열기"
              >
                {String(val || "결제전")}
              </button>
            ) : (
              <>
                {/* 셀 표시값 — 투명 input 뒤에 보임 */}
                <div className={`text-xs truncate min-h-[22px] leading-[22px] px-1 ${
                  isSelected && !isEditing ? "ring-2 ring-blue-500/70 rounded bg-blue-500/5" : ""
                }`}>
                  {formatCell(col.key, val, col.key === "tracking_no" ? order : undefined)}
                </div>
                {/* 셀 선택 시 투명 input 렌더, 편집 시 시각적 input으로 전환 (같은 엘리먼트) */}
                {showInput && (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={onChange}
                    onKeyDown={onKeyDown}
                    onBlur={onBlur}
                    onMouseDown={(e) => e.stopPropagation()}
                    placeholder={isEditing && FORMULA_KEYS.has(col.key) ? "=매출*0.9" : undefined}
                    className={isEditing
                      ? "absolute left-0 top-0 h-full min-w-[280px] w-max bg-[var(--bg-card)] border-2 border-blue-500 rounded px-1.5 text-xs text-[var(--text-primary)] outline-none z-30 shadow-lg"
                      : "absolute inset-0 w-full h-full opacity-0 text-xs outline-none z-20"
                    }
                  />
                )}
              </>
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
  prev.order === next.order &&
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
  prev.visibleColumns === next.visibleColumns
);

export default MemoRow;
