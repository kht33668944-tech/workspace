"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import type { Order } from "@/types/database";
import MemoRow from "./table-row";
import { ResizableHeader } from "./table-header";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  COLUMNS, COL_COUNT, EDITABLE_KEYS, NUMERIC_KEYS,
  norm, processValue,
  type OrderTableProps, type CellPos, type SelRange, type SortDir,
} from "./table-utils";

const PAGE_SIZE = 100;

function OrderTable({
  orders: rawOrders, allOrders, loading, selectedIds, onSelectToggle, onSelectAll, onUpdate,
  onUndo, onDeleteSelected: _onDeleteSelected, onStartBatchUndo, onEndBatchUndo, onRowClick, columnFilters, onColumnFilterChange,
}: OrderTableProps) {
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const o: Record<string, number> = {};
    COLUMNS.forEach(c => { o[c.key] = c.minWidth; });
    return o;
  });
  const [filterOpen, setFilterOpen] = useState<string | null>(null);
  const [activeCell, setActiveCell] = useState<CellPos | null>(null);
  const [editing, setEditing] = useState(false);
  const [initialChar, setInitialChar] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelRange | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [fillDrag, setFillDrag] = useState<{ colIdx: number; startRow: number; endRow: number; value: unknown } | null>(null);
  const [page, setPage] = useState(0);

  const isMobile = useIsMobile();
  // 모바일에서도 전체 컬럼 표시 (가로 스크롤로 접근)
  const visibleColumns = COLUMNS;
  const visibleColCount = visibleColumns.length;

  const tableRef = useRef<HTMLDivElement>(null);
  const [scrolledRight, setScrolledRight] = useState(false);

  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const check = () => setScrolledRight(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
    check();
    el.addEventListener("scroll", check, { passive: true });
    return () => el.removeEventListener("scroll", check);
  }, [isMobile]);

  const dragStartRef = useRef<CellPos | null>(null);
  const isDraggingRef = useRef(false);
  const pendingEditRef = useRef<{ row: number; col: number; value: string } | null>(null);

  const prevLenRef = useRef(rawOrders.length);
  useEffect(() => {
    if (rawOrders.length !== prevLenRef.current) {
      setPage(0);
      prevLenRef.current = rawOrders.length;
    }
  }, [rawOrders.length]);

  const allSelected = rawOrders.length > 0 && selectedIds.size === rawOrders.length;

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

  const totalPages = Math.max(1, Math.ceil(sortedOrders.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const orders = sortedOrders.slice(pageStart, pageStart + PAGE_SIZE);

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

  const handleCommit = useCallback((row: number, col: number, val: string | null, dir: string) => {
    if (val !== null) saveValue(row, col, val);
    pendingEditRef.current = null;
    setEditing(false);
    setInitialChar(null);
    const maxR = orders.length - 1, maxC = COL_COUNT - 1;
    let nr = row, nc = col;
    switch (dir) {
      case "down": nr = Math.min(row + 1, maxR); break;
      case "up": nr = Math.max(row - 1, 0); break;
      case "right": nc = col + 1; if (nc > maxC) { nc = 0; nr = Math.min(row + 1, maxR); } break;
      case "left": nc = col - 1; if (nc < 0) { nc = maxC; nr = Math.max(row - 1, 0); } break;
      case "blur": return;
      case "none": return;
    }
    setActiveCell({ row: nr, col: nc });
    setSelection({ r1: nr, c1: nc, r2: nr, c2: nc });
    setTimeout(() => tableRef.current?.focus(), 0);
  }, [orders.length, saveValue]);

  const handleCellMouseDown = useCallback((row: number, col: number) => {
    if (pendingEditRef.current) {
      const { row: eRow, col: eCol, value } = pendingEditRef.current;
      saveValue(eRow, eCol, value);
      pendingEditRef.current = null;
    }
    setEditing(false);
    setInitialChar(null);
    dragStartRef.current = { row, col };
    isDraggingRef.current = false;
    setSelection({ r1: row, c1: col, r2: row, c2: col });
  }, [saveValue]);

  const handleCellMouseEnter = useCallback((row: number, col: number) => {
    if (!dragStartRef.current) return;
    isDraggingRef.current = true;
    setActiveCell(null);
    setEditing(false);
    setInitialChar(null);
    setSelection(prev => prev ? { r1: prev.r1, c1: prev.c1, r2: row, c2: col } : null);
  }, []);

  useEffect(() => {
    const handler = () => {
      if (!dragStartRef.current) return;
      if (!isDraggingRef.current) {
        setActiveCell({ ...dragStartRef.current });
        setEditing(false);
        setInitialChar(null);
      }
      dragStartRef.current = null;
      isDraggingRef.current = false;
      setTimeout(() => tableRef.current?.focus(), 0);
    };
    document.addEventListener("mouseup", handler);
    return () => document.removeEventListener("mouseup", handler);
  }, []);

  const handleEditValueChange = useCallback((row: number, col: number, value: string) => {
    pendingEditRef.current = { row, col, value };
  }, []);

  // 투명 input에서 타이핑 시작 → 편집 모드로 전환 (IME 조합 상태 유지)
  const handleStartEdit = useCallback((row: number, col: number) => {
    setEditing(true);
    setInitialChar(null);
  }, []);

  const handleCellDoubleClick = useCallback((row: number, col: number) => {
    if (EDITABLE_KEYS.has(COLUMNS[col].key)) {
      setActiveCell({ row, col });
      setSelection({ r1: row, c1: col, r2: row, c2: col });
      setEditing(true);
      setInitialChar(null);
    }
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tableRef.current && !tableRef.current.contains(e.target as Node)) {
        if (pendingEditRef.current) {
          const { row, col, value } = pendingEditRef.current;
          saveValue(row, col, value);
          pendingEditRef.current = null;
        }
        setActiveCell(null);
        setEditing(false);
        setInitialChar(null);
        setSelection(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [saveValue]);

  const handleCopy = useCallback(() => {
    if (!selection && activeCell) {
      const o = orders[activeCell.row];
      if (!o) return;
      const v = o[COLUMNS[activeCell.col].key as keyof Order];
      navigator.clipboard.writeText(v == null ? "" : String(v));
      return;
    }
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
  }, [selection, activeCell, orders]);

  const handlePaste = useCallback(async () => {
    const target = activeCell || (selection ? { row: norm(selection).minR, col: norm(selection).minC } : null);
    if (!target) return;
    try {
      const text = await navigator.clipboard.readText();
      const clipRows = text.split(/\r?\n/).filter(r => r.length > 0);
      const clipData = clipRows.map(r => r.split("\t"));
      const clipRowCount = clipData.length;
      const clipColCount = Math.max(...clipData.map(r => r.length));
      const isSingleValue = clipRowCount === 1 && clipColCount === 1;

      onStartBatchUndo?.();

      if (isSingleValue && selection) {
        const { minR, maxR, minC, maxC } = norm(selection);
        const val = clipData[0][0];
        for (let r = minR; r <= maxR; r++) {
          for (let c = minC; c <= maxC; c++) {
            if (r >= orders.length || c >= COL_COUNT) continue;
            const o = orders[r], k = COLUMNS[c].key;
            if (!EDITABLE_KEYS.has(k)) continue;
            const v = processValue(k, val, o.revenue);
            onUpdate(o.id, { [k]: v });
          }
        }
      } else {
        if (selection) {
          const { minR, maxR, minC, maxC } = norm(selection);
          const selRows = maxR - minR + 1;
          const selCols = maxC - minC + 1;
          for (let ri = 0; ri < selRows; ri++) {
            for (let ci = 0; ci < selCols; ci++) {
              const tR = minR + ri, tC = minC + ci;
              if (tR >= orders.length || tC >= COL_COUNT) continue;
              const clipRow = clipData[ri % clipRowCount];
              const clipVal = clipRow[ci % clipRow.length];
              const o = orders[tR], k = COLUMNS[tC].key;
              if (!EDITABLE_KEYS.has(k)) continue;
              const v = processValue(k, clipVal, o.revenue);
              onUpdate(o.id, { [k]: v });
            }
          }
        } else {
          for (let ri = 0; ri < clipData.length; ri++) {
            for (let ci = 0; ci < clipData[ri].length; ci++) {
              const tR = target.row + ri, tC = target.col + ci;
              if (tR >= orders.length || tC >= COL_COUNT) continue;
              const o = orders[tR], k = COLUMNS[tC].key;
              if (!EDITABLE_KEYS.has(k)) continue;
              const v = processValue(k, clipData[ri][ci], o.revenue);
              onUpdate(o.id, { [k]: v });
            }
          }
        }
      }

      onEndBatchUndo?.();
    } catch { /* clipboard denied */ }
  }, [activeCell, selection, orders, onUpdate, onStartBatchUndo, onEndBatchUndo]);

  const handleTableKeyDown = useCallback((e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key === "z") { e.preventDefault(); onUndo?.(); return; }

    if (editing) return;

    if (ctrl && e.key === "c") { e.preventDefault(); handleCopy(); return; }
    if (ctrl && e.key === "v") { e.preventDefault(); handlePaste(); return; }

    if (activeCell) {
      const { row, col } = activeCell;

      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        let nr = row, nc = col;
        if (e.key === "ArrowDown") nr = Math.min(row + 1, orders.length - 1);
        if (e.key === "ArrowUp") nr = Math.max(row - 1, 0);
        if (e.key === "ArrowRight") nc = Math.min(col + 1, COL_COUNT - 1);
        if (e.key === "ArrowLeft") nc = Math.max(col - 1, 0);
        setActiveCell({ row: nr, col: nc });
        setSelection({ r1: nr, c1: nc, r2: nr, c2: nc });
        return;
      }

      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        if (EDITABLE_KEYS.has(COLUMNS[col].key)) {
          setEditing(true);
          setInitialChar(null);
        }
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        const maxR = orders.length - 1, maxC = COL_COUNT - 1;
        let nr = row, nc = col + (e.shiftKey ? -1 : 1);
        if (nc > maxC) { nc = 0; nr = Math.min(row + 1, maxR); }
        if (nc < 0) { nc = maxC; nr = Math.max(row - 1, 0); }
        setActiveCell({ row: nr, col: nc });
        setSelection({ r1: nr, c1: nc, r2: nr, c2: nc });
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selection) {
          onStartBatchUndo?.();
          const { minR, maxR, minC, maxC } = norm(selection);
          for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) {
            const o = orders[r], k = COLUMNS[c].key;
            if (!o || !EDITABLE_KEYS.has(k)) continue;
            onUpdate(o.id, { [k]: NUMERIC_KEYS.has(k) ? 0 : null });
          }
          onEndBatchUndo?.();
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setActiveCell(null);
        setSelection(null);
        return;
      }

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
      if (ctrl && e.key === "c") { e.preventDefault(); handleCopy(); }
      if (ctrl && e.key === "v") { e.preventDefault(); handlePaste(); }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onStartBatchUndo?.();
        const { minR: r1, maxR: r2, minC: c1, maxC: c2 } = norm(selection);
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
          const o = orders[r], k = COLUMNS[c].key;
          if (!o || !EDITABLE_KEYS.has(k)) continue;
          onUpdate(o.id, { [k]: NUMERIC_KEYS.has(k) ? 0 : null });
        }
        onEndBatchUndo?.();
      }
    }
  }, [activeCell, editing, selection, orders, onUndo, onUpdate, handleCopy, handlePaste, onStartBatchUndo, onEndBatchUndo]);

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
  const editingRow = editing && activeCell ? activeCell.row : -1;
  const editingCol = editing && activeCell ? activeCell.col : -1;

  return (
    <div className="space-y-2">
      <div className="relative">
      {!scrolledRight && (
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-12 z-10 rounded-r-xl bg-gradient-to-l from-[var(--bg-main)] to-transparent" />
      )}
      <div
        ref={tableRef}
        className="rounded-xl border border-[var(--border)] overflow-auto focus:outline-none"
        style={{
          maxHeight: isMobile ? "calc(100vh - 220px)" : "calc(100vh - 300px)",
          minHeight: isMobile ? "280px" : "420px",
        }}
        tabIndex={isMobile ? -1 : 0}
        onKeyDown={isMobile ? undefined : handleTableKeyDown}
      >
        <table className="text-sm border-collapse w-max min-w-full">
          <thead className="bg-[var(--table-header-bg)] sticky top-0 z-20">
            <tr>
              <th className={`px-2 py-2.5 sticky left-0 bg-[var(--table-header-bg)] z-30 border-r border-[var(--border-subtle)] ${isMobile ? "w-11" : "w-10"}`}>
                <input type="checkbox" checked={allSelected} onChange={onSelectAll} className={`accent-blue-500 ${isMobile ? "w-5 h-5" : ""}`} />
              </th>
              {visibleColumns.map(col => (
                <ResizableHeader
                  key={col.key} col={col} width={isMobile ? 0 : colWidths[col.key]}
                  onResize={isMobile ? () => {} : (w => setColWidths(p => ({ ...p, [col.key]: w })))}
                  hasFilter={!!columnFilters[col.key]?.length}
                  filterOpen={filterOpen === col.key}
                  onFilterToggle={() => setFilterOpen(filterOpen === col.key ? null : col.key)}
                  selectedValues={columnFilters[col.key] || []}
                  onFilterChange={v => onColumnFilterChange(col.key, v)}
                  allOrders={allOrders}
                  columnFilters={columnFilters}
                  sort={sort?.key === col.key ? sort.dir : null}
                  onSort={dir => handleSort(col.key, dir)}
                  isMobile={isMobile}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((order, rowIdx) => {
              const ac = activeCell?.row === rowIdx ? activeCell.col : -1;
              const ec = editingRow === rowIdx ? editingCol : -1;
              let selMinC = -1, selMaxC = -1;
              if (sn && rowIdx >= sn.minR && rowIdx <= sn.maxR) { selMinC = sn.minC; selMaxC = sn.maxC; }
              const showFill = sn ? rowIdx === sn.maxR : activeCell?.row === rowIdx;
              const fillCol = sn ? sn.maxC : (activeCell?.row === rowIdx ? activeCell.col : -1);
              let fillHL = -1;
              if (fillDrag && rowIdx > fillDrag.startRow && rowIdx <= fillDrag.endRow) fillHL = fillDrag.colIdx;

              return (
                <MemoRow
                  key={order.id} order={order} rowIdx={rowIdx} colWidths={colWidths}
                  isChecked={selectedIds.has(order.id)} activeCol={isMobile ? -1 : ac} editingCol={isMobile ? -1 : ec}
                  initialChar={editingRow === rowIdx && !isMobile ? initialChar : null}
                  selMinC={isMobile ? -1 : selMinC} selMaxC={isMobile ? -1 : selMaxC}
                  showFillHandle={!isMobile && !!showFill} fillHandleCol={isMobile ? -1 : fillCol} fillHighlightCol={isMobile ? -1 : fillHL}
                  onCellMouseDown={isMobile ? (() => {}) : handleCellMouseDown} onCellMouseEnter={isMobile ? (() => {}) : handleCellMouseEnter}
                  onCellDoubleClick={isMobile ? (() => {}) : handleCellDoubleClick}
                  onCommit={handleCommit} onBlurSave={saveValue}
                  onEditValueChange={handleEditValueChange}
                  onSelectToggle={onSelectToggle} onFillStart={handleFillStart}
                  onStartEdit={handleStartEdit}
                  onRowClick={onRowClick}
                  isMobile={isMobile}
                  visibleColumns={visibleColumns}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      </div>

      {/* 건수 표시 + 페이지네이션 */}
      <div className="flex items-center justify-between px-1 min-h-[36px]">
        <span className="text-xs text-[var(--text-muted)]">
          {sortedOrders.length > 0
            ? `${pageStart + 1}-${Math.min(pageStart + PAGE_SIZE, sortedOrders.length)} / ${sortedOrders.length}건`
            : "0건"}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(0)} disabled={safePage === 0} className="min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed">««</button>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed">«</button>
            {Array.from({ length: totalPages }, (_, i) => i)
              .filter(i => i === 0 || i === totalPages - 1 || Math.abs(i - safePage) <= (isMobile ? 1 : 2))
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
                    className={`min-w-[44px] min-h-[44px] md:min-w-[28px] md:min-h-0 px-1.5 py-1 text-xs rounded transition-colors ${
                      item === safePage ? "bg-blue-600/20 text-blue-400 font-medium" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {item + 1}
                  </button>
                )
              )}
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1} className="min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed">»</button>
            <button onClick={() => setPage(totalPages - 1)} disabled={safePage >= totalPages - 1} className="min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 px-2 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed">»»</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(OrderTable);
