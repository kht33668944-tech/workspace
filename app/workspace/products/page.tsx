"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { Plus, Trash2, Search, Settings2, Package, Download, Images, Play, FileSpreadsheet, LayoutList } from "lucide-react";
import { usePreventBrowserSave } from "@/hooks/use-prevent-browser-save";
import { useProducts } from "@/hooks/use-products";
import { useCommissions } from "@/hooks/use-commissions";
import { buildRateMap } from "@/lib/product-calculations";
import { useAiTask } from "@/context/AiTaskContext";
import { useAuth } from "@/context/AuthContext";
import ProductTable from "@/components/workspace/products/product-table";
import CommissionTab from "@/components/workspace/products/commission-tab";
import ImageTab from "@/components/workspace/products/image-tab";
import SmartStoreCategoryTab from "@/components/workspace/products/smartstore-category-tab";
import GmarketImportModal from "@/components/workspace/products/gmarket-import-modal";
import BatchDetailModal from "@/components/workspace/products/batch-detail-modal";
import type { CommissionPlatform, ProductInsert } from "@/types/database";
import { downloadExcelFromBase64 } from "@/lib/excel-export";

type ActiveTab = "products" | "images" | "commission" | "smartstore-category";

export default function ProductsPage() {
  usePreventBrowserSave();

  const { session } = useAuth();
  const {
    batchItems, batchActive, batchVisible,
    startBatch, dismissBatch, clearBatch,
    registerOnUpdate, unregisterOnUpdate,
  } = useAiTask();

  const [activeTab, setActiveTab] = useState<ActiveTab>("products");
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [columnFilters, setColumnFilters] = useState<Record<string, string[]>>({});
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);

  const { rates, categories, loading: commissionLoading } = useCommissions();
  const { products, allProducts, loading, addProduct, insertProducts, updateProduct, deleteProducts, undo, startBatchUndo, endBatchUndo } = useProducts({
    search: activeSearch,
    columnFilters,
  });

  const rateMap = useMemo(() => buildRateMap(rates), [rates]);

  // products 탭에서 배치 완료 시 로컬 캐시 동기화
  useEffect(() => {
    if (activeTab !== "products") return;
    registerOnUpdate(updateProduct);
    return () => { unregisterOnUpdate(); };
  }, [activeTab, updateProduct, registerOnUpdate, unregisterOnUpdate]);

  const handleStartBatchDetail = useCallback(() => {
    const selected = products.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0 || !session?.access_token) return;
    startBatch(
      selected.map((p) => ({
        productId: p.id,
        productName: p.product_name,
        purchaseUrl: p.purchase_url,
        thumbnailUrl: p.thumbnail_url,
      })),
      session.access_token
    );
  }, [products, selectedIds, session, startBatch]);

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

  const handleImport = async (rows: Omit<ProductInsert, "user_id">[]) => {
    return insertProducts(rows as ProductInsert[]);
  };

  const handlePlayAutoExport = async () => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id);
    if (ids.length === 0) return;
    setExporting(true);
    try {
      const res = await fetch("/api/products/playauto-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: ids, platform: "smartstore" }),
      });
      const json = await res.json() as { base64?: string; filename?: string; error?: string };
      if (!res.ok || !json.base64 || !json.filename) {
        alert(json.error ?? "내보내기 실패");
        return;
      }
      downloadExcelFromBase64(json.base64, json.filename);
    } catch {
      alert("내보내기 중 오류가 발생했습니다.");
    } finally {
      setExporting(false);
    }
  };

  const TAB_CLASSES = (tab: ActiveTab) =>
    `flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
      activeTab === tab
        ? "border-blue-500 text-blue-400"
        : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
    }`;

  return (
    <div className="space-y-4 md:space-y-6">
      {/* 탭 */}
      <div className="flex items-center gap-1 border-b border-[var(--border)]">
        <button onClick={() => setActiveTab("products")} className={TAB_CLASSES("products")}>
          <Package className="w-4 h-4" />
          상품 목록
        </button>
        <button onClick={() => setActiveTab("images")} className={TAB_CLASSES("images")}>
          <Images className="w-4 h-4" />
          이미지 관리
        </button>
        <button onClick={() => setActiveTab("commission")} className={TAB_CLASSES("commission")}>
          <Settings2 className="w-4 h-4" />
          수수료 설정
        </button>
        <button onClick={() => setActiveTab("smartstore-category")} className={TAB_CLASSES("smartstore-category")}>
          <LayoutList className="w-4 h-4" />
          스토어 카테고리
        </button>
      </div>

      {activeTab === "commission" && <CommissionTab />}

      {activeTab === "smartstore-category" && <SmartStoreCategoryTab />}

      {activeTab === "images" && (
        <ImageTab products={allProducts} onUpdate={updateProduct} onDelete={deleteProducts} />
      )}

      {activeTab === "products" && (
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
            <div className="flex items-center gap-2 shrink-0">
              {selectedIds.size > 0 && (
                <>
                  <button
                    onClick={handleStartBatchDetail}
                    disabled={batchActive}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Play className="w-4 h-4" />
                    {batchActive ? "생성 중..." : `${selectedIds.size}개 상세페이지 생성`}
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                    {deleting ? "삭제 중..." : `${selectedIds.size}개 삭제`}
                  </button>
                </>
              )}
              <button
                onClick={handlePlayAutoExport}
                disabled={exporting}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-violet-600/20 text-violet-400 hover:bg-violet-600/30 rounded-lg transition-colors disabled:opacity-50"
              >
                <FileSpreadsheet className="w-4 h-4" />
                {exporting ? "생성 중..." : `플레이오토${selectedIds.size > 0 ? ` ${selectedIds.size}개` : ""} 내보내기`}
              </button>
              <button
                onClick={() => setImportModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors"
              >
                <Download className="w-4 h-4" />
                지마켓 가져오기
              </button>
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

      {/* 지마켓 가져오기 모달 */}
      {importModalOpen && (
        <GmarketImportModal
          onClose={() => setImportModalOpen(false)}
          onImport={handleImport}
          productCount={allProducts.length}
          categories={categories}
        />
      )}

      {/* 상세페이지 일괄 생성 모달 */}
      {batchVisible && (
        <BatchDetailModal items={batchItems} onClose={dismissBatch} onClear={clearBatch} />
      )}
    </div>
  );
}
