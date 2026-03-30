"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { Plus, Trash2, Search, Settings2, Package, Download, Upload, Images, Play, FileSpreadsheet, LayoutList, RefreshCw, TrendingUp, Tags } from "lucide-react";
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
import dynamic from "next/dynamic";
import type { CommissionPlatform, ProductInsert } from "@/types/database";
import { downloadExcelFromBase64, type PlayAutoExportPlatform, PLATFORM_CONFIGS } from "@/lib/excel-export";
import { REGISTRATION_STATUSES, REGISTRATION_STATUS_COLORS } from "@/lib/constants";

const PriceHistoryTab = dynamic(() => import("@/components/workspace/products/price-history-tab"), { ssr: false });
const ExportConfigTab = dynamic(() => import("@/components/workspace/products/export-config-tab"), { ssr: false });

type ActiveTab = "products" | "images" | "commission" | "smartstore-category" | "price-history" | "export-config";

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
  const [exportStep, setExportStep] = useState("");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [scrapingPrices, setScrapingPrices] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState("");
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [importingCodes, setImportingCodes] = useState(false);
  const [priceUpdateExporting, setPriceUpdateExporting] = useState(false);

  const { rates, categories, loading: commissionLoading } = useCommissions();
  const { products, allProducts, loading, addProduct, insertProducts, updateProduct, deleteProducts, undo, startBatchUndo, endBatchUndo, priceChanges, refetchPriceChanges } = useProducts({
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
    const filled = products.filter(p => p.product_name?.trim());
    const count = filled.length;
    const avgMargin = count > 0
      ? filled.reduce((sum, p) => sum + p.margin_rate, 0) / count
      : 0;
    const withCategory = filled.filter(p => p.category).length;
    return { count, avgMargin: avgMargin.toFixed(1), withCategory, total: products.length };
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

  const handleBulkStatusChange = async (status: string) => {
    setStatusDropdownOpen(false);
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    await Promise.all(ids.map(id => updateProduct(id, { registration_status: status })));
  };

  const handleColumnFilterChange = useCallback((key: string, values: string[]) => {
    setColumnFilters(prev => ({ ...prev, [key]: values }));
  }, []);

  const handleImport = async (rows: Omit<ProductInsert, "user_id">[]) => {
    return insertProducts(rows as ProductInsert[]);
  };

  const handleScrapePrices = async () => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : products.filter(p => p.purchase_url).map(p => p.id);
    if (ids.length === 0) return;
    if (!confirm(`${selectedIds.size > 0 ? `선택한 ${ids.length}개` : `전체 ${ids.length}개`} 상품의 최저가를 갱신하시겠습니까?`)) return;

    setScrapingPrices(true);
    setScrapeProgress("최저가 수집 준비 중...");

    try {
      const res = await fetch("/api/products/scrape-prices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ productIds: ids }),
      });

      if (!res.ok || !res.body) {
        alert("최저가 수집 실패");
        return;
      }

      const pendingUpdates: Array<{ id: string; price: number }> = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushUpdates = () => {
        if (pendingUpdates.length === 0) return;
        startBatchUndo();
        for (const u of pendingUpdates) {
          updateProduct(u.id, { lowest_price: u.price });
        }
        endBatchUndo();
        pendingUpdates.length = 0;
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const data = line.replace(/^data: /, "").trim();
          if (!data) continue;
          try {
            const event = JSON.parse(data);
            if (event.type === "progress") {
              const priceText = event.price > 0
                ? event.price !== event.previous_price
                  ? `${event.previous_price.toLocaleString()}→${event.price.toLocaleString()}원`
                  : `${event.price.toLocaleString()}원 (변동없음)`
                : "실패";
              setScrapeProgress(`(${event.index}/${event.total}) ${event.name} → ${priceText}`);
              if (event.price > 0) {
                pendingUpdates.push({ id: event.id, price: event.price });
                if (flushTimer) clearTimeout(flushTimer);
                flushTimer = setTimeout(flushUpdates, 200);
              }
            } else if (event.type === "done") {
              if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
              flushUpdates();
              refetchPriceChanges();
              setScrapeProgress(`완료: ${event.updated}개 갱신, ${event.unchanged ?? 0}개 변동없음, ${event.failed}개 실패`);
            } else if (event.type === "error") {
              if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
              flushUpdates();
              setScrapeProgress(`오류: ${event.message}`);
            }
          } catch {}
        }
      }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flushUpdates();
    } catch {
      setScrapeProgress("최저가 수집 중 오류 발생");
    } finally {
      setTimeout(() => {
        setScrapingPrices(false);
        setScrapeProgress("");
      }, 3000);
    }
  };

  const handlePlayAutoExport = async (platform: PlayAutoExportPlatform) => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id);
    if (ids.length === 0) return;
    setExportModalOpen(false);
    setExporting(true);
    setExportStep("상품 데이터 조회 중...");

    // 단계별 메시지 자동 전환
    const steps = [
      { delay: 3000, msg: "수수료 및 카테고리코드 로드 중..." },
      { delay: 7000, msg: "AI 브랜드/모델명 추출 중..." },
      { delay: 12000, msg: "AI 카테고리코드 매칭 중 (1단계: 분류 선택)..." },
      { delay: 20000, msg: "AI 카테고리코드 매칭 중 (2단계: 코드 매칭)..." },
      { delay: 35000, msg: "엑셀 파일 생성 중..." },
    ];
    const timers = steps.map(({ delay, msg }) =>
      setTimeout(() => setExportStep(msg), delay)
    );

    try {
      const res = await fetch("/api/products/playauto-export", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ productIds: ids, platform }),
      });
      const json = await res.json() as { base64?: string; filename?: string; error?: string };
      if (!res.ok || !json.base64 || !json.filename) {
        alert(json.error ?? "내보내기 실패");
        return;
      }
      downloadExcelFromBase64(json.base64, json.filename);
      saveToArchive(json.filename, json.base64, ids.length);
    } catch {
      alert("내보내기 중 오류가 발생했습니다.");
    } finally {
      timers.forEach(clearTimeout);
      setExporting(false);
      setExportStep("");
    }
  };

  const saveToArchive = (fileName: string, fileData: string, count: number) => {
    fetch("/api/archives", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ file_name: fileName, file_type: "playauto_product", file_data: fileData, order_count: count }),
    }).catch(() => {});
  };

  const handleExportAll = async () => {
    const platforms: PlayAutoExportPlatform[] = ["smartstore", "gmarket_auction", "coupang"];
    setExportModalOpen(false);
    setExporting(true);
    setExportStep("전체 플랫폼 내보내기 중...");

    const ids = selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id);
    if (ids.length === 0) { setExporting(false); setExportStep(""); return; }

    try {
      const results = await Promise.allSettled(
        platforms.map(async (platform) => {
          const res = await fetch("/api/products/playauto-export", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({ productIds: ids, platform }),
          });
          const json = await res.json() as { base64?: string; filename?: string; error?: string };
          if (!res.ok || !json.base64 || !json.filename) {
            throw new Error(json.error ?? `${PLATFORM_CONFIGS[platform].filenameLabel} 내보내기 실패`);
          }
          return { platform, ...json } as { platform: PlayAutoExportPlatform; base64: string; filename: string };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          downloadExcelFromBase64(r.value.base64, r.value.filename);
          saveToArchive(r.value.filename, r.value.base64, ids.length);
        } else {
          alert(r.reason?.message ?? "내보내기 실패");
        }
      }
    } catch {
      alert("내보내기 중 오류가 발생했습니다.");
    } finally {
      setExporting(false);
      setExportStep("");
    }
  };

  const handleImportPlatformCodes = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx,.xls";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImportingCodes(true);
      try {
        const arrayBuffer = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        const res = await fetch("/api/products/import-platform-codes", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ excelBase64: base64 }),
        });
        const json = await res.json() as { matched?: number; unmatched?: string[]; total?: number; error?: string };
        if (!res.ok) {
          alert(json.error ?? "가져오기 실패");
          return;
        }
        const unmatchedMsg = json.unmatched && json.unmatched.length > 0
          ? `\n\n미매칭 상품 (${json.unmatched.length}개):\n${json.unmatched.slice(0, 10).join("\n")}${json.unmatched.length > 10 ? "\n..." : ""}`
          : "";
        alert(`플랫폼 코드 가져오기 완료!\n\n전체 ${json.total}행 중 ${json.matched}개 상품 매칭 성공${unmatchedMsg}`);
      } catch {
        alert("플랫폼 코드 가져오기 중 오류가 발생했습니다.");
      } finally {
        setImportingCodes(false);
      }
    };
    input.click();
  };

  const handlePriceUpdateExport = async () => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id);
    if (ids.length === 0) return;
    setExportModalOpen(false);
    setPriceUpdateExporting(true);
    try {
      const res = await fetch("/api/products/price-update-export", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ productIds: ids }),
      });
      const json = await res.json() as { normal?: { base64: string; filename: string }; single?: { base64: string; filename: string }; error?: string };
      if (!res.ok) {
        alert(json.error ?? "가격수정 내보내기 실패");
        return;
      }
      if (json.normal) downloadExcelFromBase64(json.normal.base64, json.normal.filename);
      if (json.single) downloadExcelFromBase64(json.single.base64, json.single.filename);
    } catch {
      alert("가격수정 내보내기 중 오류가 발생했습니다.");
    } finally {
      setPriceUpdateExporting(false);
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
          플토 카테고리
        </button>
        <button onClick={() => setActiveTab("price-history")} className={TAB_CLASSES("price-history")}>
          <TrendingUp className="w-4 h-4" />
          가격 추이
        </button>
        <button onClick={() => setActiveTab("export-config")} className={TAB_CLASSES("export-config")}>
          <FileSpreadsheet className="w-4 h-4" />
          플토 양식
        </button>
      </div>

      {activeTab === "commission" && <CommissionTab />}

      {activeTab === "smartstore-category" && <SmartStoreCategoryTab />}

      {activeTab === "price-history" && <PriceHistoryTab />}

      {activeTab === "export-config" && <ExportConfigTab />}

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
                  <div className="relative">
                    <button
                      onClick={() => setStatusDropdownOpen(!statusDropdownOpen)}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm bg-teal-600/20 text-teal-400 hover:bg-teal-600/30 rounded-lg transition-colors"
                    >
                      <Tags className="w-4 h-4" />
                      등록상태 변경
                    </button>
                    {statusDropdownOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setStatusDropdownOpen(false)} />
                        <div className="absolute left-0 top-full mt-1 z-50 w-36 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden">
                          {REGISTRATION_STATUSES.map(s => (
                            <button
                              key={s}
                              onClick={() => handleBulkStatusChange(s)}
                              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                            >
                              <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${REGISTRATION_STATUS_COLORS[s]}`}>{s}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
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
                onClick={handleScrapePrices}
                disabled={scrapingPrices}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 rounded-lg transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${scrapingPrices ? "animate-spin" : ""}`} />
                {scrapingPrices ? "수집 중..." : `최저가 갱신${selectedIds.size > 0 ? ` ${selectedIds.size}개` : ""}`}
              </button>
              <div className="relative">
                <button
                  onClick={() => !exporting && setExportModalOpen(true)}
                  disabled={exporting}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm bg-violet-600/20 text-violet-400 hover:bg-violet-600/30 rounded-lg transition-colors disabled:opacity-50"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  {exporting ? exportStep || "생성 중..." : `플레이오토${selectedIds.size > 0 ? ` ${selectedIds.size}개` : ""} 내보내기`}
                </button>
                {exportModalOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setExportModalOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl overflow-hidden">
                      <div className="px-3 py-2 border-b border-[var(--border)]">
                        <span className="text-xs font-medium text-[var(--text-muted)]">플랫폼 선택</span>
                      </div>
                      <button
                        onClick={() => handlePlayAutoExport("smartstore")}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        <span className="w-2 h-2 rounded-full bg-green-400" />
                        스마트스토어
                      </button>
                      <button
                        onClick={() => handlePlayAutoExport("gmarket_auction")}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        <span className="w-2 h-2 rounded-full bg-yellow-400" />
                        지마켓·옥션
                      </button>
                      <button
                        onClick={() => handlePlayAutoExport("coupang")}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        <span className="w-2 h-2 rounded-full bg-red-400" />
                        쿠팡
                      </button>
                      <button
                        disabled
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-[var(--text-disabled)] cursor-not-allowed"
                      >
                        <span className="w-2 h-2 rounded-full bg-blue-400/40" />
                        멸치쇼핑
                        <span className="ml-auto text-[10px] bg-[var(--bg-tertiary)] text-[var(--text-muted)] px-1.5 py-0.5 rounded">준비중</span>
                      </button>
                      <div className="border-t border-[var(--border)]">
                        <button
                          onClick={handleExportAll}
                          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-violet-400 hover:bg-violet-600/10 transition-colors font-medium"
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5" />
                          전체 다운로드
                        </button>
                      </div>
                      <div className="border-t border-[var(--border)]">
                        <button
                          onClick={handlePriceUpdateExport}
                          disabled={priceUpdateExporting}
                          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-orange-400 hover:bg-orange-600/10 transition-colors font-medium"
                        >
                          <TrendingUp className="w-3.5 h-3.5" />
                          {priceUpdateExporting ? "생성 중..." : "가격수정 내보내기"}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={handleImportPlatformCodes}
                disabled={importingCodes}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-orange-600/20 text-orange-400 hover:bg-orange-600/30 rounded-lg transition-colors disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                {importingCodes ? "가져오는 중..." : "플랫폼 코드 가져오기"}
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
            {selectedIds.size > 0 && <span>선택 <strong className="text-yellow-400">{selectedIds.size}</strong>건</span>}
            <span>등록 <strong className="text-[var(--text-primary)]">{stats.count}</strong><span className="text-[var(--text-disabled)]">/{stats.total}</span>건</span>
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
            priceChanges={priceChanges}
          />
        </>
      )}

      {/* 지마켓 가져오기 모달 */}
      {importModalOpen && (
        <GmarketImportModal
          onClose={() => setImportModalOpen(false)}
          onImport={handleImport}
          categories={categories}
        />
      )}

      {/* 상세페이지 일괄 생성 모달 */}
      {batchVisible && (
        <BatchDetailModal items={batchItems} onClose={dismissBatch} onClear={clearBatch} />
      )}

      {/* 최저가 수집 진행 상태 바 */}
      {scrapingPrices && scrapeProgress && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-lg">
          <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin" />
          <span className="text-sm text-[var(--text-primary)]">{scrapeProgress}</span>
        </div>
      )}

      {/* 플레이오토 내보내기 진행 상태 바 */}
      {exporting && exportStep && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-lg">
          <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-[var(--text-primary)]">{exportStep}</span>
        </div>
      )}
    </div>
  );
}
