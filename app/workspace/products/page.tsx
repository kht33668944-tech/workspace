"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Plus, Trash2, Settings2, Package, Download, Upload, Images, Play, FileSpreadsheet, LayoutList, RefreshCw, RotateCcw, TrendingUp, Tags, ChevronDown, ChevronUp, ChevronRight, PlugZap, Eraser } from "lucide-react";
import { usePreventBrowserSave } from "@/hooks/use-prevent-browser-save";
import { useProducts, type PriceChangeFilter } from "@/hooks/use-products";
import { useCommissions } from "@/hooks/use-commissions";
import { buildRateMap } from "@/lib/product-calculations";
import { useAiTask } from "@/context/AiTaskContext";
import { useAuth } from "@/context/AuthContext";
import { useGmarketImportController } from "@/context/modal-controllers";
import ProductTable from "@/components/workspace/products/product-table";
import FilterBar from "@/components/ui/filter-bar";
import dynamic from "next/dynamic";

const CommissionTab = dynamic(() => import("@/components/workspace/products/commission-tab"), { ssr: false });
const ImageTab = dynamic(() => import("@/components/workspace/products/image-tab"), { ssr: false });
const SmartStoreCategoryTab = dynamic(() => import("@/components/workspace/products/smartstore-category-tab"), { ssr: false });
const CoupangPriceImportModal = dynamic(() => import("@/components/workspace/products/coupang-price-import-modal"), { ssr: false });
const EsmPriceImportModal = dynamic(() => import("@/components/workspace/products/esm-price-import-modal"), { ssr: false });
const SmartstorePriceImportModal = dynamic(() => import("@/components/workspace/products/smartstore-price-import-modal"), { ssr: false });
const MarketplaceApiModal = dynamic(() => import("@/components/workspace/products/marketplace-api-modal"), { ssr: false });
const BatchDetailModal = dynamic(() => import("@/components/workspace/products/batch-detail-modal"), { ssr: false });
const RegistrationResetModal = dynamic(() => import("@/components/workspace/products/registration-reset-modal"), { ssr: false });
import type { CommissionPlatform, ProductInsert } from "@/types/database";
import { downloadExcelFromBase64, type PlayAutoExportPlatform, PLATFORM_CONFIGS } from "@/lib/excel-export";
import { exportPriceV2Platform, exportPriceV2All } from "@/lib/price-update-v2-export";
import { REGISTRATION_STATUSES, REGISTRATION_STATUS_COLORS } from "@/lib/constants";
import { readJsonStorage, readUrlParam, rememberWorkspaceHref, replaceUrlParams, writeJsonStorage } from "@/lib/view-state";

const PriceHistoryTab = dynamic(() => import("@/components/workspace/products/price-history-tab"), { ssr: false });
const ExportConfigTab = dynamic(() => import("@/components/workspace/products/export-config-tab"), { ssr: false });

type ActiveTab = "products" | "images" | "commission" | "smartstore-category" | "price-history" | "export-config";
const PRODUCT_TABS: ActiveTab[] = ["products", "images", "commission", "smartstore-category", "price-history", "export-config"];
const PRODUCTS_VIEW_STORAGE_KEY = "workspace:products:view";

interface ProductsViewState {
  tab: ActiveTab;
  search: string;
  columnFilters: Record<string, string[]>;
  priceChangeFilter: PriceChangeFilter | null;
}

function isProductTab(value: string | null): value is ActiveTab {
  return !!value && PRODUCT_TABS.includes(value as ActiveTab);
}

function loadProductsViewState(): ProductsViewState {
  const saved = readJsonStorage<Partial<ProductsViewState>>(PRODUCTS_VIEW_STORAGE_KEY);
  const urlTab = readUrlParam("tab");
  const urlSearch = readUrlParam("search");

  return {
    tab: isProductTab(urlTab) ? urlTab : saved?.tab ?? "products",
    search: urlSearch ?? saved?.search ?? "",
    columnFilters: saved?.columnFilters ?? {},
    priceChangeFilter: saved?.priceChangeFilter ?? null,
  };
}

type RetryItem = { id: string; name: string };
type ScrapeStatusKey = "updated" | "unchanged" | "bot_blocked" | "failed" | "sold_out";

/** 쿠팡 내보내기 시 필수옵션 누락 경고 (route의 warnings 응답 형식) */
type ExportWarning = { productName: string; missing: string[] };

// 플레이오토 쿠팡은 카테고리/추천옵션 오류를 추적하기 쉽게 더 작게 나눈다.
// 300개 업로드도 가능하지만 실패 원인 추적과 재시도 효율 기준으로 쿠팡은 150개가 안전하다.
const DEFAULT_PLAYAUTO_EXPORT_BATCH_SIZE = 300;
const COUPANG_PLAYAUTO_EXPORT_BATCH_SIZE = 150;

function splitPlayAutoExportIds(ids: string[], platform?: PlayAutoExportPlatform): string[][] {
  const batchSize = platform === "coupang" ? COUPANG_PLAYAUTO_EXPORT_BATCH_SIZE : DEFAULT_PLAYAUTO_EXPORT_BATCH_SIZE;
  return Array.from(
    { length: Math.ceil(ids.length / batchSize) },
    (_, index) => ids.slice(index * batchSize, (index + 1) * batchSize)
  );
}

function addPlayAutoBatchToFilename(filename: string, batchIndex: number, batchTotal: number): string {
  if (batchTotal <= 1) return filename;
  const extensionIndex = filename.lastIndexOf(".");
  const baseName = extensionIndex === -1 ? filename : filename.slice(0, extensionIndex);
  const extension = extensionIndex === -1 ? "" : filename.slice(extensionIndex);
  return `${baseName}_${batchIndex + 1}-${batchTotal}${extension}`;
}

export default function ProductsPage() {
  usePreventBrowserSave();

  const { session } = useAuth();
  const gmarketImport = useGmarketImportController();
  const {
    batchItems, batchActive, batchVisible,
    startBatch, dismissBatch, clearBatch,
    registerOnUpdate, unregisterOnUpdate,
  } = useAiTask();

  const initialView = useMemo(() => loadProductsViewState(), []);
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialView.tab);
  const [search, setSearch] = useState(initialView.search);
  const [activeSearch, setActiveSearch] = useState(initialView.search);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [columnFilters, setColumnFilters] = useState<Record<string, string[]>>(initialView.columnFilters);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStep, setExportStep] = useState("");
  const [scrapingPrices, setScrapingPrices] = useState(false);
  const [resettingPriceChanges, setResettingPriceChanges] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [expandedExportSection, setExpandedExportSection] = useState<string | null>(null);
  const [expandedV2Section, setExpandedV2Section] = useState<"import" | "export" | null>(null);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [importingCodes, setImportingCodes] = useState(false);
  const [platformCodeModalOpen, setPlatformCodeModalOpen] = useState(false);
  const [platformCodeDragOver, setPlatformCodeDragOver] = useState(false);
  const [platformCodeResult, setPlatformCodeResult] = useState<{ matched: number; unmatched: string[]; total: number; ignored11st?: number } | null>(null);
  const [priceUpdateExporting, setPriceUpdateExporting] = useState(false);
  const [priceUpdateV2Exporting, setPriceUpdateV2Exporting] = useState(false);
  const [coupangImportModalOpen, setCoupangImportModalOpen] = useState(false);
  const [esmImportModalOpen, setEsmImportModalOpen] = useState(false);
  const [smartstoreImportModalOpen, setSmartstoreImportModalOpen] = useState(false);
  const [marketplaceApiModal, setMarketplaceApiModal] = useState<"coupang" | "smartstore" | null>(null);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [priceChangeFilter, setPriceChangeFilter] = useState<PriceChangeFilter | null>(initialView.priceChangeFilter);
  const [scrapeResults, setScrapeResults] = useState<Array<{ id: string; name: string; previous: number; price: number }>>([]);
  const [scrapeSoldOutIds, setScrapeSoldOutIds] = useState<string[]>([]);
  const [scrapeResultModalOpen, setScrapeResultModalOpen] = useState(false);
  const [botBlockedItems, setBotBlockedItems] = useState<RetryItem[]>([]);
  const [applyingPrices, setApplyingPrices] = useState(false);
  const [scrapeLog, setScrapeLog] = useState<string[]>([]);
  const [scrapeLogCollapsed, setScrapeLogCollapsed] = useState(false);
  const [scrapeStatus, setScrapeStatus] = useState<Map<string, ScrapeStatusKey>>(new Map());
  const [scrapeTotal, setScrapeTotal] = useState(0);
  const scrapeLogRef = useRef<HTMLDivElement>(null);
  const scrapeAbortRef = useRef<AbortController | null>(null);
  const [scrapeDropdownOpen, setScrapeDropdownOpen] = useState(false);
  const platformCodeFileRef = useRef<HTMLInputElement>(null);

  const { rates, categories, loading: commissionLoading } = useCommissions();
  const { products, allProducts, loading, refetch, addProduct, insertProducts, updateProduct, deleteProducts, resetProductFields, undo, startBatchUndo, endBatchUndo, priceChanges, priceScrapeStatus, refetchPriceChanges } = useProducts({
    search: activeSearch,
    columnFilters,
    priceChangeFilter,
  });

  const rateMap = useMemo(() => buildRateMap(rates), [rates]);
  const sortedScrapeResults = useMemo(() =>
    [...scrapeResults].sort((a, b) => (a.price === a.previous ? 1 : 0) - (b.price === b.previous ? 1 : 0)),
    [scrapeResults]
  );
  const changedScrapeCount = useMemo(() => scrapeResults.filter(r => r.price !== r.previous).length, [scrapeResults]);
  const scrapeSoldOutItems = useMemo(() => {
    const seen = new Set<string>();
    return scrapeSoldOutIds
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => ({ id, name: allProducts.find(p => p.id === id)?.product_name ?? "품절 상품" }));
  }, [scrapeSoldOutIds, allProducts]);
  const scrapeExportTargetIds = useMemo(() => {
    const ids = new Set(scrapeResults.filter(r => r.price !== r.previous).map(r => r.id));
    for (const id of scrapeSoldOutIds) ids.add(id);
    return [...ids];
  }, [scrapeResults, scrapeSoldOutIds]);
  const scrapeStats = useMemo(() => {
    let updated = 0, unchanged = 0, botBlocked = 0, failed = 0, soldOut = 0;
    for (const s of scrapeStatus.values()) {
      if (s === "updated") updated++;
      else if (s === "unchanged") unchanged++;
      else if (s === "bot_blocked") botBlocked++;
      else if (s === "sold_out") soldOut++;
      else if (s === "failed") failed++;
    }
    return { updated, unchanged, botBlocked, failed, soldOut, processed: scrapeStatus.size };
  }, [scrapeStatus]);

  useEffect(() => {
    if (scrapeLogRef.current) {
      scrapeLogRef.current.scrollTop = scrapeLogRef.current.scrollHeight;
    }
  }, [scrapeLog]);

  const pushScrapeLog = useCallback((msg: string) => {
    setScrapeLog(prev => {
      const next = [...prev, msg];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  // products 탭에서 배치 완료 시 로컬 캐시 동기화
  useEffect(() => {
    writeJsonStorage<ProductsViewState>(PRODUCTS_VIEW_STORAGE_KEY, {
      tab: activeTab,
      search: activeSearch,
      columnFilters,
      priceChangeFilter,
    });
    replaceUrlParams({
      tab: activeTab,
      search: activeSearch || null,
    });
    rememberWorkspaceHref("/workspace/products");
  }, [activeTab, activeSearch, columnFilters, priceChangeFilter]);

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
    const allFilled = allProducts.filter(p => p.product_name?.trim());
    const count = filled.length;
    const avgMargin = count > 0
      ? filled.reduce((sum, p) => sum + p.margin_rate, 0) / count
      : 0;
    const withCategory = filled.filter(p => p.category).length;
    return { count, avgMargin: avgMargin.toFixed(1), withCategory, total: allFilled.length };
  }, [products, allProducts]);

  const hasActiveListFilters = useMemo(() => {
    const hasColumnFilters = Object.values(columnFilters).some((v) => v.length > 0);
    return Boolean(activeSearch.trim() || hasColumnFilters || priceChangeFilter);
  }, [activeSearch, columnFilters, priceChangeFilter]);

  const handleSearchSubmit = () => setActiveSearch(search);
  const handleSearchClear = () => {
    setSearch("");
    setActiveSearch("");
  };
  const handleResetListFilters = () => {
    setSearch("");
    setActiveSearch("");
    setColumnFilters({});
    setPriceChangeFilter(null);
    setSelectedIds(new Set());
  };
  const handleTabChange = useCallback((tab: ActiveTab) => {
    setActiveTab(tab);
    setSelectedIds(new Set());
  }, []);

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

  const handleBulkMarginChange = useCallback((value: number) => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    startBatchUndo();
    for (const id of ids) {
      updateProduct(id, { margin_rate: value });
    }
    endBatchUndo();
  }, [selectedIds, startBatchUndo, endBatchUndo, updateProduct]);

  const handleColumnFilterChange = useCallback((key: string, values: string[]) => {
    setColumnFilters(prev => ({ ...prev, [key]: values }));
  }, []);

  const handleImport = async (rows: Omit<ProductInsert, "user_id">[]) => {
    return insertProducts(rows as ProductInsert[]);
  };

  // 지마켓 가져오기 백그라운드 호스트가 호출할 import 핸들러 등록 (페이지 마운트 중에만 유효).
  // dep array 없이 매 렌더마다 최신 handleImport(현재 products 기준 중복필터 포함)를 등록.
  useEffect(() => {
    gmarketImport.registerHandler(handleImport);
    return () => gmarketImport.registerHandler(null);
  });

  // 품절 sentinel 마진(35%) / 재입고 복원 기본 마진(7%)
  const SOLDOUT_MARGIN = 35;
  const DEFAULT_MARGIN = 7;
  // 최저가 갱신 결과에 따라 품절 상품은 마진 35%, 재입고(정상가 재수집) 상품은 7%로 자동 세팅
  const applySoldOutMargins = (inStockIds: string[], soldOutIds: string[]) => {
    const inStock = new Set(inStockIds);
    const sold = new Set(soldOutIds);
    if (inStock.size === 0 && sold.size === 0) return;
    startBatchUndo();
    for (const id of sold) {
      const p = allProducts.find(x => x.id === id);
      if (p && p.margin_rate !== SOLDOUT_MARGIN) updateProduct(id, { margin_rate: SOLDOUT_MARGIN });
    }
    for (const id of inStock) {
      const p = allProducts.find(x => x.id === id);
      if (p && p.margin_rate === SOLDOUT_MARGIN) updateProduct(id, { margin_rate: DEFAULT_MARGIN });
    }
    endBatchUndo();
  };

  // 최저가 갱신: 모든 재시도 라운드 종료 후 합산 결과로 디스코드 1회 발송
  const sendPriceScrapeNotify = async (args: {
    finalStatus: Map<string, ScrapeStatusKey>;
    changes: Array<{ id: string; previous: number; price: number }>;
    skipped: number;
    retryCount: number;
    stopped: boolean;
  }) => {
    if (!session?.access_token) return;
    const { finalStatus, changes, skipped, retryCount, stopped } = args;

    let updated = 0, unchanged = 0, soldOut = 0, failed = 0, botBlocked = 0;
    for (const st of finalStatus.values()) {
      if (st === "updated") updated++;
      else if (st === "unchanged") unchanged++;
      else if (st === "sold_out") soldOut++;
      else if (st === "failed") failed++;
      else if (st === "bot_blocked") botBlocked++;
    }

    // 인하/인상 (id별 최신 가격 기준, 최종 상태가 updated인 항목만)
    const priceById = new Map<string, { previous: number; price: number }>();
    for (const c of changes) priceById.set(c.id, { previous: c.previous, price: c.price });
    let down = 0, up = 0;
    for (const [id, st] of finalStatus) {
      if (st !== "updated") continue;
      const p = priceById.get(id);
      if (!p) continue;
      if (p.price < p.previous) down++;
      else if (p.price > p.previous) up++;
    }

    const checked = updated + unchanged + soldOut + failed + botBlocked;
    const okCount = updated + unchanged + soldOut;
    const failCount = failed + botBlocked;
    const status: "success" | "partial" | "failed" | "cancelled" = stopped
      ? "cancelled"
      : okCount > 0 && failCount > 0
        ? "partial"
        : okCount > 0
          ? "success"
          : failCount > 0
            ? "failed"
            : "success";
    const retryText = retryCount > 0 ? ` (재시도 ${retryCount}회)` : "";

    try {
      await fetch("/api/notifications/automation-result", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          title: "최저가 갱신",
          status,
          summary: `총 ${checked}개 검사 · ${updated}개 가격변동${retryText}`,
          fields: [
            { name: "🔻 인하", value: `${down}개` },
            { name: "🔺 인상", value: `${up}개` },
            { name: "➖ 변동없음", value: `${unchanged}개` },
            { name: "🚫 품절", value: `${soldOut}개` },
            { name: "⚠️ 실패", value: `${failed}개` },
            { name: "🤖 봇차단", value: `${botBlocked}개` },
            ...(skipped > 0 ? [{ name: "⏭️ 제외(비지마켓)", value: `${skipped}개` }] : []),
          ],
        }),
      });
    } catch (err) {
      console.error("[scrape-prices] 디스코드 알림 발송 실패:", err instanceof Error ? err.message : String(err));
    }
  };

  const runScrapeRemoteOnce = async (
    ids: string[],
    abortController: AbortController,
  ): Promise<{
    changes: Array<{ id: string; name: string; previous: number; price: number }>;
    botBlocked: RetryItem[];
    failedItems: RetryItem[];
    soldOut: string[];
    skipped: number;
    stopped: boolean;
    statuses: Map<string, ScrapeStatusKey>;
  }> => {
    const changes: Array<{ id: string; name: string; previous: number; price: number }> = [];
    const botBlocked: RetryItem[] = [];
    const failedItems: RetryItem[] = [];
    const soldOut: string[] = [];
    // 이 라운드에서 처리된 각 상품의 최종 상태 (재시도 시 상위에서 병합)
    const statuses = new Map<string, ScrapeStatusKey>();
    let skipped = 0;
    let stopped = false;
    try {
      const res = await fetch("/api/products/scrape-prices-v2", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        // 재시도 라운드마다 발송하지 않고 마지막에 합산 1회만 발송
        body: JSON.stringify({ productIds: ids, notify: false }),
        signal: abortController.signal,
      });
      if (!res.ok || !res.body) {
        pushScrapeLog("최저가 수집 실패 (서버 응답 오류)");
        return { changes, botBlocked, failedItems, soldOut, skipped, stopped, statuses };
      }
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
              const failReasonText: Record<string, string> = {
                bot_blocked: "CF 차단",
                sold_out: "품절/판매종료",
                parse_failed: "가격 파싱 실패 (페이지 구조 변경)",
                network_error: "네트워크 오류",
                service_error: "수집 서비스 오류",
                unsupported: "지원하지 않는 상품",
              };
              const priceText = event.bot_blocked
                ? "CF 차단"
                : event.price > 0
                  ? event.price !== event.previous_price
                    ? `${event.previous_price.toLocaleString()}→${event.price.toLocaleString()}원`
                    : `${event.price.toLocaleString()}원 (변동없음)`
                  : (failReasonText[event.fail_reason] || "실패");
              pushScrapeLog(`(${event.index}/${event.total}) ${event.name} → ${priceText}`);
              const statusKey: "updated" | "unchanged" | "bot_blocked" | "failed" | "sold_out" = event.bot_blocked
                ? "bot_blocked"
                : event.price > 0
                  ? event.price !== event.previous_price ? "updated" : "unchanged"
                  : event.fail_reason === "sold_out" ? "sold_out" : "failed";
              statuses.set(event.id, statusKey);
              setScrapeStatus(prev => {
                const next = new Map(prev);
                next.set(event.id, statusKey);
                return next;
              });
              if (event.bot_blocked) {
                botBlocked.push({ id: event.id, name: event.name });
              } else if (event.price > 0) {
                changes.push({ id: event.id, name: event.name, previous: event.previous_price, price: event.price });
              } else if (statusKey === "sold_out") {
                soldOut.push(event.id);
              } else if (statusKey === "failed") {
                failedItems.push({ id: event.id, name: event.name });
              }
            } else if (event.type === "init") {
              pushScrapeLog(event.message);
            } else if (event.type === "done") {
              const blockedText = event.bot_blocked > 0 ? `, ${event.bot_blocked}개 CF차단` : "";
              const soldOutText = event.sold_out > 0 ? `, ${event.sold_out}개 품절` : "";
              const skippedText = event.skipped > 0 ? `, ${event.skipped}개 건너뜀(비지마켓)` : "";
              pushScrapeLog(`완료: ${event.updated}개 변동, ${event.unchanged ?? 0}개 변동없음, ${event.failed}개 실패${soldOutText}${blockedText}${skippedText}`);
              skipped = event.skipped ?? 0;
            } else if (event.type === "error") {
              pushScrapeLog(`오류: ${event.message}`);
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        stopped = true;
        pushScrapeLog(`중단됨: ${changes.length}개 수집 완료`);
      } else {
        pushScrapeLog("최저가 수집 중 오류 발생");
      }
    }
    return { changes, botBlocked, failedItems, soldOut, skipped, stopped, statuses };
  };

  const handleScrapePricesRemote = async (overrideIds?: string[]) => {
    const isRetry = !!(overrideIds && overrideIds.length > 0);
    const ids = isRetry
      ? overrideIds!
      : (selectedIds.size > 0
        ? [...selectedIds]
        : products.filter(p => p.purchase_url?.includes("gmarket.co.kr")).map(p => p.id));
    if (ids.length === 0) {
      alert("지마켓 상품이 없습니다. (v2는 지마켓부터 지원)");
      return;
    }
    const versionLabel = "고속 HTTP v2";
    if (!isRetry && !confirm(`${selectedIds.size > 0 ? `선택한 ${ids.length}개` : `전체 ${ids.length}개`} 상품의 최저가를 ${versionLabel}로 갱신하시겠습니까?`)) return;

    const abortController = new AbortController();
    scrapeAbortRef.current = abortController;
    setScrapingPrices(true);
    if (!isRetry) {
      setScrapeLog([`[v2] ${versionLabel} 최저가 수집 준비 중...`]);
      setScrapeResults([]);
      setScrapeSoldOutIds([]);
      setScrapeStatus(new Map());
      setScrapeTotal(ids.length);
    } else {
      pushScrapeLog(`재시도 대상 ${ids.length}개 다시 시도 중...`);
    }
    setScrapeLogCollapsed(false);
    setBotBlockedItems([]);

    const allChanges: Array<{ id: string; name: string; previous: number; price: number }> = [];
    const allSoldOut: string[] = [];
    // 재시도 라운드 간 상품별 최종 상태 병합 (나중 라운드가 이전 결과를 덮어씀)
    const finalStatus = new Map<string, ScrapeStatusKey>();
    let skippedCount = 0;
    let remainingRetryItems: RetryItem[] = [];
    let stopped = false;
    let retryCount = 0;

    try {
      let currentIds = ids;
      while (currentIds.length > 0) {
        if (retryCount > 0) {
          pushScrapeLog(`CF차단/실패 ${currentIds.length}개 자동 재시도 (${retryCount}회차)...`);
          await new Promise(r => setTimeout(r, 3000));
          if (abortController.signal.aborted) { stopped = true; break; }
        }
        const result = await runScrapeRemoteOnce(currentIds, abortController);
        allChanges.push(...result.changes);
        allSoldOut.push(...result.soldOut);
        for (const [id, st] of result.statuses) finalStatus.set(id, st);
        if (retryCount === 0) skippedCount = result.skipped;
        const retryMap = new Map<string, RetryItem>();
        for (const item of [...result.botBlocked, ...result.failedItems]) {
          retryMap.set(item.id, item);
        }
        remainingRetryItems = [...retryMap.values()];
        stopped = result.stopped;
        if (stopped || remainingRetryItems.length === 0) break;
        currentIds = remainingRetryItems.map(b => b.id);
        retryCount++;
      }
    } finally {
      scrapeAbortRef.current = null;
      setScrapingPrices(false);
      applySoldOutMargins(allChanges.map(c => c.id), allSoldOut);
      refetchPriceChanges();
      setScrapeSoldOutIds([...new Set(allSoldOut)]);
      if (allChanges.length > 0 || allSoldOut.length > 0) {
        setScrapeResults([...allChanges]);
        setScrapeResultModalOpen(true);
        setScrapeLogCollapsed(true);
      }
      if (remainingRetryItems.length > 0) {
        setBotBlockedItems(remainingRetryItems);
        pushScrapeLog(`CF차단/실패 ${remainingRetryItems.length}개 남음 (${retryCount}회 재시도 후) - 수동 재시도 가능`);
      } else if (retryCount > 0 && !stopped) {
        pushScrapeLog(`CF차단/실패 전체 해소 (${retryCount}회 재시도)`);
      }
      if (!stopped && allChanges.length === 0 && remainingRetryItems.length === 0) {
        setTimeout(() => setScrapeLog([]), 3000);
      }
      // 모든 재시도 종료 후 합산 결과로 디스코드 1회 발송
      await sendPriceScrapeNotify({ finalStatus, changes: allChanges, skipped: skippedCount, retryCount, stopped });
    }
  };

  const handleScrapePricesV2 = async (overrideIds?: string[]) => {
    await handleScrapePricesRemote(overrideIds);
  };


  const handleStopScrape = () => {
    scrapeAbortRef.current?.abort();
  };

  const handleResetPriceChanges = async () => {
    if (selectedIds.size === 0 || resettingPriceChanges) return;

    const ids = [...selectedIds];
    if (!confirm(`선택한 ${ids.length}개 상품의 전일 대비 표시값만 초기화할까요?\n최저가는 그대로 유지됩니다.`)) return;

    setScrapeDropdownOpen(false);
    setResettingPriceChanges(true);
    try {
      const resetPoint = new Date();
      resetPoint.setHours(0, 0, 0, 0);
      const res = await fetch("/api/products/price-history", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ productIds: ids, from: resetPoint.toISOString() }),
      });
      const json = await res.json() as { cleared?: number; error?: string };
      if (!res.ok) {
        alert(json.error ?? "전일 대비 초기화 실패");
        return;
      }
      refetchPriceChanges();
      setScrapeResultModalOpen(false);
      setScrapeResults([]);
      alert(`전일 대비 기록을 초기화했습니다. (${json.cleared ?? 0}건)`);
    } catch {
      alert("전일 대비 초기화 중 오류가 발생했습니다.");
    } finally {
      setResettingPriceChanges(false);
    }
  };

  const applyScrapePriceChanges = async () => {
    const changed = scrapeResults.filter(r => r.price !== r.previous);
    if (changed.length === 0) return true;

    setApplyingPrices(true);
    try {
      const res = await fetch("/api/products/apply-price-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          updates: changed.map(r => ({ id: r.id, price: r.price, previous_price: r.previous })),
          source: "impit_scrape",
        }),
      });
      const json = await res.json() as { applied?: number; error?: string };
      if (!res.ok) {
        alert(json.error ?? "가격 적용 실패");
        return false;
      }
      // 로컬 상태 반영
      startBatchUndo();
      for (const r of changed) {
        updateProduct(r.id, { lowest_price: r.price });
      }
      endBatchUndo();
      refetchPriceChanges();
      return true;
    } catch {
      alert("가격 적용 중 오류가 발생했습니다.");
      return false;
    } finally {
      setApplyingPrices(false);
    }
  };

  const handleApplyScrapeResults = async () => {
    const ok = await applyScrapePriceChanges();
    if (!ok) return;
    try {
      setScrapeResultModalOpen(false);
      setScrapeResults([]);
      setScrapeSoldOutIds([]);
      setScrapeLog([]);
    } catch {
      alert("가격 적용 중 오류가 발생했습니다.");
    }
  };

  // seller_code 사전 할당 (병렬 내보내기 전 1회 호출)
  const assignSellerCodes = async (ids: string[]) => {
    await fetch("/api/products/assign-seller-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ productIds: ids }),
    }).catch(() => {});
  };

  const handlePlayAutoExport = async (platform: PlayAutoExportPlatform) => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id);
    if (ids.length === 0) return;
    const batches = splitPlayAutoExportIds(ids, platform);
    setExportModalOpen(false);
    setExporting(true);
    setExportStep("판매자관리코드 할당 중...");
    await assignSellerCodes(ids);

    try {
      const warnings: ExportWarning[] = [];
      let startIndex = 0;
      for (const [batchIndex, batchIds] of batches.entries()) {
        setExportStep(`대량등록 엑셀 생성 중... (${batchIndex + 1}/${batches.length}, ${batchIds.length}개)`);
        const res = await fetch("/api/products/playauto-export", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ productIds: batchIds, platform, startIndex }),
        });
        const json = await res.json() as { base64?: string; filename?: string; error?: string; warnings?: ExportWarning[] };
        if (!res.ok || !json.base64 || !json.filename) {
          throw new Error(json.error ?? `${batchIndex + 1}번째 내보내기 실패`);
        }
        const filename = addPlayAutoBatchToFilename(json.filename, batchIndex, batches.length);
        downloadExcelFromBase64(json.base64, filename);
        saveToArchive(filename, json.base64, batchIds.length);
        warnings.push(...(json.warnings ?? []));
        startIndex += batchIds.length;
      }
      showExportWarnings(warnings);
    } catch (e) {
      alert(e instanceof Error ? e.message : "내보내기 중 오류가 발생했습니다.");
    } finally {
      setExporting(false);
      setExportStep("");
    }
  };

  // 쿠팡 필수옵션 누락 사전 경고 (업로드 시 "필수 추천 옵션" 오류 예방)
  const showExportWarnings = (warnings?: ExportWarning[]) => {
    if (!warnings || warnings.length === 0) return;
    const MAX = 15;
    const lines = warnings
      .slice(0, MAX)
      .map((w) => `· ${w.productName} → ${w.missing.join(", ")}`)
      .join("\n");
    const more = warnings.length > MAX ? `\n…외 ${warnings.length - MAX}개` : "";
    alert(
      `⚠️ 다음 ${warnings.length}개 상품은 쿠팡 필수옵션 값이 비어 있어 플레이오토 업로드 시 ` +
        `"필수 추천 옵션을 모두 선택해주세요" 오류가 날 수 있습니다.\n` +
        `상품명에 해당 정보(사이즈 등)를 보강한 뒤 다시 내보내세요.\n\n${lines}${more}`
    );
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

    const ids = selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id);
    if (ids.length === 0) { setExporting(false); setExportStep(""); return; }

    setExportStep("판매자관리코드 할당 중...");
    await assignSellerCodes(ids);

    try {
      for (const platform of platforms) {
        const batches = splitPlayAutoExportIds(ids, platform);
        const warnings: ExportWarning[] = [];
        let startIndex = 0;
        for (const [batchIndex, batchIds] of batches.entries()) {
          setExportStep(`${PLATFORM_CONFIGS[platform].filenameLabel} 대량등록 엑셀 생성 중... (${batchIndex + 1}/${batches.length}, ${batchIds.length}개)`);
          const res = await fetch("/api/products/playauto-export", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({ productIds: batchIds, platform, startIndex }),
          });
          const json = await res.json() as { base64?: string; filename?: string; error?: string; warnings?: ExportWarning[] };
          if (!res.ok || !json.base64 || !json.filename) {
            throw new Error(json.error ?? `${PLATFORM_CONFIGS[platform].filenameLabel} 내보내기 실패`);
          }
          const filename = addPlayAutoBatchToFilename(json.filename, batchIndex, batches.length);
          downloadExcelFromBase64(json.base64, filename);
          saveToArchive(filename, json.base64, batchIds.length);
          warnings.push(...(json.warnings ?? []));
          startIndex += batchIds.length;
        }
        showExportWarnings(warnings);
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "내보내기 중 오류가 발생했습니다.");
    } finally {
      setExporting(false);
      setExportStep("");
    }
  };

  const handlePlatformCodeFile = async (file: File, overwrite?: boolean) => {
    setImportingCodes(true);
    setPlatformCodeResult(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const res = await fetch("/api/products/import-platform-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ excelBase64: base64, overwrite }),
      });
      const json = await res.json() as { matched?: number; unmatched?: string[]; total?: number; ignored11st?: number; error?: string; confirmOverwrite?: boolean; duplicateCount?: number };
      if (!res.ok) {
        alert(json.error ?? "가져오기 실패");
        return;
      }
      // 중복 감지 → 사용자 확인 후 덮어쓰기 재요청
      if (json.confirmOverwrite && json.duplicateCount) {
        setImportingCodes(false);
        if (confirm(`${json.duplicateCount}개 상품에 기존 플레이오토 확인 정보가 있습니다.\n새 목록으로 확인 정보를 갱신할까요? 다른 판매처 정보는 유지됩니다.`)) {
          await handlePlatformCodeFile(file, true);
        }
        return;
      }
      setPlatformCodeResult({ matched: json.matched ?? 0, unmatched: json.unmatched ?? [], total: json.total ?? 0, ignored11st: json.ignored11st ?? 0 });
      await refetch();
    } catch {
          alert("플레이오토 임포트 확인 중 오류가 발생했습니다.");
    } finally {
      setImportingCodes(false);
    }
  };

  const handlePlatformCodeDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setPlatformCodeDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handlePlatformCodeFile(file);
  };

  const handlePriceUpdateV2Export = async (platform: "coupang" | "esm" | "smartstore") => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id);
    if (ids.length === 0) {
      alert("내보낼 상품이 없습니다.");
      return;
    }
    setExportModalOpen(false);
    setPriceUpdateV2Exporting(true);
    try {
      const msg = await exportPriceV2Platform(platform, ids, session?.access_token ?? "");
      if (msg) alert(msg);
    } catch (e) {
      alert(e instanceof Error ? e.message : "가격수정 v2 내보내기 중 오류");
    } finally {
      setPriceUpdateV2Exporting(false);
    }
  };

  // 가격수정 v2 — 쿠팡·옥션/지마켓·스마트스토어 한 번에 다운로드. 한 플랫폼이 실패해도 나머지는 진행
  const handlePriceUpdateV2ExportAll = async (overrideIds?: string[]) => {
    const ids = overrideIds ?? (selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id));
    if (ids.length === 0) {
      alert("내보낼 상품이 없습니다.");
      return;
    }
    setExportModalOpen(false);
    setPriceUpdateV2Exporting(true);
    try {
      const msgs = await exportPriceV2All(ids, session?.access_token ?? "");
      if (msgs.length) alert(msgs.join("\n"));
    } finally {
      setPriceUpdateV2Exporting(false);
    }
  };

  const handleScrapeResultV2ExportAll = async () => {
    if (scrapeExportTargetIds.length === 0) {
      alert("내보낼 변동/품절 상품이 없습니다.");
      return;
    }
    const ok = await applyScrapePriceChanges();
    if (!ok) return;
    // 품절 마진 자동 변경은 화면 저장 디바운스가 있어 잠깐 기다린 뒤 서버 엑셀을 생성한다.
    await new Promise(r => setTimeout(r, 250));
    await handlePriceUpdateV2ExportAll(scrapeExportTargetIds);
  };

  const handlePriceUpdateExport = async (target: PlayAutoExportPlatform | "all") => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : products.map(p => p.id);
    if (ids.length === 0) return;
    setExportModalOpen(false);
    setPriceUpdateExporting(true);
    setExportStep("판매자관리코드 할당 중...");
    await assignSellerCodes(ids);
    setExportStep("가격수정 엑셀 생성 중...");

    // 가격수정은 ESM을 옥션/지마켓 개별 파일로 분리 (11번가는 운영 제외)
    // priceUpdate=true 플래그로 서버에서 Gemini 호출 skip → 토큰 절감 + 대량 가능
    const platforms: PlayAutoExportPlatform[] = target === "all"
      ? ["smartstore", "auction", "gmarket", "coupang"]
      : [target];
    try {
      const results = await Promise.allSettled(
        platforms.map(async (platform) => {
          const res = await fetch("/api/products/playauto-export", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({ productIds: ids, platform, priceUpdate: true }),
          });
          const json = await res.json() as { base64?: string; filename?: string; error?: string; warnings?: ExportWarning[] };
          if (!res.ok || !json.base64 || !json.filename) {
            throw new Error(json.error ?? `${PLATFORM_CONFIGS[platform].filenameLabel} 가격수정 실패`);
          }
          return { platform, ...json } as { platform: PlayAutoExportPlatform; base64: string; filename: string; warnings?: ExportWarning[] };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          const fn = r.value.filename.replace("플레이오토_", "가격수정_");
          downloadExcelFromBase64(r.value.base64, fn);
          showExportWarnings(r.value.warnings);
        } else {
          alert(r.reason?.message ?? "가격수정 내보내기 실패");
        }
      }
    } catch {
      alert("가격수정 내보내기 중 오류가 발생했습니다.");
    } finally {
      setPriceUpdateExporting(false);
      setExportStep("");
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
      <div className="overflow-x-auto scrollbar-hide border-b border-[var(--border)]">
      <div className="flex items-center gap-1 min-w-max">
        <button onClick={() => handleTabChange("products")} className={TAB_CLASSES("products")}>
          <Package className="w-4 h-4" />
          상품 목록
        </button>
        <button onClick={() => handleTabChange("images")} className={TAB_CLASSES("images")}>
          <Images className="w-4 h-4" />
          이미지 관리
        </button>
        <button onClick={() => handleTabChange("commission")} className={TAB_CLASSES("commission")}>
          <Settings2 className="w-4 h-4" />
          수수료 설정
        </button>
        <button onClick={() => handleTabChange("smartstore-category")} className={TAB_CLASSES("smartstore-category")}>
          <LayoutList className="w-4 h-4" />
          플토 카테고리
        </button>
        <button onClick={() => handleTabChange("price-history")} className={TAB_CLASSES("price-history")}>
          <TrendingUp className="w-4 h-4" />
          가격 추이
        </button>
        <button onClick={() => handleTabChange("export-config")} className={TAB_CLASSES("export-config")}>
          <FileSpreadsheet className="w-4 h-4" />
          플토 양식
        </button>
      </div>
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
          <div className="flex flex-col gap-3">
            {/* 검색 */}
            <FilterBar
              search={search}
              onSearchChange={setSearch}
              onSearchSubmit={handleSearchSubmit}
              onSearchClear={handleSearchClear}
              placeholder="상품명, 카테고리 검색..."
            />

            {/* 버튼 그룹 */}
            <div className="flex items-center gap-2 flex-wrap">
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
                    onClick={() => setMarketplaceApiModal("coupang")}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors"
                  >
                    <PlugZap className="w-4 h-4" />
                    쿠팡 API 반영
                  </button>
                  <button
                    onClick={() => setMarketplaceApiModal("smartstore")}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm bg-green-600/20 text-green-400 hover:bg-green-600/30 rounded-lg transition-colors"
                  >
                    <PlugZap className="w-4 h-4" />
                    스토어 API 반영
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
                    onClick={() => setResetModalOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 rounded-lg transition-colors"
                  >
                    <Eraser className="w-4 h-4" />
                    등록정보 초기화
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
              <div className="relative flex">
                <button
                  onClick={() => handleScrapePricesV2()}
                  disabled={scrapingPrices}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 rounded-l-lg transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${scrapingPrices ? "animate-spin" : ""}`} />
                  {scrapingPrices ? "수집 중..." : `최저가 갱신${selectedIds.size > 0 ? ` ${selectedIds.size}개` : ""}`}
                </button>
                <button
                  onClick={() => !scrapingPrices && setScrapeDropdownOpen(v => !v)}
                  disabled={scrapingPrices}
                  className="flex items-center px-1.5 py-2 text-sm bg-cyan-600/20 text-cyan-400 hover:bg-cyan-600/30 rounded-r-lg border-l border-cyan-600/30 transition-colors disabled:opacity-50"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {scrapeDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setScrapeDropdownOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-50 w-52 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl overflow-hidden">
                      <button
                        onClick={handleResetPriceChanges}
                        disabled={selectedIds.size === 0 || resettingPriceChanges}
                        title={selectedIds.size === 0 ? "상품을 체크한 뒤 사용할 수 있습니다" : "선택 상품의 전일 대비 표시값만 초기화합니다"}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-amber-400 hover:bg-amber-600/10 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
                      >
                        <RotateCcw className={`w-3.5 h-3.5 ${resettingPriceChanges ? "animate-spin" : ""}`} />
                        {resettingPriceChanges ? "초기화 중..." : `전일 대비 초기화${selectedIds.size > 0 ? ` ${selectedIds.size}개` : ""}`}
                      </button>
                    </div>
                  </>
                )}
              </div>
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
                    <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl overflow-hidden max-h-[70vh] overflow-y-auto">
                      {/* 플레이오토 등록 (플랫폼 선택) */}
                      <button
                        onClick={() => setExpandedExportSection(expandedExportSection === "playauto" ? null : "playauto")}
                        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-violet-400 hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        {expandedExportSection === "playauto" ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        <FileSpreadsheet className="w-3 h-3" />
                        플랫폼 선택 (대량등록)
                      </button>
                      {expandedExportSection === "playauto" && (
                        <div>
                          <button onClick={() => handlePlayAutoExport("smartstore")} className="w-full flex items-center gap-2 px-3 pl-7 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                            <span className="w-2 h-2 rounded-full bg-green-400" /> 스마트스토어
                          </button>
                          <button onClick={() => handlePlayAutoExport("gmarket_auction")} className="w-full flex items-center gap-2 px-3 pl-7 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                            <span className="w-2 h-2 rounded-full bg-yellow-400" /> 지마켓·옥션
                          </button>
                          <button onClick={() => handlePlayAutoExport("coupang")} className="w-full flex items-center gap-2 px-3 pl-7 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                            <span className="w-2 h-2 rounded-full bg-red-400" /> 쿠팡
                          </button>
                          <button onClick={handleExportAll} className="w-full flex items-center gap-2 px-3 pl-7 py-2.5 text-sm text-violet-400 hover:bg-violet-600/10 transition-colors font-medium border-t border-[var(--border)]">
                            <FileSpreadsheet className="w-3.5 h-3.5" /> 전체 다운로드
                          </button>
                        </div>
                      )}
                      {/* 가격수정 v1 */}
                      <div className="border-t border-[var(--border)]">
                        <button
                          onClick={() => setExpandedExportSection(expandedExportSection === "v1" ? null : "v1")}
                          className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-orange-400 hover:bg-[var(--bg-hover)] transition-colors"
                        >
                          {expandedExportSection === "v1" ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          <TrendingUp className="w-3 h-3" />
                          가격수정 v1
                        </button>
                        {expandedExportSection === "v1" && (
                          <div>
                            <button onClick={() => handlePriceUpdateExport("smartstore")} disabled={priceUpdateExporting} className="w-full flex items-center gap-2 px-3 pl-7 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
                              <span className="w-2 h-2 rounded-full bg-green-400" /> 스마트스토어
                            </button>
                            <button onClick={() => handlePriceUpdateExport("auction")} disabled={priceUpdateExporting} className="w-full flex items-center gap-2 px-3 pl-7 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
                              <span className="w-2 h-2 rounded-full bg-yellow-400" /> 옥션
                            </button>
                            <button onClick={() => handlePriceUpdateExport("gmarket")} disabled={priceUpdateExporting} className="w-full flex items-center gap-2 px-3 pl-7 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
                              <span className="w-2 h-2 rounded-full bg-yellow-400" /> 지마켓
                            </button>
                            <button onClick={() => handlePriceUpdateExport("coupang")} disabled={priceUpdateExporting} className="w-full flex items-center gap-2 px-3 pl-7 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
                              <span className="w-2 h-2 rounded-full bg-red-400" /> 쿠팡
                            </button>
                            <button onClick={() => handlePriceUpdateExport("all")} disabled={priceUpdateExporting} className="w-full flex items-center gap-2 px-3 pl-7 py-2 text-sm text-orange-400 hover:bg-orange-600/10 transition-colors font-medium disabled:opacity-50 border-t border-[var(--border)]">
                              <TrendingUp className="w-3.5 h-3.5" /> {priceUpdateExporting ? "생성 중..." : "전체 다운로드"}
                            </button>
                          </div>
                        )}
                      </div>
                      {/* 가격수정 v2 */}
                      <div className="border-t border-[var(--border)]">
                        <button
                          onClick={() => setExpandedExportSection(expandedExportSection === "v2" ? null : "v2")}
                          className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-orange-400 hover:bg-[var(--bg-hover)] transition-colors"
                        >
                          {expandedExportSection === "v2" ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          <TrendingUp className="w-3 h-3" />
                          가격수정 v2 (플랫폼 양식)
                        </button>
                        {expandedExportSection === "v2" && (
                          <div>
                            {/* 임포트 (양식 가져오기) */}
                            <button
                              onClick={() => setExpandedV2Section(expandedV2Section === "import" ? null : "import")}
                              className="w-full flex items-center gap-1.5 px-3 pl-5 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                            >
                              {expandedV2Section === "import" ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              <Upload className="w-3 h-3" />
                              양식 임포트
                            </button>
                            {expandedV2Section === "import" && (
                              <div>
                                <button onClick={() => { setExportModalOpen(false); setCoupangImportModalOpen(true); }} className="w-full flex items-center gap-2 px-3 pl-9 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                                  <Upload className="w-3.5 h-3.5" /> 쿠팡 양식 임포트
                                </button>
                                <button onClick={() => { setExportModalOpen(false); setEsmImportModalOpen(true); }} className="w-full flex items-center gap-2 px-3 pl-9 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                                  <Upload className="w-3.5 h-3.5" /> 옥션·지마켓 상품목록 임포트
                                </button>
                                <button onClick={() => { setExportModalOpen(false); setSmartstoreImportModalOpen(true); }} className="w-full flex items-center gap-2 px-3 pl-9 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                                  <Upload className="w-3.5 h-3.5" /> 스마트스토어 일괄수정 임포트
                                </button>
                              </div>
                            )}
                            {/* 대량수정 (가격수정 엑셀 다운로드) */}
                            <button
                              onClick={() => setExpandedV2Section(expandedV2Section === "export" ? null : "export")}
                              className="w-full flex items-center gap-1.5 px-3 pl-5 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors border-t border-[var(--border)]"
                            >
                              {expandedV2Section === "export" ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              <FileSpreadsheet className="w-3 h-3" />
                              대량수정 다운로드
                            </button>
                            {expandedV2Section === "export" && (
                              <div>
                                <button onClick={() => handlePriceUpdateV2Export("coupang")} disabled={priceUpdateV2Exporting} className="w-full flex items-center gap-2 px-3 pl-9 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
                                  <span className="w-2 h-2 rounded-full bg-red-400" /> {priceUpdateV2Exporting ? "생성 중..." : "쿠팡"}
                                </button>
                                <button onClick={() => handlePriceUpdateV2Export("esm")} disabled={priceUpdateV2Exporting} className="w-full flex items-center gap-2 px-3 pl-9 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
                                  <span className="w-2 h-2 rounded-full bg-yellow-400" /> {priceUpdateV2Exporting ? "생성 중..." : "옥션·지마켓"}
                                </button>
                                <button onClick={() => handlePriceUpdateV2Export("smartstore")} disabled={priceUpdateV2Exporting} className="w-full flex items-center gap-2 px-3 pl-9 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
                                  <span className="w-2 h-2 rounded-full bg-green-400" /> {priceUpdateV2Exporting ? "생성 중..." : "스마트스토어"}
                                </button>
                                <button onClick={() => handlePriceUpdateV2ExportAll()} disabled={priceUpdateV2Exporting} className="w-full flex items-center gap-2 px-3 pl-9 py-2 text-sm text-orange-400 hover:bg-orange-600/10 transition-colors font-medium disabled:opacity-50 border-t border-[var(--border)]">
                                  <FileSpreadsheet className="w-3.5 h-3.5" /> {priceUpdateV2Exporting ? "생성 중..." : "전체엑셀 다운로드"}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={() => { setPlatformCodeModalOpen(true); setPlatformCodeResult(null); }}
                disabled={importingCodes}
                className="flex items-center gap-1.5 px-3 py-2 text-sm bg-orange-600/20 text-orange-400 hover:bg-orange-600/30 rounded-lg transition-colors disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                {importingCodes ? "확인 중..." : "플레이오토 임포트 확인"}
              </button>
              <button
                onClick={() => gmarketImport.open({
                  categories,
                  existingUrls: new Set(allProducts.map(p => p.purchase_url).filter((u): u is string => Boolean(u))),
                })}
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

          {products.length === 0 && allProducts.length > 0 && hasActiveListFilters && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
              <span className="text-amber-200">
                저장된 검색 또는 필터 때문에 표시되는 상품이 없습니다. 전체 상품은 {allProducts.length.toLocaleString("ko-KR")}건입니다.
              </span>
              <button
                onClick={handleResetListFilters}
                className="shrink-0 px-3 py-1.5 rounded-md bg-amber-500/20 text-amber-100 hover:bg-amber-500/30 transition-colors"
              >
                필터 초기화
              </button>
            </div>
          )}

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
            priceScrapeStatus={priceScrapeStatus}
            priceChangeFilter={priceChangeFilter}
            onPriceChangeFilterChange={setPriceChangeFilter}
            onBulkMarginApply={handleBulkMarginChange}
          />
        </>
      )}

      {/* 플레이오토 상품 목록 임포트 확인 모달 */}
      {platformCodeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => !importingCodes && setPlatformCodeModalOpen(false)} />
          <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">플레이오토 임포트 확인</h3>
            <p className="text-xs text-[var(--text-muted)] mb-4">플레이오토에서 내려받은 상품 목록 엑셀을 올리면, 목록에서 임포트 여부를 확인할 수 있습니다.</p>

            {platformCodeResult ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-green-400">
                  <FileSpreadsheet className="w-5 h-5" />
                  <span className="text-sm font-medium">임포트 확인 완료</span>
                </div>
                <div className="text-sm text-[var(--text-secondary)] space-y-1">
                  <p>전체 <strong>{platformCodeResult.total}</strong>행 중 <strong className="text-green-400">{platformCodeResult.matched}</strong>개 상품 임포트 확인</p>
                  {(platformCodeResult.ignored11st ?? 0) > 0 && (
                    <p className="text-xs text-[var(--text-muted)]">11번가 {platformCodeResult.ignored11st}행은 운영 제외 기준으로 건너뜀</p>
                  )}
                  {platformCodeResult.unmatched.length > 0 && (
                    <div className="mt-2">
                      <p className="text-orange-400 text-xs mb-1">미매칭 상품 ({platformCodeResult.unmatched.length}개):</p>
                      <div className="max-h-32 overflow-y-auto text-xs text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded-lg p-2 space-y-0.5">
                        {platformCodeResult.unmatched.slice(0, 20).map((name, i) => (
                          <p key={i}>{name}</p>
                        ))}
                        {platformCodeResult.unmatched.length > 20 && <p>... 외 {platformCodeResult.unmatched.length - 20}개</p>}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setPlatformCodeModalOpen(false)}
                  className="w-full mt-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  확인
                </button>
              </div>
            ) : importingCodes ? (
              <div className="flex flex-col items-center py-12">
                <div className="w-8 h-8 border-2 border-orange-400 border-t-transparent rounded-full animate-spin mb-3" />
                <p className="text-sm text-[var(--text-secondary)]">플랫폼 코드 가져오는 중...</p>
              </div>
            ) : (
              <>
                <div
                  onDragOver={(e) => { e.preventDefault(); setPlatformCodeDragOver(true); }}
                  onDragLeave={() => setPlatformCodeDragOver(false)}
                  onDrop={handlePlatformCodeDrop}
                  onClick={() => platformCodeFileRef.current?.click()}
                  className={`
                    flex flex-col items-center justify-center py-16 border-2 border-dashed rounded-xl cursor-pointer transition-colors
                    ${platformCodeDragOver ? "border-orange-400 bg-orange-500/10" : "border-[var(--border-strong)] hover:border-[var(--border-strong)] bg-[var(--bg-hover)]"}
                  `}
                >
                  <Upload className="w-10 h-10 text-[var(--text-muted)] mb-3" />
                  <p className="text-[var(--text-tertiary)] text-sm">엑셀 파일을 드래그하거나 클릭해서 선택</p>
                  <p className="text-[var(--text-muted)] text-xs mt-1">플레이오토 상품 엑셀 (.xlsx, .xls)</p>
                </div>
                <input
                  ref={platformCodeFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handlePlatformCodeFile(file);
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* 최저가 갱신 결과 모달 */}
      {scrapeResultModalOpen && (scrapeResults.length > 0 || scrapeSoldOutItems.length > 0) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setScrapeResultModalOpen(false)} />
          <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">최저가 갱신 결과</h3>
            <p className="text-xs text-[var(--text-muted)] mb-4">
              확인 {scrapeStats.processed || scrapeResults.length + scrapeSoldOutItems.length}개 · <span className="text-orange-400">변동 {changedScrapeCount}개</span> · 변동없음 {scrapeStats.unchanged || scrapeResults.length - changedScrapeCount}개 · <span className="text-yellow-400">품절 {scrapeSoldOutItems.length}개</span> · 봇감지 {scrapeStats.botBlocked}개 · 실패 {scrapeStats.failed}개
            </p>
            <div className="max-h-80 overflow-y-auto space-y-1.5 mb-4">
              {sortedScrapeResults.map((r) => {
                const diff = r.price - r.previous;
                const isChanged = diff !== 0;
                const isUp = diff > 0;
                return (
                  <div key={r.id} className={`flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] ${isChanged ? "" : "opacity-50"}`}>
                    <span className="text-sm text-[var(--text-primary)] truncate flex-1 mr-3">{r.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {isChanged ? (
                        <>
                          <span className="text-xs text-[var(--text-muted)]">{r.previous.toLocaleString()}</span>
                          <span className="text-xs text-[var(--text-muted)]">→</span>
                          <span className={`text-xs font-medium ${isUp ? "text-red-400" : "text-blue-400"}`}>
                            {r.price.toLocaleString()}
                          </span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${isUp ? "bg-red-500/10 text-red-400" : "bg-blue-500/10 text-blue-400"}`}>
                            {isUp ? "▲" : "▼"}{Math.abs(diff).toLocaleString()}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)]">{r.price.toLocaleString()}원 (변동없음)</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {scrapeSoldOutItems.map((item) => (
                <div key={`soldout-${item.id}`} className="flex items-center justify-between px-3 py-2 rounded-lg bg-yellow-500/10">
                  <span className="text-sm text-[var(--text-primary)] truncate flex-1 mr-3">{item.name}</span>
                  <span className="text-xs font-medium text-yellow-400 shrink-0">품절 · 순마진율 35%</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                onClick={() => { setScrapeResultModalOpen(false); setScrapeResults([]); setScrapeSoldOutIds([]); setScrapeLog([]); }}
                className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                닫기
              </button>
              {changedScrapeCount > 0 && (
                <button
                  onClick={handleApplyScrapeResults}
                  disabled={applyingPrices}
                  className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                >
                  {applyingPrices ? "적용 중..." : `적용하기 (${changedScrapeCount}개)`}
                </button>
              )}
              <button
                onClick={handleScrapeResultV2ExportAll}
                disabled={applyingPrices || priceUpdateV2Exporting || scrapeExportTargetIds.length === 0}
                className="sm:col-span-2 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors disabled:opacity-50"
              >
                <FileSpreadsheet className="w-4 h-4" />
                {priceUpdateV2Exporting ? "엑셀 생성 중..." : `각수정 v2 전체엑셀 다운로드 (${scrapeExportTargetIds.length}개)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 지마켓 가져오기 모달은 레이아웃의 GmarketImportHost에서 렌더 (백그라운드 유지) */}

      {/* 쿠팡 가격수정 v2 양식 임포트 모달 */}
      {coupangImportModalOpen && (
        <CoupangPriceImportModal onClose={() => setCoupangImportModalOpen(false)} onImported={() => refetch()} />
      )}

      {/* 옥션·지마켓 가격수정 v2 상품목록 임포트 모달 */}
      {esmImportModalOpen && (
        <EsmPriceImportModal onClose={() => setEsmImportModalOpen(false)} onImported={() => refetch()} />
      )}

      {/* 스마트스토어 가격수정 v2 일괄수정 양식 임포트 모달 */}
      {smartstoreImportModalOpen && (
        <SmartstorePriceImportModal onClose={() => setSmartstoreImportModalOpen(false)} />
      )}

      {marketplaceApiModal && (
        <MarketplaceApiModal platform={marketplaceApiModal} productIds={[...selectedIds]} onClose={() => setMarketplaceApiModal(null)} />
      )}

      {/* 등록정보 초기화 모달 */}
      {resetModalOpen && (
        <RegistrationResetModal
          selectedCount={selectedIds.size}
          onClose={() => setResetModalOpen(false)}
          onReset={(fields) => resetProductFields([...selectedIds], fields)}
        />
      )}

      {/* 상세페이지 일괄 생성 모달 */}
      {batchVisible && (
        <BatchDetailModal items={batchItems} onClose={dismissBatch} onClear={clearBatch} />
      )}

      {(scrapingPrices || scrapeLog.length > 0 || botBlockedItems.length > 0) && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-[min(480px,calc(100vw-24px))] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-lg overflow-hidden">
          <div
            className={`flex items-center justify-between gap-3 px-4 py-2.5 ${scrapeLogCollapsed ? "" : "border-b border-[var(--border)]"}`}
          >
            <button
              type="button"
              onClick={() => setScrapeLogCollapsed(v => !v)}
              className="flex flex-col gap-0.5 flex-1 min-w-0 text-left"
              aria-expanded={!scrapeLogCollapsed}
              aria-label={scrapeLogCollapsed ? "최저가 수집 로그 펼치기" : "최저가 수집 로그 접기"}
            >
              <div className="flex items-center gap-2 min-w-0">
                {scrapingPrices && <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />}
                <span className="text-sm font-medium text-[var(--text-primary)]">최저가 수집</span>
                {scrapeTotal > 0 && (
                  <span className="text-xs text-[var(--text-muted)] shrink-0 tabular-nums">
                    {scrapeStats.processed}/{scrapeTotal}
                  </span>
                )}
                {scrapeLogCollapsed && scrapeLog.length > 0 && (
                  <span className="text-xs text-[var(--text-muted)] truncate ml-1">
                    {scrapeLog[scrapeLog.length - 1]}
                  </span>
                )}
              </div>
              {scrapeStats.processed > 0 && (
                <div className="flex items-center gap-2 text-[11px] tabular-nums pl-0">
                  <span className="text-emerald-400">변동 {scrapeStats.updated}</span>
                  <span className="text-[var(--text-muted)]">·</span>
                  <span className="text-[var(--text-secondary)]">변동없음 {scrapeStats.unchanged}</span>
                  <span className="text-[var(--text-muted)]">·</span>
                  <span className="text-orange-400">봇감지 {scrapeStats.botBlocked}</span>
                  <span className="text-[var(--text-muted)]">·</span>
                  <span className="text-yellow-400">품절 {scrapeStats.soldOut}</span>
                  <span className="text-[var(--text-muted)]">·</span>
                  <span className="text-red-400">실패 {scrapeStats.failed}</span>
                </div>
              )}
            </button>
            <div className="flex items-center gap-1.5 shrink-0">
              {scrapingPrices && (
                <button
                  onClick={handleStopScrape}
                  className="px-2.5 py-1 min-h-[32px] text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors"
                >
                  중단
                </button>
              )}
              {!scrapingPrices && botBlockedItems.length > 0 && (
                <>
                  <button
                    onClick={() => handleScrapePricesV2(botBlockedItems.map(b => b.id))}
                    className="flex items-center gap-1 px-2.5 py-1 min-h-[32px] text-xs font-medium text-orange-400 bg-orange-500/10 hover:bg-orange-500/20 rounded-lg transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    다시 시도
                  </button>
                  <button
                    onClick={() => { setBotBlockedItems([]); setScrapeLog([]); setScrapeStatus(new Map()); setScrapeTotal(0); }}
                    className="px-2 py-1 min-h-[32px] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-lg transition-colors"
                    aria-label="재시도 목록 닫기"
                  >
                    닫기
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setScrapeLogCollapsed(v => !v)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                aria-label={scrapeLogCollapsed ? "펼치기" : "접기"}
              >
                {scrapeLogCollapsed
                  ? <ChevronUp className="w-4 h-4" />
                  : <ChevronDown className="w-4 h-4" />
                }
              </button>
            </div>
          </div>
          {!scrapeLogCollapsed && (
            <div
              ref={scrapeLogRef}
              className="max-h-[40vh] overflow-y-auto px-4 py-2 space-y-0.5"
            >
              {scrapeLog.map((line, i) => (
                <p key={i} className="text-xs text-[var(--text-secondary)] leading-relaxed">{line}</p>
              ))}
            </div>
          )}
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
