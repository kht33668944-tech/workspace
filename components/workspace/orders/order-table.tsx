"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { Filter, Check, ArrowUp, ArrowDown } from "lucide-react";
import { MARKETPLACES, DELIVERY_STATUS_COLORS } from "@/lib/constants";
import type { Order, OrderUpdate } from "@/types/database";

interface OrderTableProps {
  orders: Order[];
  allOrders: Order[];
  loading: boolean;
  selectedIds: Set<string>;
  onSelectToggle: (id: string) => void;
  onSelectAll: () => void;
  onUpdate: (id: string, updates: OrderUpdate) => void;
  onUndo?: () => void;
  onDeleteSelected?: () => void;
  onRowClick?: (order: Order) => void;
  columnFilters: Record<string, string[]>;
  onColumnFilterChange: (key: string, values: string[]) => void;
}

// margin 제외 모든 컬럼 편집 가능 (address 포함)
const EDITABLE_KEYS = new Set([
  "bundle_no", "order_date", "marketplace", "recipient_name", "product_name",
  "quantity", "recipient_phone", "orderer_phone", "postal_code", "address", "address_detail",
  "delivery_memo", "revenue", "settlement", "cost", "payment_method",
  "purchase_id", "purchase_source", "purchase_url", "purchase_order_no", "courier", "tracking_no", "delivery_status", "memo",
]);
const NUMERIC_KEYS = new Set(["quantity", "revenue", "settlement", "cost"]);
const FORMULA_KEYS = new Set(["settlement"]);

interface Col { key: string; label: string; minWidth: number; align?: "right"; }
const COLUMNS: Col[] = [
  { key: "delivery_status", label: "배송상태", minWidth: 85 },
  { key: "bundle_no", label: "묶음번호", minWidth: 110 },
  { key: "order_date", label: "주문일시", minWidth: 125 },
  { key: "marketplace", label: "판매처", minWidth: 80 },
  { key: "recipient_name", label: "수취인명", minWidth: 70 },
  { key: "product_name", label: "상품명", minWidth: 200 },
  { key: "quantity", label: "수량", minWidth: 45, align: "right" },
  { key: "recipient_phone", label: "수령자번호", minWidth: 110 },
  { key: "orderer_phone", label: "주문자번호", minWidth: 110 },
  { key: "postal_code", label: "우편번호", minWidth: 65 },
  { key: "address", label: "기본주소", minWidth: 200 },
  { key: "address_detail", label: "상세주소", minWidth: 120 },
  { key: "delivery_memo", label: "배송메모", minWidth: 100 },
  { key: "revenue", label: "매출", minWidth: 75, align: "right" },
  { key: "settlement", label: "정산예정", minWidth: 75, align: "right" },
  { key: "cost", label: "원가", minWidth: 75, align: "right" },
  { key: "margin", label: "마진", minWidth: 75, align: "right" },
  { key: "payment_method", label: "결제방식", minWidth: 75 },
  { key: "purchase_id", label: "구매아이디", minWidth: 110 },
  { key: "purchase_source", label: "구매처", minWidth: 80 },
  { key: "purchase_url", label: "최저가링크", minWidth: 130 },
  { key: "purchase_order_no", label: "주문번호", minWidth: 120 },
  { key: "courier", label: "택배사", minWidth: 85 },
  { key: "tracking_no", label: "운송장", minWidth: 130 },
];
const COL_COUNT = COLUMNS.length;

type SortDir = "asc" | "desc" | null;
interface CellPos { row: number; col: number }
interface SelRange { r1: number; c1: number; r2: number; c2: number }

function norm(s: SelRange) {
  return { minR: Math.min(s.r1, s.r2), maxR: Math.max(s.r1, s.r2), minC: Math.min(s.c1, s.c2), maxC: Math.max(s.c1, s.c2) };
}

function processValue(colKey: string, raw: string, revenue?: number): unknown {
  const t = raw.trim();
  if (NUMERIC_KEYS.has(colKey)) {
    if (FORMULA_KEYS.has(colKey) && t.startsWith("=") && revenue !== undefined) {
      const expr = t.slice(1).replace(/매출/g, String(revenue)).replace(/revenue/gi, String(revenue));
      if (/^[\d+\-*/().%\s]+$/.test(expr)) {
        try { const r = Math.round(Function(`"use strict"; return (${expr})`)()); if (!isNaN(r)) return r; } catch { /* */ }
      }
      return 0;
    }
    const n = parseInt(t.replace(/,/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }
  return t || null;
}

function formatCell(key: string, val: unknown): React.ReactNode {
  if (val == null || val === "") return <span className="text-[var(--text-disabled)] text-xs">-</span>;
  if (key === "delivery_status") {
    const color = DELIVERY_STATUS_COLORS[String(val)] || "bg-gray-500/20 text-gray-400";
    return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color}`}>{String(val)}</span>;
  }
  if (key === "margin") {
    const n = Number(val);
    return <span className={`text-xs font-medium ${n > 0 ? "text-green-400" : n < 0 ? "text-red-400" : "text-[var(--text-secondary)]"}`}>{n.toLocaleString()}</span>;
  }
  if (key === "order_date") {
    const s = String(val);
    return <span className="text-[var(--text-secondary)] text-xs">{s.length >= 16 ? s.slice(0, 16).replace("T", " ") : s.slice(0, 10)}</span>;
  }
  if (key === "marketplace") {
    const mp = MARKETPLACES[String(val)];
    if (mp) return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${mp.color}`}>{mp.label}</span>;
  }
  if (key === "purchase_url") {
    const url = String(val);
    return <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 text-xs truncate block max-w-full hover:underline" title={url} onClick={e => e.stopPropagation()}>{url.replace(/^https?:\/\//, "").slice(0, 30)}...</a>;
  }
  if (NUMERIC_KEYS.has(key)) return <span className="text-[var(--text-secondary)] text-xs">{Number(val).toLocaleString()}</span>;
  return <span title={String(val)} className="text-[var(--text-secondary)] text-xs truncate block max-w-full">{String(val)}</span>;
}

// ════════════════════════════════════
// OrderTable
// ════════════════════════════════════
const PAGE_SIZE = 100;

function OrderTable({
  orders: rawOrders, allOrders, loading, selectedIds, onSelectToggle, onSelectAll, onUpdate,
  onUndo, onDeleteSelected, onRowClick, columnFilters, onColumnFilterChange,
}: OrderTableProps) {
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const o: Record<string, number> = {};
    COLUMNS.forEach(c => { o[c.key] = c.minWidth; });
    return o;
  });
  const [filterOpen, setFilterOpen] = useState<string | null>(null);
  const [activeCell, setActiveCell] = useState<CellPos | null>(null);
  const [selection, setSelection] = useState<SelRange | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [fillDrag, setFillDrag] = useState<{ colIdx: number; startRow: number; endRow: number; value: unknown } | null>(null);
  const [page, setPage] = useState(0);

  const tableRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<CellPos | null>(null);
  const isDraggingRef = useRef(false);

  // 데이터가 바뀌면 페이지 리셋
  const prevLenRef = useRef(rawOrders.length);
  useEffect(() => {
    if (rawOrders.length !== prevLenRef.current) {
      setPage(0);
      prevLenRef.current = rawOrders.length;
    }
  }, [rawOrders.length]);

  const allSelected = rawOrders.length > 0 && selectedIds.size === rawOrders.length;

  // Sort
  const sortedOrders = useMemo(() => {
    if (!sort?.dir) return rawOrders;
    const s = [...rawOrders];
    s.sort((a, b) => {
      const av = a[sort.key as keyof Order], bv = b[sort.key as keyof Order];
      if (av == null) return 1; if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return sort.dir === "asc" ? av - bv : bv - av;
      const c = String(av).localeCompare(String(bv), "ko");
      return sort.dir === "asc" ? c : -c;
    });
    return s;
  }, [rawOrders, sort]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sortedOrders.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const orders = sortedOrders.slice(pageStart, pageStart + PAGE_SIZE);

  // Save cell
  const saveValue = useCallback((row: number, col: number, raw: string) => {
    const order = orders[row];
    if (!order) return;
    const key = COLUMNS[col]?.key;
    if (!key || !EDITABLE_KEYS.has(key)) return;
    const oldVal = order[key as keyof Order];
    const newVal = processValue(key, raw, order.revenue);
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      onUpdate(order.id, { [key]: newVal });
    }
  }, [orders, onUpdate]);

  // Commit (save + navigate)
  const handleCommit = useCallback((row: number, col: number, val: string | null, dir: string) => {
    if (val !== null) saveValue(row, col, val);
    const maxR = orders.length - 1, maxC = COL_COUNT - 1;
    let nr = row, nc = col;
    switch (dir) {
      case "down": nr = Math.min(row + 1, maxR); break;
      case "up": nr = Math.max(row - 1, 0); break;
      case "right": nc = col + 1; if (nc > maxC) { nc = 0; nr = Math.min(row + 1, maxR); } break;
      case "left": nc = col - 1; if (nc < 0) { nc = maxC; nr = Math.max(row - 1, 0); } break;
      case "blur": return;
      case "none": setActiveCell(null); return;
    }
    setActiveCell({ row: nr, col: nc });
    setSelection({ r1: nr, c1: nc, r2: nr, c2: nc });
  }, [orders.length, saveValue]);

  // Mouse: cell mousedown
  const handleCellMouseDown = useCallback((row: number, col: number) => {
    dragStartRef.current = { row, col };
    isDraggingRef.current = false;
    setSelection({ r1: row, c1: col, r2: row, c2: col });
  }, []);

  // Mouse: cell mouseenter during drag
  const handleCellMouseEnter = useCallback((row: number, col: number) => {
    if (!dragStartRef.current) return;
    isDraggingRef.current = true;
    setActiveCell(null);
    setSelection(prev => prev ? { r1: prev.r1, c1: prev.c1, r2: row, c2: col } : null);
  }, []);

  // Global mouseup
  useEffect(() => {
    const handler = () => {
      if (!dragStartRef.current) return;
      if (!isDraggingRef.current) {
        setActiveCell({ ...dragStartRef.current });
      }
      dragStartRef.current = null;
      isDraggingRef.current = false;
    };
    document.addEventListener("mouseup", handler);
    return () => document.removeEventListener("mouseup", handler);
  }, []);

  // Click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tableRef.current && !tableRef.current.contains(e.target as Node)) {
        setActiveCell(null);
        setSelection(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Copy
  const handleCopy = useCallback(() => {
    if (!selection) return;
    const { minR, maxR, minC, maxC } = norm(selection);
    const lines: string[] = [];
    for (let r = minR; r <= maxR; r++) {
      const o = orders[r]; if (!o) continue;
      const cells: string[] = [];
      for (let c = minC; c <= maxC; c++) {
        const v = o[COLUMNS[c].key as keyof Order];
        cells.push(v == null ? "" : String(v));
      }
      lines.push(cells.join("\t"));
    }
    navigator.clipboard.writeText(lines.join("\n"));
  }, [selection, orders]);

  // Paste
  const handlePaste = useCallback(async () => {
    const target = activeCell || (selection ? { row: norm(selection).minR, col: norm(selection).minC } : null);
    if (!target) return;
    try {
      const text = await navigator.clipboard.readText();
      const rows = text.split(/\r?\n/).filter(r => r.length > 0);
      for (let ri = 0; ri < rows.length; ri++) {
        const cells = rows[ri].split("\t");
        for (let ci = 0; ci < cells.length; ci++) {
          const tR = target.row + ri, tC = target.col + ci;
          if (tR >= orders.length || tC >= COL_COUNT) continue;
          const o = orders[tR], k = COLUMNS[tC].key;
          if (!EDITABLE_KEYS.has(k)) continue;
          const v = processValue(k, cells[ci], o.revenue);
          onUpdate(o.id, { [k]: v });
        }
      }
    } catch { /* clipboard denied */ }
  }, [activeCell, selection, orders, onUpdate]);

  // Table keydown
  const handleTableKeyDown = useCallback((e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === "c" && selection) {
      const { minR, maxR, minC, maxC } = norm(selection);
      if ((minR !== maxR || minC !== maxC) || !activeCell) {
        e.preventDefault();
        handleCopy();
      }
    }
    if (ctrl && e.key === "v") { e.preventDefault(); handlePaste(); }
    if (ctrl && e.key === "z") { e.preventDefault(); onUndo?.(); return; }

    // Delete key with checkbox-selected rows → delete rows
    if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0 && onDeleteSelected) {
      e.preventDefault();
      onDeleteSelected();
      return;
    }

    if (!activeCell && selection) {
      const { minR, minC } = norm(selection);
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        let r = minR, c = minC;
        if (e.key === "ArrowDown") r = Math.min(r + 1, orders.length - 1);
        if (e.key === "ArrowUp") r = Math.max(r - 1, 0);
        if (e.key === "ArrowRight") c = Math.min(c + 1, COL_COUNT - 1);
        if (e.key === "ArrowLeft") c = Math.max(c - 1, 0);
        setSelection({ r1: r, c1: c, r2: r, c2: c });
        setActiveCell({ row: r, col: c });
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const { minR: r1, maxR: r2, minC: c1, maxC: c2 } = norm(selection);
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
          const o = orders[r], k = COLUMNS[c].key;
          if (!o || !EDITABLE_KEYS.has(k)) continue;
          onUpdate(o.id, { [k]: NUMERIC_KEYS.has(k) ? 0 : null });
        }
      }
      if (e.key.length === 1 && !ctrl && !e.altKey) {
        setActiveCell({ row: minR, col: minC });
      }
    }
  }, [activeCell, selection, orders, selectedIds, onDeleteSelected, onUndo, onUpdate, handleCopy, handlePaste]);

  // Fill drag
  useEffect(() => {
    if (!fillDrag) return;
    const onMove = (e: MouseEvent) => {
      const tbody = tableRef.current?.querySelector("tbody");
      if (!tbody) return;
      const rows = tbody.querySelectorAll("tr");
      let closest = fillDrag.startRow;
      rows.forEach((row, idx) => {
        const rect = row.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) closest = idx;
        else if (e.clientY > rect.bottom) closest = idx;
      });
      if (closest > fillDrag.startRow) setFillDrag(p => p ? { ...p, endRow: closest } : null);
    };
    const onUp = () => {
      if (fillDrag.endRow > fillDrag.startRow) {
        const colKey = COLUMNS[fillDrag.colIdx].key;
        for (let i = fillDrag.startRow + 1; i <= fillDrag.endRow; i++) {
          const o = orders[i];
          if (o && EDITABLE_KEYS.has(colKey)) onUpdate(o.id, { [colKey]: fillDrag.value });
        }
      }
      setFillDrag(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [fillDrag, orders, onUpdate]);

  const handleFillStart = useCallback((row: number, col: number, value: unknown) => {
    setFillDrag({ colIdx: col, startRow: row, endRow: row, value });
  }, []);

  const handleSort = useCallback((key: string, dir: SortDir) => {
    setSort(dir ? { key, dir } : null);
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-[var(--text-muted)] border-t-[var(--text-primary)] rounded-full animate-spin" />
    </div>
  );
  if (sortedOrders.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-[var(--text-muted)]">
      <p className="text-sm">주문 데이터가 없습니다</p>
      <p className="text-xs mt-1">엑셀 파일을 가져오거나 수동으로 추가해주세요</p>
    </div>
  );

  const sn = selection ? norm(selection) : null;

  return (
    <div className="space-y-2">
      <div
        ref={tableRef}
        className="rounded-xl border border-[var(--border)] overflow-auto focus:outline-none"
        style={{ maxHeight: "calc(100vh - 300px)" }}
        tabIndex={0}
        onKeyDown={handleTableKeyDown}
      >
        <table className="w-max min-w-full text-sm border-collapse">
          <thead className="bg-[var(--table-header-bg)] sticky top-0 z-20">
            <tr>
              <th className="px-2 py-2.5 w-10 sticky left-0 bg-[var(--table-header-bg)] z-30">
                <input type="checkbox" checked={allSelected} onChange={onSelectAll} className="accent-blue-500" />
              </th>
              {COLUMNS.map(col => (
                <ResizableHeader
                  key={col.key} col={col} width={colWidths[col.key]}
                  onResize={w => setColWidths(p => ({ ...p, [col.key]: w }))}
                  hasFilter={!!columnFilters[col.key]?.length}
                  filterOpen={filterOpen === col.key}
                  onFilterToggle={() => setFilterOpen(filterOpen === col.key ? null : col.key)}
                  selectedValues={columnFilters[col.key] || []}
                  onFilterChange={v => onColumnFilterChange(col.key, v)}
                  allOrders={allOrders}
                  columnFilters={columnFilters}
                  sort={sort?.key === col.key ? sort.dir : null}
                  onSort={dir => handleSort(col.key, dir)}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((order, rowIdx) => {
              const ac = activeCell?.row === rowIdx ? activeCell.col : -1;
              let selMinC = -1, selMaxC = -1;
              if (sn && rowIdx >= sn.minR && rowIdx <= sn.maxR) { selMinC = sn.minC; selMaxC = sn.maxC; }
              const showFill = sn ? rowIdx === sn.maxR : activeCell?.row === rowIdx;
              const fillCol = sn ? sn.maxC : (activeCell?.row === rowIdx ? activeCell.col : -1);
              let fillHL = -1;
              if (fillDrag && rowIdx > fillDrag.startRow && rowIdx <= fillDrag.endRow) fillHL = fillDrag.colIdx;

              return (
                <MemoRow
                  key={order.id} order={order} rowIdx={rowIdx} colWidths={colWidths}
                  isChecked={selectedIds.has(order.id)} activeCol={ac}
                  selMinC={selMinC} selMaxC={selMaxC}
                  showFillHandle={!!showFill} fillHandleCol={fillCol} fillHighlightCol={fillHL}
                  onCellMouseDown={handleCellMouseDown} onCellMouseEnter={handleCellMouseEnter}
                  onCommit={handleCommit} onBlurSave={saveValue}
                  onSelectToggle={onSelectToggle} onFillStart={handleFillStart}
                  onRowClick={onRowClick}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-[var(--text-muted)]">
            {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, sortedOrders.length)} / {sortedOrders.length}건
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(0)}
              disabled={safePage === 0}
              className="px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed"
            >
              ««
            </button>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed"
            >
              «
            </button>
            {Array.from({ length: totalPages }, (_, i) => i)
              .filter(i => i === 0 || i === totalPages - 1 || Math.abs(i - safePage) <= 2)
              .reduce<(number | "...")[]>((acc, i, idx, arr) => {
                if (idx > 0 && i - arr[idx - 1] > 1) acc.push("...");
                acc.push(i);
                return acc;
              }, [])
              .map((item, idx) =>
                item === "..." ? (
                  <span key={`e${idx}`} className="px-1 text-xs text-[var(--text-disabled)]">...</span>
                ) : (
                  <button
                    key={item}
                    onClick={() => setPage(item)}
                    className={`min-w-[28px] px-1.5 py-1 text-xs rounded transition-colors ${
                      item === safePage ? "bg-blue-600/20 text-blue-400 font-medium" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {item + 1}
                  </button>
                )
              )}
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed"
            >
              »
            </button>
            <button
              onClick={() => setPage(totalPages - 1)}
              disabled={safePage >= totalPages - 1}
              className="px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed"
            >
              »»
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(OrderTable);

// ════════════════════════════════════
// Row
// ════════════════════════════════════
interface RowProps {
  order: Order; rowIdx: number; colWidths: Record<string, number>;
  isChecked: boolean; activeCol: number;
  selMinC: number; selMaxC: number;
  showFillHandle: boolean; fillHandleCol: number; fillHighlightCol: number;
  onCellMouseDown: (r: number, c: number) => void;
  onCellMouseEnter: (r: number, c: number) => void;
  onCommit: (r: number, c: number, v: string | null, dir: string) => void;
  onBlurSave: (r: number, c: number, v: string) => void;
  onSelectToggle: (id: string) => void;
  onFillStart: (r: number, c: number, v: unknown) => void;
  onRowClick?: (order: Order) => void;
}

const MemoRow = memo(function Row({
  order, rowIdx, colWidths, isChecked, activeCol,
  selMinC, selMaxC, showFillHandle, fillHandleCol, fillHighlightCol,
  onCellMouseDown, onCellMouseEnter, onCommit, onBlurSave, onSelectToggle, onFillStart,
  onRowClick,
}: RowProps) {
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef("");

  useEffect(() => {
    if (activeCol >= 0) {
      const val = order[COLUMNS[activeCol].key as keyof Order];
      const s = val == null ? "" : String(val);
      setEditValue(s);
      editRef.current = s;
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    }
  }, [activeCol]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
    editRef.current = e.target.value;
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onCommit(rowIdx, activeCol, editRef.current, e.shiftKey ? "up" : "down"); }
    else if (e.key === "Tab") { e.preventDefault(); onCommit(rowIdx, activeCol, editRef.current, e.shiftKey ? "left" : "right"); }
    else if (e.key === "Escape") { e.preventDefault(); onCommit(rowIdx, activeCol, null, "none"); }
  }, [rowIdx, activeCol, onCommit]);

  const onBlur = useCallback(() => {
    if (activeCol >= 0) onBlurSave(rowIdx, activeCol, editRef.current);
  }, [rowIdx, activeCol, onBlurSave]);

  return (
    <tr className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)]">
      <td className="px-2 py-1.5 sticky left-0 bg-[var(--cell-sticky-bg)] z-10">
        <input type="checkbox" checked={isChecked} onChange={() => onSelectToggle(order.id)} className="accent-blue-500" />
      </td>
      {COLUMNS.map((col, ci) => {
        const val = order[col.key as keyof Order];
        const isActive = ci === activeCol;
        const inSel = selMinC >= 0 && ci >= selMinC && ci <= selMaxC;
        const isFillHL = ci === fillHighlightCol;
        const isEditable = EDITABLE_KEYS.has(col.key);

        return (
          <td
            key={col.key}
            className={`relative px-2 py-1.5 overflow-hidden ${col.align === "right" ? "text-right" : "text-left"} ${
              isFillHL ? "bg-blue-500/10 ring-1 ring-blue-500/30 ring-inset" :
              inSel && !isActive ? "bg-blue-500/10" : ""
            }`}
            style={{ width: colWidths[col.key], minWidth: colWidths[col.key], maxWidth: colWidths[col.key] }}
            onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); onCellMouseDown(rowIdx, ci); } }}
            onMouseEnter={() => onCellMouseEnter(rowIdx, ci)}
          >
            {col.key === "delivery_status" ? (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onRowClick?.(order); }}
                className={`inline-block px-2 py-0.5 rounded text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity ${DELIVERY_STATUS_COLORS[String(val)] || "bg-gray-500/20 text-gray-400"}`}
                title="클릭하여 상담내역 열기"
              >
                {String(val || "결제전")}
              </button>
            ) : isActive && isEditable ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onBlur={onBlur}
                placeholder={FORMULA_KEYS.has(col.key) ? "=매출*0.9" : undefined}
                className="w-full bg-[var(--bg-active)] border border-blue-500/50 rounded px-1.5 py-0.5 text-xs text-[var(--text-primary)] outline-none"
              />
            ) : (
              <div className={`text-xs truncate min-h-[22px] leading-[22px] px-1 ${
                isActive ? "ring-2 ring-blue-500/70 rounded bg-blue-500/5" : ""
              }`}>
                {formatCell(col.key, val)}
              </div>
            )}
            {showFillHandle && ci === fillHandleCol && isEditable && (
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
  prev.selMinC === next.selMinC &&
  prev.selMaxC === next.selMaxC &&
  prev.showFillHandle === next.showFillHandle &&
  prev.fillHandleCol === next.fillHandleCol &&
  prev.fillHighlightCol === next.fillHighlightCol
);

// ════════════════════════════════════
// ResizableHeader
// ════════════════════════════════════
function ResizableHeader({ col, width, onResize, hasFilter, filterOpen, onFilterToggle, selectedValues, onFilterChange, allOrders, columnFilters, sort, onSort }: {
  col: Col; width: number; onResize: (w: number) => void;
  hasFilter: boolean; filterOpen: boolean; onFilterToggle: () => void;
  selectedValues: string[]; onFilterChange: (v: string[]) => void; allOrders: Order[];
  columnFilters: Record<string, string[]>;
  sort: SortDir; onSort: (d: SortDir) => void;
}) {
  const sx = useRef(0), sw = useRef(0);
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    sx.current = e.clientX; sw.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => onResize(Math.max(col.minWidth, sw.current + ev.clientX - sx.current));
    const onUp = () => { document.body.style.cursor = ""; document.body.style.userSelect = ""; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  return (
    <th className={`relative px-2 py-2.5 text-xs font-medium text-[var(--text-tertiary)] whitespace-nowrap select-none group ${col.align === "right" ? "text-right" : "text-left"}`} style={{ width, minWidth: width }}>
      <div className="flex items-center gap-1">
        <span className="truncate">{col.label}</span>
        {sort === "asc" && <ArrowUp className="w-3 h-3 text-blue-400 shrink-0" />}
        {sort === "desc" && <ArrowDown className="w-3 h-3 text-blue-400 shrink-0" />}
        <button onClick={onFilterToggle} className={`p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity ${hasFilter ? "opacity-100 text-blue-400" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"}`}>
          <Filter className="w-3 h-3" />
        </button>
      </div>
      {filterOpen && <ColumnFilterDropdown columnKey={col.key} allOrders={allOrders} columnFilters={columnFilters} selectedValues={selectedValues} onChange={onFilterChange} onClose={onFilterToggle} sort={sort} onSort={onSort} />}
      <div onMouseDown={onMouseDown} className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize group/resize z-10 flex items-center justify-center">
        <div className="w-[2px] h-full opacity-0 group-hover/resize:opacity-100 bg-blue-500/60 transition-opacity" />
      </div>
    </th>
  );
}

// ════════════════════════════════════
// ColumnFilterDropdown (확인 버튼 + 정렬)
// ════════════════════════════════════
function ColumnFilterDropdown({ columnKey, allOrders, columnFilters, selectedValues, onChange, onClose, sort, onSort }: {
  columnKey: string; allOrders: Order[]; columnFilters: Record<string, string[]>;
  selectedValues: string[];
  onChange: (v: string[]) => void; onClose: () => void; sort: SortDir; onSort: (d: SortDir) => void;
}) {
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string[]>(selectedValues);
  const ref = useRef<HTMLDivElement>(null);
  const changed = JSON.stringify(pending) !== JSON.stringify(selectedValues);

  // 다른 컬럼 필터가 적용된 데이터에서 유니크 값 추출 (현재 컬럼 필터는 제외)
  const crossFilteredOrders = useMemo(() => {
    const otherFilters = Object.entries(columnFilters).filter(
      ([key, v]) => key !== columnKey && v.length > 0
    );
    if (otherFilters.length === 0) return allOrders;
    return allOrders.filter((order) =>
      otherFilters.every(([key, allowedValues]) => {
        if (allowedValues.length === 1 && allowedValues[0] === "__NONE__") return false;
        const raw = order[key as keyof Order];
        const cellVal = raw === null || raw === undefined || raw === "" ? "(빈 값)" : String(raw);
        return allowedValues.includes(cellVal);
      })
    );
  }, [allOrders, columnFilters, columnKey]);

  const unique = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of crossFilteredOrders) {
      const raw = o[columnKey as keyof Order];
      const v = raw == null || raw === "" ? "(빈 값)" : String(raw);
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
  }, [crossFilteredOrders, columnKey]);

  const filtered = useMemo(() => {
    if (!search) return unique;
    const l = search.toLowerCase();
    return unique.filter(v => v.value.toLowerCase().includes(l));
  }, [unique, search]);

  const allChecked = pending.length === 0;
  const noneChecked = pending.length === 1 && pending[0] === "__NONE__";
  const isChecked = (v: string) => noneChecked ? false : allChecked ? true : pending.includes(v);

  const toggle = useCallback((val: string) => {
    setPending(prev => {
      if (prev.length === 0) return unique.map(v => v.value).filter(v => v !== val);
      if (prev.length === 1 && prev[0] === "__NONE__") return [val];
      if (prev.includes(val)) { const n = prev.filter(v => v !== val); return n.length === 0 ? ["__NONE__"] : n; }
      const n = [...prev, val]; return n.length >= unique.length ? [] : n;
    });
  }, [unique]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute top-full left-0 mt-1 z-50 bg-[var(--table-header-bg)] border border-[var(--border)] rounded-lg shadow-xl min-w-[220px] max-w-[300px]" onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
        <button onClick={() => onSort(sort === "asc" ? null : "asc")} className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${sort === "asc" ? "bg-blue-600/20 text-blue-400" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"}`}>
          <ArrowUp className="w-3 h-3" /> 오름차순
        </button>
        <button onClick={() => onSort(sort === "desc" ? null : "desc")} className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${sort === "desc" ? "bg-blue-600/20 text-blue-400" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"}`}>
          <ArrowDown className="w-3 h-3" /> 내림차순
        </button>
      </div>
      <div className="p-2 border-b border-[var(--border)]">
        <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="검색..."
          className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
          onKeyDown={e => { if (e.key === "Escape") onClose(); }} />
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--border)]">
        <button onClick={() => setPending([])} className={`text-xs ${allChecked ? "text-blue-400 font-medium" : "text-blue-400/60 hover:text-blue-300"}`}>전체 선택</button>
        <span className="text-[var(--text-disabled)]">|</span>
        <button onClick={() => setPending(["__NONE__"])} className={`text-xs ${noneChecked ? "text-[var(--text-secondary)] font-medium" : "text-[var(--text-muted)] hover:text-[var(--text-tertiary)]"}`}>전체 해제</button>
      </div>
      <div className="max-h-[250px] overflow-y-auto py-1">
        {filtered.map(({ value, count }) => (
          <label key={value} className="flex items-center gap-2 px-2 py-1 hover:bg-[var(--bg-hover)] cursor-pointer text-xs" onClick={e => { e.preventDefault(); toggle(value); }}>
            <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${isChecked(value) ? "bg-blue-600 border-blue-600" : "border-[var(--border-strong)]"}`}>
              {isChecked(value) && <Check className="w-2.5 h-2.5 text-white" />}
            </div>
            <span className="text-[var(--text-secondary)] truncate flex-1">{value}</span>
            <span className="text-[var(--text-muted)] shrink-0">{count}</span>
          </label>
        ))}
        {filtered.length === 0 && <p className="px-2 py-2 text-xs text-[var(--text-muted)] text-center">결과 없음</p>}
      </div>
      <div className="flex items-center gap-2 px-2 py-2 border-t border-[var(--border)]">
        <button onClick={() => { onChange(pending); onClose(); }} className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${changed ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-blue-600/50 text-[var(--text-tertiary)] hover:bg-blue-600 hover:text-[var(--text-primary)]"}`}>확인</button>
        <button onClick={onClose} className="flex-1 px-3 py-1.5 rounded text-xs text-[var(--text-tertiary)] bg-[var(--bg-hover)] hover:bg-[var(--bg-active)] transition-colors">취소</button>
      </div>
    </div>
  );
}
