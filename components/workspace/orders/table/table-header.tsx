"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { Filter, Check, ArrowUp, ArrowDown } from "lucide-react";
import type { Order } from "@/types/database";
import type { Col, SortDir } from "./table-utils";

// ════════════════════════════════════
// ResizableHeader
// ════════════════════════════════════
export const ResizableHeader = memo(function ResizableHeader({ col, width, onResize, hasFilter, filterOpen, onFilterToggle, selectedValues, onFilterChange, allOrders, columnFilters, sort, onSort, isMobile }: {
  col: Col; width: number; onResize: (w: number) => void;
  hasFilter: boolean; filterOpen: boolean; onFilterToggle: () => void;
  selectedValues: string[]; onFilterChange: (v: string[]) => void; allOrders: Order[];
  columnFilters: Record<string, string[]>;
  sort: SortDir; onSort: (d: SortDir) => void;
  isMobile?: boolean;
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
    <th className={`relative px-2 py-2.5 text-xs font-medium text-[var(--text-tertiary)] whitespace-nowrap select-none group border-r border-[var(--border-subtle)] ${col.align === "right" ? "text-right" : "text-left"}`} style={isMobile ? undefined : { width, minWidth: width }}>
      <div className="flex items-center gap-1">
        <span className="truncate">{col.label}</span>
        {sort === "asc" && <ArrowUp className="w-3 h-3 text-blue-400 shrink-0" />}
        {sort === "desc" && <ArrowDown className="w-3 h-3 text-blue-400 shrink-0" />}
        <button onClick={onFilterToggle} className={`p-0.5 rounded flex items-center gap-0.5 ${isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity ${hasFilter ? "opacity-100 text-blue-400" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"}`}>
          <Filter className="w-3 h-3" />
          {hasFilter && selectedValues.length > 0 && selectedValues[0] !== "__NONE__" && (
            <span className="text-[9px] font-bold leading-none">{selectedValues.length}</span>
          )}
        </button>
      </div>
      {filterOpen && <ColumnFilterDropdown columnKey={col.key} allOrders={allOrders} columnFilters={columnFilters} selectedValues={selectedValues} onChange={onFilterChange} onClose={onFilterToggle} sort={sort} onSort={onSort} />}
      {!isMobile && (
        <div onMouseDown={onMouseDown} className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize group/resize z-10 flex items-center justify-center">
          <div className="w-[2px] h-full opacity-0 group-hover/resize:opacity-100 bg-blue-500/60 transition-opacity" />
        </div>
      )}
    </th>
  );
});

// ════════════════════════════════════
// ColumnFilterDropdown
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
      <div className="max-h-[200px] overflow-y-auto py-1">
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
