import React from "react";
import type { Product, CommissionPlatform } from "@/types/database";
import { calcSettlementPrice, calcNetMargin, calcPlatformPrice } from "@/lib/product-calculations";

export const EDITABLE_KEYS = new Set([
  "product_name", "lowest_price",
  "margin_rate", "category", "purchase_url",
  // 플랫폼 판매가: 편집하면 고정값으로 저장됨 (fixed_price_*)
  "price_smartstore", "price_esm", "price_coupang",
]);
export const NUMERIC_KEYS = new Set(["lowest_price", "margin_rate"]);
// 자동 계산 컬럼 (display만 — price_smartstore/esm/coupang은 fixed 값이 있으면 그 값 사용)
export const COMPUTED_KEYS = new Set([
  "name_length", "net_margin", "settlement_price",
  "price_smartstore", "price_esm", "price_coupang",
  "price_change", "platform_codes",
]);

/** 플랫폼 판매가 키 → 저장되는 고정값 DB 컬럼 키 매핑 */
export const PLATFORM_FIXED_KEY_MAP: Record<string, keyof Product> = {
  price_smartstore: "fixed_price_smartstore",
  price_esm: "fixed_price_esm",
  price_coupang: "fixed_price_coupang",
};

/** 해당 플랫폼 판매가 셀이 고정값으로 잠겨있는지 */
export function isPlatformPriceLocked(product: Product, key: string): boolean {
  const fixedKey = PLATFORM_FIXED_KEY_MAP[key];
  return fixedKey ? product[fixedKey] != null : false;
}

/** 사용자 입력값을 fixed_price로 파싱 — 공백/0이면 null (잠금 해제) */
export function parseFixedPriceInput(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = parseInt(t.replace(/,/g, ""), 10);
  return isNaN(n) || n <= 0 ? null : n;
}

export interface Col { key: string; label: string; minWidth: number; align?: "right"; }
export const COLUMNS: Col[] = [
  { key: "product_name", label: "상품명", minWidth: 250 },
  { key: "name_length", label: "글자수", minWidth: 55, align: "right" },
  { key: "lowest_price", label: "최저가(원)", minWidth: 90, align: "right" },
  { key: "price_change", label: "전일 대비", minWidth: 80, align: "right" },
  { key: "margin_rate", label: "순마진율(%)", minWidth: 85, align: "right" },
  { key: "net_margin", label: "순마진(원)", minWidth: 85, align: "right" },
  { key: "settlement_price", label: "정산가(원)", minWidth: 90, align: "right" },
  { key: "category", label: "카테고리", minWidth: 120 },
  { key: "price_smartstore", label: "스마트스토어", minWidth: 95, align: "right" },
  { key: "price_esm", label: "ESM 11번가", minWidth: 90, align: "right" },
  { key: "price_coupang", label: "쿠팡", minWidth: 80, align: "right" },
  { key: "platform_codes", label: "플랫폼 코드", minWidth: 90 },
  { key: "purchase_url", label: "상품 구매 URL", minWidth: 150 },
  { key: "thumbnail_url", label: "썸네일 URL", minWidth: 80 },
  { key: "detail_html", label: "상세페이지", minWidth: 80 },
];
export const COL_COUNT = COLUMNS.length;

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
    price_smartstore: product.fixed_price_smartstore
      ?? (catRates?.smartstore ? calcPlatformPrice(sp, catRates.smartstore) : 0),
    price_esm: product.fixed_price_esm
      ?? (catRates?.esm ? calcPlatformPrice(sp, catRates.esm) : 0),
    price_coupang: product.fixed_price_coupang
      ?? (catRates?.coupang ? calcPlatformPrice(sp, catRates.coupang) : 0),
  };

  computedCache.set(product, { rateMap, values });
  return values;
}

/** 상품 행의 계산 필드 값을 가져오기 */
export function getComputedValue(
  product: Product,
  key: string,
  rateMap: Record<string, Record<CommissionPlatform, number>>,
  priceChanges?: Record<string, number>
): number {
  if (key === "price_change") return priceChanges?.[product.id] ?? 0;
  return getComputedAll(product, rateMap)[key] ?? 0;
}

export function formatCell(
  key: string,
  val: unknown,
  product?: Product,
  rateMap?: Record<string, Record<CommissionPlatform, number>>,
  priceChanges?: Record<string, number>
): React.ReactNode {
  // 플랫폼 코드 (별도 처리)
  if (key === "platform_codes" && product) {
    const codes = product.platform_codes;
    if (!codes || Object.keys(codes).length === 0) {
      return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");
    }
    const platformNames = [...new Set(Object.keys(codes).map(k => k.split("=")[0]))];
    const count = platformNames.length;
    const tooltip = platformNames.join(", ");
    return React.createElement("span", {
      title: tooltip,
      className: "inline-block px-2 py-0.5 rounded text-xs font-medium bg-orange-500/20 text-orange-400 cursor-help",
    }, `${count}개 등록`);
  }

  // 계산 필드
  if (COMPUTED_KEYS.has(key) && product && rateMap) {
    const computed = getComputedValue(product, key, rateMap, priceChanges);
    if (key === "price_change") {
      if (computed === 0) {
        return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");
      }
      const isUp = computed > 0;
      const isAlert = Math.abs(computed) >= 10;
      const colorClass = isAlert
        ? (isUp ? "text-red-500 font-bold" : "text-blue-500 font-bold")
        : (isUp ? "text-red-400" : "text-blue-400");
      const bgClass = isAlert ? (isUp ? "bg-red-500/10" : "bg-blue-500/10") : "";
      return React.createElement("span", {
        className: `text-xs font-medium px-1.5 py-0.5 rounded ${colorClass} ${bgClass}`,
      }, `${isUp ? "▲" : "▼"} ${Math.abs(computed)}%`);
    }
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
    // 플랫폼 판매가가 고정값으로 잠겨있으면 눈에 띄게 표시
    if (PLATFORM_FIXED_KEY_MAP[key] && isPlatformPriceLocked(product, key)) {
      return React.createElement("span", {
        className: "text-blue-400 text-xs font-semibold",
        title: "고정 판매가 (최저가 갱신에 영향받지 않음)",
      }, computed.toLocaleString());
    }
    return React.createElement("span", { className: "text-[var(--text-secondary)] text-xs" }, computed.toLocaleString());
  }

  // detail_html은 목록 조회 시 값을 가져오지 않음 → has_detail_html 플래그로 판정
  if (key === "detail_html") {
    if (!product?.has_detail_html && !val) {
      return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");
    }
    return React.createElement("span", {
      title: "클릭하여 HTML 복사",
      className: "text-[var(--text-secondary)] text-xs truncate block max-w-full",
    }, "(생성됨)");
  }

  if (val == null || val === "") return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");

  if (key === "margin_rate") {
    const n = Number(val);
    return React.createElement("span", {
      className: `text-xs font-medium ${n > 0 ? "text-blue-400" : "text-[var(--text-secondary)]"}`,
    }, n ? `${n}%` : "-");
  }

  if (key === "purchase_url" || key === "thumbnail_url") {
    const url = String(val);
    if (!url) return React.createElement("span", { className: "text-[var(--text-disabled)] text-xs" }, "-");
    const display = url.replace(/^https?:\/\//, "").slice(0, 20) + (url.length > 28 ? "..." : "");
    if (key === "thumbnail_url") {
      return React.createElement("span", {
        title: url, className: "text-[var(--text-secondary)] text-xs truncate block max-w-full",
      }, display);
    }
    return React.createElement("a", {
      href: url, target: "_blank", rel: "noopener noreferrer",
      className: "text-blue-400 text-xs truncate block max-w-full hover:underline",
      title: url, onClick: (e: React.MouseEvent) => e.stopPropagation(),
    }, display);
  }

  if (key === "category") {
    const CATEGORY_COLORS = [
      "bg-purple-500/20 text-purple-400",
      "bg-blue-500/20 text-blue-400",
      "bg-green-500/20 text-green-400",
      "bg-orange-500/20 text-orange-400",
      "bg-pink-500/20 text-pink-400",
      "bg-teal-500/20 text-teal-400",
      "bg-yellow-500/20 text-yellow-400",
      "bg-red-500/20 text-red-400",
      "bg-indigo-500/20 text-indigo-400",
      "bg-cyan-500/20 text-cyan-400",
    ];
    const str = String(val);
    const hash = str.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const colorClass = CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
    return React.createElement("span", {
      className: `inline-block px-2 py-0.5 rounded text-xs font-medium ${colorClass}`,
    }, str);
  }

  if (NUMERIC_KEYS.has(key)) {
    return React.createElement("span", { className: "text-[var(--text-secondary)] text-xs" }, Number(val).toLocaleString());
  }

  return React.createElement("span", {
    title: String(val), className: "text-[var(--text-secondary)] text-xs truncate block max-w-full",
  }, String(val));
}

export interface PriceChangeFilter {
  minPercent: number | null;
  maxPercent: number | null;
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
  priceChanges?: Record<string, number>;
  priceChangeFilter?: PriceChangeFilter | null;
  onPriceChangeFilterChange?: (filter: PriceChangeFilter | null) => void;
}
