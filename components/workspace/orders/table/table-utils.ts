import React from "react";
import { MARKETPLACES, DELIVERY_STATUS_COLORS } from "@/lib/constants";
import type { Order } from "@/types/database";

// 안전한 사칙연산 파서 (Function/eval 대체)
function safeMathEval(expr: string): number {
  const tokens: string[] = [];
  const re = /(\d+(?:\.\d+)?)|([+\-*/()])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) tokens.push(m[0]);

  let pos = 0;
  function parseExpr(): number {
    let left = parseTerm();
    while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++];
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function parseTerm(): number {
    let left = parseFactor();
    while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++];
      const right = parseFactor();
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }
  function parseFactor(): number {
    if (tokens[pos] === "(") {
      pos++;
      const val = parseExpr();
      if (tokens[pos] === ")") pos++;
      return val;
    }
    if (tokens[pos] === "-") {
      pos++;
      return -parseFactor();
    }
    return parseFloat(tokens[pos++]) || 0;
  }
  return parseExpr();
}

// margin 제외 모든 컬럼 편집 가능 (address 포함)
export const EDITABLE_KEYS = new Set([
  "bundle_no", "order_date", "marketplace", "recipient_name", "product_name",
  "quantity", "recipient_phone", "orderer_phone", "postal_code", "address", "address_detail",
  "delivery_memo", "revenue", "settlement", "cost", "payment_method",
  "purchase_id", "purchase_source", "purchase_url", "purchase_order_no", "courier", "tracking_no", "delivery_status", "memo",
]);
export const NUMERIC_KEYS = new Set(["quantity", "revenue", "settlement", "cost"]);
export const FORMULA_KEYS = new Set(["settlement"]);

export interface Col { key: string; label: string; minWidth: number; align?: "right"; }
export const COLUMNS: Col[] = [
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
  { key: "purchase_source", label: "구매처", minWidth: 80 },
  { key: "purchase_id", label: "구매아이디", minWidth: 110 },
  { key: "purchase_order_no", label: "주문번호", minWidth: 120 },
  { key: "courier", label: "택배사", minWidth: 85 },
  { key: "tracking_no", label: "운송장", minWidth: 130 },
  { key: "purchase_url", label: "최저가링크", minWidth: 130 },
];
export const COL_COUNT = COLUMNS.length;

export const MOBILE_VISIBLE_KEYS = new Set([
  "delivery_status",
  "recipient_name",
  "product_name",
  "quantity",
  "tracking_no",
]);
export const MOBILE_COLUMNS = COLUMNS.filter(c => MOBILE_VISIBLE_KEYS.has(c.key));

export type SortDir = "asc" | "desc" | null;
export interface CellPos { row: number; col: number }
export interface SelRange { r1: number; c1: number; r2: number; c2: number }

export function norm(s: SelRange) {
  return { minR: Math.min(s.r1, s.r2), maxR: Math.max(s.r1, s.r2), minC: Math.min(s.c1, s.c2), maxC: Math.max(s.c1, s.c2) };
}

export function processValue(colKey: string, raw: string, revenue?: number): unknown {
  const t = raw.trim();
  if (NUMERIC_KEYS.has(colKey)) {
    if (FORMULA_KEYS.has(colKey) && t.startsWith("=") && revenue !== undefined) {
      const expr = t.slice(1).replace(/매출/g, String(revenue)).replace(/revenue/gi, String(revenue));
      if (/^[\d+\-*/().%\s]+$/.test(expr)) {
        try { const r = Math.round(safeMathEval(expr)); if (!isNaN(r)) return r; } catch { /* */ }
      }
      return 0;
    }
    const n = parseInt(t.replace(/,/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }
  return t || null;
}

export function formatCell(key: string, val: unknown): React.ReactNode {
  if (val == null || val === "") return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");
  if (key === "delivery_status") {
    const color = DELIVERY_STATUS_COLORS[String(val)] || "bg-gray-500/20 text-gray-400";
    return React.createElement("span", { className: `inline-block px-2 py-0.5 rounded text-xs font-medium ${color}` }, String(val));
  }
  if (key === "margin") {
    const n = Number(val);
    return React.createElement("span", { className: `text-xs font-medium ${n > 0 ? "text-green-400" : n < 0 ? "text-red-400" : "text-[var(--text-secondary)]"}` }, n.toLocaleString());
  }
  if (key === "order_date") {
    const s = String(val);
    return React.createElement("span", { className: "text-[var(--text-secondary)] text-xs" }, s.length >= 16 ? s.slice(0, 16).replace("T", " ") : s.slice(0, 10));
  }
  if (key === "marketplace") {
    const mp = MARKETPLACES[String(val)];
    if (mp) return React.createElement("span", { className: `inline-block px-2 py-0.5 rounded text-xs font-medium ${mp.color}` }, mp.label);
  }
  if (key === "purchase_url") {
    const url = String(val);
    return React.createElement("a", {
      href: url, target: "_blank", rel: "noopener noreferrer",
      className: "text-blue-400 text-xs truncate block max-w-full hover:underline",
      title: url, onClick: (e: React.MouseEvent) => e.stopPropagation()
    }, url.replace(/^https?:\/\//, "").slice(0, 30) + "...");
  }
  if (NUMERIC_KEYS.has(key)) return React.createElement("span", { className: "text-[var(--text-secondary)] text-xs" }, Number(val).toLocaleString());
  return React.createElement("span", { title: String(val), className: "text-[var(--text-secondary)] text-xs truncate block max-w-full" }, String(val));
}

export interface OrderTableProps {
  orders: Order[];
  allOrders: Order[];
  loading: boolean;
  selectedIds: Set<string>;
  onSelectToggle: (id: string) => void;
  onSelectAll: () => void;
  onUpdate: (id: string, updates: Record<string, unknown>) => void;
  onUndo?: () => void;
  onDeleteSelected?: () => void;
  onStartBatchUndo?: () => void;
  onEndBatchUndo?: () => void;
  onRowClick?: (order: Order) => void;
  columnFilters: Record<string, string[]>;
  onColumnFilterChange: (key: string, values: string[]) => void;
}
