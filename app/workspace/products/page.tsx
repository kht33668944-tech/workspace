"use client";

import { useState, useMemo, useCallback } from "react";
import { Plus, Trash2, Search, Settings2, Package } from "lucide-react";
import { usePreventBrowserSave } from "@/hooks/use-prevent-browser-save";
import { useProducts } from "@/hooks/use-products";
import { useCommissions } from "@/hooks/use-commissions";
import { buildRateMap } from "@/lib/product-calculations";
import ProductTable from "@/components/workspace/products/product-table";
import CommissionTab from "@/components/workspace/products/commission-tab";
import type { CommissionPlatform } from "@/types/database";

export default function ProductsPage() {
  usePreventBrowserSave();

  const [activeTab, setActiveTab] = useState<"products" | "commission">("products");
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [columnFilters, setColumnFilters] = useState<Record<string, string[]>>({});
  const [deleting, setDeleting] = useState(false);

  const { rates, categories, loading: commissionLoading } = useCommissions();
  const { products, allProducts, loading, addProduct, updateProduct, deleteProducts, undo, startBatchUndo, endBatchUndo } = useProducts({
    search: activeSearch,
    columnFilters,
  });

  const rateMap = useMemo(() => buildRateMap(rates), [rates]);

  const stats = useMemo(() => {
    const count = products.length;
    const avgMargin = count > 0
      ? products.reduce((sum, p) => sum + p.margin_rate, 0) / count
      : 0;
    const withCategory = products.filter(p => p.category).length;
    return { count, avgMargin: avgMargin.toFixed(1), withCategory };
  }, [products]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") setActiveSearch(search);
  };
  const handleSearchClear = () => {
    setSearch("");
    setActiveSearch("");
  };

  const handleSelectToggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === products.length) return new Set();
      return new Set(products.map(p => p.id));
    });
  }, [products]);

  const handleDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size}개 상품을 삭제하시겠습니까?`)) return;
    setDeleting(true);
    await deleteProducts([...selectedIds]);
    setSelectedIds(new Set());
    setDeleting(false);
  };

  const handleColumnFilterChange = useCallback((key: string, values: string[]) => {
    setColumnFilters(prev => ({ ...prev, [key]: values }));
  }, []);

  return (
    <div className="space-y-4 md:space-y-6">
      {/* 탭 */}
      <div className="flex items-center gap-1 border-b border-[var(--border)]">
        <button
          onClick={() => setActiveTab("products")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "products"
              ? "border-blue-500 text-blue-400"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Package className="w-4 h-4" />
          상품 목록
        </button>
        <button
          onClick={() => setActiveTab("commission")}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "commission"
              ? "border-blue-500 text-blue-400"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Settings2 className="w-4 h-4" />
          수수료 설정
        </button>
      </div>

      {activeTab === "commission" ? (
        <CommissionTab />
      ) : (
        <>
          {/* 액션 바 */}
          <div className="flex flex-col md:flex-row items-start md:items-center gap-3">
            {/* 검색 */}
            <div className="relative flex-1 max-w-md w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="상품명, 카테고리 검색... (Enter)"
                className="w-full pl-10 pr-8 py-2 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-400"
              />
              {search && (
                <button onClick={handleSearchClear} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                  &times;
                </button>
              )}
            </div>

            {/* 버튼 그룹 */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {selectedIds.size > 0 && (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                  {deleting ? "삭제 중..." : `${selectedIds.size}개 삭제`}
                </button>
              )}
              <button
                onClick={addProduct}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                상품 추가
              </button>
            </div>
          </div>

          {/* 통계 */}
          <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
            <span>총 <strong className="text-[var(--text-primary)]">{stats.count}</strong>건</span>
            <span>평균 마진율 <strong className="text-blue-400">{stats.avgMargin}%</strong></span>
            <span>카테고리 설정 <strong className="text-purple-400">{stats.withCategory}</strong>건</span>
          </div>

          {/* 테이블 */}
          <ProductTable
            products={products}
            allProducts={allProducts}
            loading={loading || commissionLoading}
            selectedIds={selectedIds}
            onSelectToggle={handleSelectToggle}
            onSelectAll={handleSelectAll}
            onUpdate={updateProduct}
            onUndo={undo}
            onStartBatchUndo={startBatchUndo}
            onEndBatchUndo={endBatchUndo}
            columnFilters={columnFilters}
            onColumnFilterChange={handleColumnFilterChange}
            rateMap={rateMap as Record<string, Record<CommissionPlatform, number>>}
            categories={categories}
          />
        </>
      )}
    </div>
  );
}
