"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import type { Product } from "@/types/database";
import MemoRow from "./table-row";
import { ResizableHeader } from "./table-header";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  COLUMNS, COL_COUNT, EDITABLE_KEYS, NUMERIC_KEYS,
  norm, processValue,
  PLATFORM_FIXED_KEY_MAP, parseFixedPriceInput, getComputedValue,
  type ProductTableProps, type CellPos, type SelRange, type SortDir,
} from "./table-utils";
import { REGISTRATION_STATUSES, REGISTRATION_STATUS_COLORS } from "@/lib/constants";

const PAGE_SIZE = 100;

function ProductTable({
  products: rawProducts, allProducts, loading, selectedIds, onSelectToggle, onSelectAll, onUpdate,
  onUndo, onStartBatchUndo, onEndBatchUndo, columnFilters, onColumnFilterChange,
  rateMap, categories, priceChanges, priceChangeFilter, onPriceChangeFilterChange,
  onBulkMarginApply,
}: ProductTableProps) {
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
  const visibleColumns = COLUMNS;

  const tableRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<CellPos | null>(null);
  const isDraggingRef = useRef(false);
  const pendingEditRef = useRef<{ row: number; col: number; value: string } | null>(null);

  const prevLenRef = useRef(rawProducts.length);
  useEffect(() => {
    if (rawProducts.length !== prevLenRef.current) {
      setPage(0);
      prevLenRef.current = rawProducts.length;
    }
  }, [rawProducts.length]);

  const allSelected = rawProducts.length > 0 && selectedIds.size === rawProducts.length;

  const sortedProducts = useMemo(() => {
    if (!sort?.dir) return rawProducts;
    const s = [...rawProducts];
    s.sort((a, b) => {
      const av = a[sort.key as keyof Product], bv = b[sort.key as keyof Product];
      if (av == null) return 1; if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return sort.dir === "asc" ? av - bv : bv - av;
      const c = String(av).localeCompare(String(bv), "ko");
      return sort.dir === "asc" ? c : -c;
    });
    return s;
  }, [rawProducts, sort]);

  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * PAGE_SIZE;
  const products = sortedProducts.slice(pageStart, pageStart + PAGE_SIZE);

  const saveValue = useCallback((row: number, col: number, raw: string) => {
    const product = products[row];
    if (!product) return;
    const key = COLUMNS[col]?.key;
    if (!key || !EDITABLE_KEYS.has(key)) return;

    // 플랫폼 판매가: fixed_price_* 컬럼으로 라우팅
    const fixedKey = PLATFORM_FIXED_KEY_MAP[key];
    if (fixedKey) {
      const newVal = parseFixedPriceInput(raw);
      const currentFixed = (product[fixedKey] as number | null) ?? null;
      if (currentFixed === null) {
        // 잠금 해제 상태 — 자동계산값과 동일한 입력이면 저장하지 않음 (실수로 잠기는 것 방지)
        const displayVal = getComputedValue(product, key, rateMap, priceChanges);
        if (newVal !== null && newVal !== displayVal) {
          onUpdate(product.id, { [fixedKey]: newVal });
        }
      } else if (newVal !== currentFixed) {
        onUpdate(product.id, { [fixedKey]: newVal });
      }
      return;
    }

    const oldVal = product[key as keyof Product];
    const newVal = processValue(key, raw);
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      onUpdate(product.id, { [key]: newVal });
    }
  }, [products, onUpdate, rateMap, priceChanges]);

  /** 플랫폼 판매가 고정값 해제 (자동계산으로 복귀) */
  const handleUnlockFixedPrice = useCallback((productId: string, priceKey: string) => {
    const fixedKey = PLATFORM_FIXED_KEY_MAP[priceKey];
    if (!fixedKey) return;
    onUpdate(productId, { [fixedKey]: null });
  }, [onUpdate]);

  const handleCommit = useCallback((row: number, col: number, val: string | null, dir: string) => {
    if (val !== null) saveValue(row, col, val);
    pendingEditRef.current = null;
    setEditing(false);
    setInitialChar(null);
    const maxR = products.length - 1, maxC = COL_COUNT - 1;
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
  }, [products.length, saveValue]);

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
      const target = e.target as Node;
      // 테이블 내부 클릭이면 무시
      if (tableRef.current && tableRef.current.contains(target)) return;
      // fixed 드롭다운(등록상태 등) 클릭이면 무시
      if ((target as HTMLElement).closest?.("[data-status-dropdown]")) return;
      if (pendingEditRef.current) {
        const { row, col, value } = pendingEditRef.current;
        saveValue(row, col, value);
        pendingEditRef.current = null;
      }
      setActiveCell(null);
      setEditing(false);
      setInitialChar(null);
      setSelection(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [saveValue]);

  const handleCopy = useCallback(() => {
    if (!selection && activeCell) {
      const p = products[activeCell.row];
      if (!p) return;
      const v = p[COLUMNS[activeCell.col].key as keyof Product];
      navigator.clipboard.writeText(v == null ? "" : String(v));
      return;
    }
    if (!selection) return;
    const { minR, maxR, minC, maxC } = norm(selection);
    const lines: string[] = [];
    for (let r = minR; r <= maxR; r++) {
      const p = products[r]; if (!p) continue;
      const cells: string[] = [];
      for (let c = minC; c <= maxC; c++) {
        const v = p[COLUMNS[c].key as keyof Product];
        cells.push(v == null ? "" : String(v));
      }
      lines.push(cells.join("\t"));
    }
    navigator.clipboard.writeText(lines.join("\n"));
  }, [selection, activeCell, products]);

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

      const pasteCell = (p: Product, k: string, rawVal: string) => {
        const fixedKey = PLATFORM_FIXED_KEY_MAP[k];
        if (fixedKey) {
          onUpdate(p.id, { [fixedKey]: parseFixedPriceInput(rawVal) });
          return;
        }
        onUpdate(p.id, { [k]: processValue(k, rawVal) });
      };

      if (isSingleValue && selection) {
        const { minR, maxR, minC, maxC } = norm(selection);
        const val = clipData[0][0];
        for (let r = minR; r <= maxR; r++) {
          for (let c = minC; c <= maxC; c++) {
            if (r >= products.length || c >= COL_COUNT) continue;
            const p = products[r], k = COLUMNS[c].key;
            if (!EDITABLE_KEYS.has(k)) continue;
            pasteCell(p, k, val);
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
              if (tR >= products.length || tC >= COL_COUNT) continue;
              const clipRow = clipData[ri % clipRowCount];
              const clipVal = clipRow[ci % clipRow.length];
              const p = products[tR], k = COLUMNS[tC].key;
              if (!EDITABLE_KEYS.has(k)) continue;
              pasteCell(p, k, clipVal);
            }
          }
        } else {
          for (let ri = 0; ri < clipData.length; ri++) {
            for (let ci = 0; ci < clipData[ri].length; ci++) {
              const tR = target.row + ri, tC = target.col + ci;
              if (tR >= products.length || tC >= COL_COUNT) continue;
              const p = products[tR], k = COLUMNS[tC].key;
              if (!EDITABLE_KEYS.has(k)) continue;
              pasteCell(p, k, clipData[ri][ci]);
            }
          }
        }
      }

      onEndBatchUndo?.();
    } catch { /* clipboard denied */ }
  }, [activeCell, selection, products, onUpdate, onStartBatchUndo, onEndBatchUndo]);

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
        if (e.key === "ArrowDown") nr = Math.min(row + 1, products.length - 1);
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
        const maxR = products.length - 1, maxC = COL_COUNT - 1;
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
            const p = products[r], k = COLUMNS[c].key;
            if (!p || !EDITABLE_KEYS.has(k)) continue;
            const fixedKey = PLATFORM_FIXED_KEY_MAP[k];
            if (fixedKey) onUpdate(p.id, { [fixedKey]: null });
            else onUpdate(p.id, { [k]: NUMERIC_KEYS.has(k) ? 0 : "" });
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

      if (e.key.length === 1 && !ctrl && !e.altKey && EDITABLE_KEYS.has(COLUMNS[col].key)) {
        e.preventDefault();
        setEditing(true);
        setInitialChar(e.key);
        return;
      }

      return;
    }

    if (!activeCell && selection) {
      const { minR, minC } = norm(selection);
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        let r = minR, c = minC;
        if (e.key === "ArrowDown") r = Math.min(r + 1, products.length - 1);
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
          const p = products[r], k = COLUMNS[c].key;
          if (!p || !EDITABLE_KEYS.has(k)) continue;
          onUpdate(p.id, { [k]: NUMERIC_KEYS.has(k) ? 0 : "" });
        }
        onEndBatchUndo?.();
      }
      if (e.key.length === 1 && !ctrl && !e.altKey) {
        e.preventDefault();
        setActiveCell({ row: minR, col: minC });
        if (EDITABLE_KEYS.has(COLUMNS[minC].key)) {
          setEditing(true);
          setInitialChar(e.key);
        }
      }
    }
  }, [activeCell, editing, selection, products, onUndo, onUpdate, handleCopy, handlePaste, onStartBatchUndo, onEndBatchUndo]);

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
        const fixedKey = PLATFORM_FIXED_KEY_MAP[colKey];
        for (let i = fillDrag.startRow + 1; i <= fillDrag.endRow; i++) {
          const p = products[i];
          if (!p || !EDITABLE_KEYS.has(colKey)) continue;
          if (fixedKey) {
            const parsed = typeof fillDrag.value === "number"
              ? (fillDrag.value > 0 ? Math.round(fillDrag.value) : null)
              : parseFixedPriceInput(String(fillDrag.value ?? ""));
            onUpdate(p.id, { [fixedKey]: parsed });
          } else {
            onUpdate(p.id, { [colKey]: fillDrag.value });
          }
        }
      }
      setFillDrag(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [fillDrag, products, onUpdate]);

  const handleFillStart = useCallback((row: number, col: number, value: unknown) => {
    setFillDrag({ colIdx: col, startRow: row, endRow: row, value });
  }, []);

  const handleSort = useCallback((key: string, dir: SortDir) => {
    setSort(dir ? { key, dir } : null);
  }, []);

  const handleStatusChange = useCallback((id: string, status: string) => {
    onUpdate(id, { registration_status: status });
  }, [onUpdate]);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-[var(--text-muted)] border-t-[var(--text-primary)] rounded-full animate-spin" />
    </div>
  );
  if (sortedProducts.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-[var(--text-muted)]">
      <p className="text-sm">상품 데이터가 없습니다</p>
      <p className="text-xs mt-1">상품을 추가하여 가격을 관리해보세요</p>
    </div>
  );

  const sn = selection ? norm(selection) : null;
  const editingRow = editing && activeCell ? activeCell.row : -1;
  const editingCol = editing && activeCell ? activeCell.col : -1;

  return (
    <div className="space-y-2">
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
              <th className="px-2 py-2.5 text-xs font-medium text-(--text-tertiary) whitespace-nowrap border-r border-(--border-subtle) text-left sticky left-[40px] bg-[var(--table-header-bg)] z-30 relative" style={{ width: 72, minWidth: 72 }}>
                <button
                  onClick={() => setFilterOpen(filterOpen === "__reg_status__" ? null : "__reg_status__")}
                  className={`hover:text-[var(--text-primary)] transition-colors ${columnFilters.registration_status?.length ? "text-blue-400" : ""}`}
                >
                  등록상태 {columnFilters.registration_status?.length ? "●" : ""}
                </button>
                {filterOpen === "__reg_status__" && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(null)} />
                    <div className="absolute left-0 top-full mt-0.5 z-50 w-36 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden">
                      {REGISTRATION_STATUSES.map(s => {
                        const active = columnFilters.registration_status?.includes(s);
                        return (
                          <button
                            key={s}
                            onClick={() => {
                              const cur = columnFilters.registration_status || [];
                              const next = active ? cur.filter(v => v !== s) : [...cur, s];
                              onColumnFilterChange("registration_status", next);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--bg-hover)] transition-colors"
                          >
                            <input type="checkbox" checked={!!active} readOnly className="accent-blue-500 pointer-events-none" />
                            <span className={`inline-block px-1.5 py-0.5 rounded font-medium ${REGISTRATION_STATUS_COLORS[s]}`}>{s}</span>
                          </button>
                        );
                      })}
                      {columnFilters.registration_status?.length ? (
                        <button
                          onClick={() => onColumnFilterChange("registration_status", [])}
                          className="w-full px-3 py-2 text-xs text-red-400 hover:bg-[var(--bg-hover)] transition-colors border-t border-[var(--border)]"
                        >
                          필터 초기화
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </th>
              {visibleColumns.map(col => (
                <ResizableHeader
                  key={col.key} col={col} width={isMobile ? 0 : colWidths[col.key]}
                  stickyLeft={col.key === "product_name" ? 112 : undefined}
                  onResize={isMobile ? () => {} : (w => setColWidths(p => ({ ...p, [col.key]: w })))}
                  hasFilter={col.key === "price_change" ? !!priceChangeFilter : !!columnFilters[col.key]?.length}
                  filterOpen={filterOpen === col.key}
                  onFilterToggle={() => setFilterOpen(filterOpen === col.key ? null : col.key)}
                  selectedValues={columnFilters[col.key] || []}
                  onFilterChange={v => onColumnFilterChange(col.key, v)}
                  allProducts={allProducts}
                  columnFilters={columnFilters}
                  sort={sort?.key === col.key ? sort.dir : null}
                  onSort={dir => handleSort(col.key, dir)}
                  isMobile={isMobile}
                  priceChangeFilter={col.key === "price_change" ? priceChangeFilter : undefined}
                  onPriceChangeFilterChange={col.key === "price_change" ? onPriceChangeFilterChange : undefined}
                  selectedCount={selectedIds.size}
                  onBulkMarginApply={col.key === "margin_rate" ? onBulkMarginApply : undefined}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((product, rowIdx) => {
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
                  key={product.id} product={product} rowIdx={rowIdx} colWidths={colWidths}
                  isChecked={selectedIds.has(product.id)} activeCol={isMobile ? -1 : ac} editingCol={isMobile ? -1 : ec}
                  initialChar={editingRow === rowIdx && !isMobile ? initialChar : null}
                  selMinC={isMobile ? -1 : selMinC} selMaxC={isMobile ? -1 : selMaxC}
                  showFillHandle={!isMobile && !!showFill} fillHandleCol={isMobile ? -1 : fillCol} fillHighlightCol={isMobile ? -1 : fillHL}
                  onCellMouseDown={isMobile ? (() => {}) : handleCellMouseDown} onCellMouseEnter={isMobile ? (() => {}) : handleCellMouseEnter}
                  onCellDoubleClick={isMobile ? (() => {}) : handleCellDoubleClick}
                  onCommit={handleCommit} onBlurSave={saveValue}
                  onEditValueChange={handleEditValueChange}
                  onSelectToggle={onSelectToggle} onFillStart={handleFillStart}
                  onStatusChange={handleStatusChange}
                  onUnlockFixedPrice={handleUnlockFixedPrice}
                  isMobile={isMobile}
                  visibleColumns={visibleColumns}
                  rateMap={rateMap}
                  categories={categories}
                  priceChanges={priceChanges}
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
            {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, sortedProducts.length)} / {sortedProducts.length}건
          </span>
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
        </div>
      )}
    </div>
  );
}

export default memo(ProductTable);
