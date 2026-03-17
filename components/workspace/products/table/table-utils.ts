import React from "react";
import type { Product, CommissionPlatform } from "@/types/database";
import { calcSettlementPrice, calcNetMargin, calcPlatformPrice } from "@/lib/product-calculations";

export const EDITABLE_KEYS = new Set([
  "product_name", "lowest_price",
  "margin_rate", "category", "purchase_url", "memo",
]);
export const NUMERIC_KEYS = new Set(["lowest_price", "margin_rate"]);
// 자동 계산 컬럼 (편집 불가)
export const COMPUTED_KEYS = new Set([
  "name_length", "net_margin", "settlement_price",
  "price_smartstore", "price_esm", "price_coupang", "price_myeolchi",
]);

export interface Col { key: string; label: string; minWidth: number; align?: "right"; }
export const COLUMNS: Col[] = [
  { key: "product_name", label: "상품명", minWidth: 250 },
  { key: "name_length", label: "글자수", minWidth: 55, align: "right" },
  { key: "lowest_price", label: "최저가(원)", minWidth: 90, align: "right" },
  { key: "margin_rate", label: "순마진율(%)", minWidth: 85, align: "right" },
  { key: "net_margin", label: "순마진(원)", minWidth: 85, align: "right" },
  { key: "settlement_price", label: "정산가(원)", minWidth: 90, align: "right" },
  { key: "category", label: "카테고리", minWidth: 120 },
  { key: "price_smartstore", label: "스마트스토어", minWidth: 95, align: "right" },
  { key: "price_esm", label: "ESM 11번가", minWidth: 90, align: "right" },
  { key: "price_coupang", label: "쿠팡", minWidth: 80, align: "right" },
  { key: "price_myeolchi", label: "멸치쇼핑", minWidth: 80, align: "right" },
  { key: "purchase_url", label: "상품 구매 URL", minWidth: 150 },
  { key: "memo", label: "메모", minWidth: 100 },
];
export const COL_COUNT = COLUMNS.length;

export const MOBILE_VISIBLE_KEYS = new Set([
  "product_name", "lowest_price", "margin_rate", "category",
]);
export const MOBILE_COLUMNS = COLUMNS.filter(c => MOBILE_VISIBLE_KEYS.has(c.key));

export type SortDir = "asc" | "desc" | null;
export interface CellPos { row: number; col: number }
export interface SelRange { r1: number; c1: number; r2: number; c2: number }

export function norm(s: SelRange) {
  return { minR: Math.min(s.r1, s.r2), maxR: Math.max(s.r1, s.r2), minC: Math.min(s.c1, s.c2), maxC: Math.max(s.c1, s.c2) };
}

export function processValue(colKey: string, raw: string): unknown {
  const t = raw.trim();
  if (NUMERIC_KEYS.has(colKey)) {
    if (colKey === "margin_rate") {
      const n = parseFloat(t.replace(/,/g, ""));
      return isNaN(n) ? 0 : n;
    }
    const n = parseInt(t.replace(/,/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }
  return t || "";
}

/** 상품 행의 모든 계산 필드 값을 한번에 계산 (캐시) */
const computedCache = new WeakMap<Product, { rateMap: Record<string, Record<CommissionPlatform, number>>; values: Record<string, number> }>();

function getComputedAll(
  product: Product,
  rateMap: Record<string, Record<CommissionPlatform, number>>
): Record<string, number> {
  const cached = computedCache.get(product);
  if (cached && cached.rateMap === rateMap) return cached.values;

  const { lowest_price, margin_rate, product_name, category } = product;
  const sp = calcSettlementPrice(lowest_price, margin_rate);
  const catRates = rateMap[category];

  const values: Record<string, number> = {
    name_length: product_name.length,
    net_margin: calcNetMargin(lowest_price, margin_rate),
    settlement_price: sp,
    price_smartstore: catRates?.smartstore ? calcPlatformPrice(sp, catRates.smartstore) : 0,
    price_esm: catRates?.esm ? calcPlatformPrice(sp, catRates.esm) : 0,
    price_coupang: catRates?.coupang ? calcPlatformPrice(sp, catRates.coupang) : 0,
    price_myeolchi: catRates?.myeolchi ? calcPlatformPrice(sp, catRates.myeolchi) : 0,
  };

  computedCache.set(product, { rateMap, values });
  return values;
}

/** 상품 행의 계산 필드 값을 가져오기 */
export function getComputedValue(
  product: Product,
  key: string,
  rateMap: Record<string, Record<CommissionPlatform, number>>
): number {
  return getComputedAll(product, rateMap)[key] ?? 0;
}

export function formatCell(
  key: string,
  val: unknown,
  product?: Product,
  rateMap?: Record<string, Record<CommissionPlatform, number>>
): React.ReactNode {
  // 계산 필드
  if (COMPUTED_KEYS.has(key) && product && rateMap) {
    const computed = getComputedValue(product, key, rateMap);
    if (key === "net_margin") {
      return React.createElement("span", {
        className: `text-xs font-medium ${computed > 0 ? "text-green-400" : computed < 0 ? "text-red-400" : "text-[var(--text-secondary)]"}`,
      }, computed ? computed.toLocaleString() : "-");
    }
    if (key === "name_length") {
      return React.createElement("span", { className: "text-[var(--text-muted)] text-xs" }, computed || "-");
    }
    if (computed === 0) {
      return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");
    }
    return React.createElement("span", { className: "text-[var(--text-secondary)] text-xs" }, computed.toLocaleString());
  }

  if (val == null || val === "") return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");

  if (key === "margin_rate") {
    const n = Number(val);
    return React.createElement("span", {
      className: `text-xs font-medium ${n > 0 ? "text-blue-400" : "text-[var(--text-secondary)]"}`,
    }, n ? `${n}%` : "-");
  }

  if (key === "purchase_url") {
    const url = String(val);
    if (!url) return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");
    return React.createElement("a", {
      href: url, target: "_blank", rel: "noopener noreferrer",
      className: "text-blue-400 text-xs truncate block max-w-full hover:underline",
      title: url, onClick: (e: React.MouseEvent) => e.stopPropagation(),
    }, url.replace(/^https?:\/\//, "").slice(0, 35) + (url.length > 45 ? "..." : ""));
  }

  if (key === "category") {
    return React.createElement("span", {
      className: "inline-block px-2 py-0.5 rounded text-xs font-medium bg-purple-500/20 text-purple-400",
    }, String(val));
  }

  if (NUMERIC_KEYS.has(key)) {
    return React.createElement("span", { className: "text-[var(--text-secondary)] text-xs" }, Number(val).toLocaleString());
  }

  return React.createElement("span", {
    title: String(val), className: "text-[var(--text-secondary)] text-xs truncate block max-w-full",
  }, String(val));
}

export interface ProductTableProps {
  products: Product[];
  allProducts: Product[];
  loading: boolean;
  selectedIds: Set<string>;
  onSelectToggle: (id: string) => void;
  onSelectAll: () => void;
  onUpdate: (id: string, updates: Record<string, unknown>) => void;
  onUndo?: () => void;
  onStartBatchUndo?: () => void;
  onEndBatchUndo?: () => void;
  columnFilters: Record<string, string[]>;
  onColumnFilterChange: (key: string, values: string[]) => void;
  rateMap: Record<string, Record<CommissionPlatform, number>>;
  categories: string[];
}
