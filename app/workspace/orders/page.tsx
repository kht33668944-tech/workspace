"use client";

import { useState, useMemo, useCallback, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { usePreventBrowserSave } from "@/hooks/use-prevent-browser-save";
import { FileSpreadsheet, Trash2, Download, Calendar, Truck, ChevronDown, ShoppingCart, History, Zap, MessageSquare, RefreshCw } from "lucide-react";
import PurchaseLogTab from "@/components/workspace/orders/purchase-log-tab";
import TrackingLogTab from "@/components/workspace/orders/tracking-log-tab";
import { useOrders } from "@/hooks/use-orders";
import { useAuth } from "@/context/AuthContext";
import { exportOrdersToCSV } from "@/lib/excel-parser";
import { generatePlayAutoTrackingExcel, downloadExcel, arrayBufferToBase64 } from "@/lib/excel-export";
import { DEFAULT_COURIER_CODES } from "@/lib/courier-codes";
import { formatKoreanDateTime, getKoreanMonthKey } from "@/lib/date-utils";
import { rememberWorkspaceHref, replaceUrlParams } from "@/lib/view-state";
import { supabase } from "@/lib/supabase";
import OrderTable from "@/components/workspace/orders/order-table";
import OrderModal from "@/components/workspace/orders/order-modal";
import OrderSidePanel, { OrderSidePanelContent } from "@/components/workspace/orders/order-side-panel";
import BulkEditBar from "@/components/workspace/orders/bulk-edit-bar";
import FilterBar from "@/components/ui/filter-bar";
import MobileSheet from "@/components/ui/mobile-sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import dynamic from "next/dynamic";

const ExcelImport = dynamic(() => import("@/components/workspace/orders/excel-import"), { ssr: false });
const SettlementImportModal = dynamic(() => import("@/components/workspace/orders/settlement-import-modal"), { ssr: false });
const BulkSmsModal = dynamic(() => import("@/components/workspace/orders/bulk-sms-modal"), { ssr: false });
import { useToast } from "@/context/ToastContext";
import { useAutoPurchaseController, useTrackingCollectController } from "@/context/modal-controllers";
import type { Order, OrderInsert } from "@/types/database";

const MARKETPLACE_OPTIONS = ["전체", "쿠팡", "스마트스토어", "지마켓", "옥션", "11번가"];

const FILTER_STORAGE_KEY = "orders-filter-state";
type OrdersTab = "orders" | "logs" | "tracking-logs";
type ProductCostRow = {
  id: string;
  product_name: string | null;
  purchase_url: string | null;
  lowest_price: number | null;
};

type CostRefreshResult = {
  productId: string;
  productName: string;
  previous: number;
  price: number;
  orderCount: number;
};

type CostRetryItem = { id: string; name: string };

type CostScrapeEvent =
  | {
      type: "progress";
      id: string;
      name: string;
      price: number;
      previous_price: number;
      index: number;
      total: number;
      bot_blocked?: boolean;
      fail_reason?: string | null;
    }
  | { type: "done"; updated: number; failed: number; unchanged?: number; bot_blocked: number; sold_out: number }
  | { type: "error"; message: string };

const MAX_COST_REFRESH_ATTEMPTS = 5;

function normalizeProductNameForMatch(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function isSupportedCostRefreshUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes("gmarket.co.kr") || url.includes("ohou.se") || url.includes("ohouse");
}

async function fetchProductCostRows(userId: string): Promise<ProductCostRow[]> {
  const PAGE_SIZE = 1000;
  const rows: ProductCostRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select("id, product_name, purchase_url, lowest_price")
      .eq("user_id", userId)
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    rows.push(...(data as ProductCostRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

interface FilterState {
  tab: OrdersTab;
  month: string | null;
  marketplace: string | null;
  search: string;
  dateFrom: string | null;
  dateTo: string | null;
  columnFilters: Record<string, string[]>;
}

function saveFilterState(state: FilterState) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
    sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
  } catch { /* 무시 */ }
}


function loadFilterState(): FilterState | null {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY) ?? sessionStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as FilterState;
  } catch {
    return null;
  }
}

// 현재 연도 기준 12개월 생성
function generateMonthOptions(): string[] {
  const now = new Date();
  const year = now.getFullYear();
  const result: string[] = [];
  for (let m = 1; m <= 12; m++) {
    result.push(`${year}-${String(m).padStart(2, "0")}`);
  }
  return result;
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[50vh] text-[var(--text-secondary)]">로딩 중...</div>}>
      <OrdersPageInner />
    </Suspense>
  );
}

function OrdersPageInner() {
  usePreventBrowserSave();
  const { user, session } = useAuth();
  const { showToast } = useToast();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const activeMonthRef = useRef<HTMLButtonElement>(null);
  const monthScrollRef = useRef<HTMLDivElement>(null);
  // 필터/탭 상태를 저장소와 URL에서 복원
  const saved = useMemo(() => loadFilterState(), []);
  const queryMonth = searchParams.get("month");
  const queryMarketplace = searchParams.get("marketplace");
  const querySearch = searchParams.get("search");
  const queryDateFrom = searchParams.get("dateFrom");
  const queryDateTo = searchParams.get("dateTo");
  const [selectedMonth, setSelectedMonth] = useState<string | null>(queryMonth ?? saved?.month ?? getCurrentMonth());
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(queryMarketplace ?? saved?.marketplace ?? null);
  const [selectedDateFrom, setSelectedDateFrom] = useState<string | null>(queryDateFrom ?? saved?.dateFrom ?? null);
  const [selectedDateTo, setSelectedDateTo] = useState<string | null>(queryDateTo ?? saved?.dateTo ?? null);
  const [search, setSearch] = useState(querySearch ?? saved?.search ?? "");
  const [activeSearch, setActiveSearch] = useState(querySearch ?? saved?.search ?? "");
  const [showImport, setShowImport] = useState(false);
  const [showSettlementImport, setShowSettlementImport] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [columnFilters, setColumnFilters] = useState<Record<string, string[]>>(saved?.columnFilters ?? {});
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [sidePanelOrder, setSidePanelOrder] = useState<Order | null>(null);
  const [showBulkSms, setShowBulkSms] = useState(false);
  const autoPurchase = useAutoPurchaseController();
  const trackingCollect = useTrackingCollectController();
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showAutoMenu, setShowAutoMenu] = useState(false);
  const [courierCodeMap, setCourierCodeMap] = useState<Record<string, number>>(DEFAULT_COURIER_CODES);
  const [refreshingCosts, setRefreshingCosts] = useState(false);
  const [costRefreshLog, setCostRefreshLog] = useState<string[]>([]);
  const [costRefreshTotal, setCostRefreshTotal] = useState(0);
  const [costRefreshProcessed, setCostRefreshProcessed] = useState(0);
  const [costRefreshCollapsed, setCostRefreshCollapsed] = useState(false);
  const costRefreshAbortRef = useRef<AbortController | null>(null);
  const costRefreshGroupsRef = useRef<Map<string, { product: ProductCostRow; orders: Order[] }>>(new Map());
  const [costRefreshResults, setCostRefreshResults] = useState<CostRefreshResult[]>([]);
  const [costRefreshResultOpen, setCostRefreshResultOpen] = useState(false);
  const [applyingCostRefresh, setApplyingCostRefresh] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const autoMenuRef = useRef<HTMLDivElement>(null);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const urlTab = searchParams.get("tab") as OrdersTab | null;
  const activeBatchId = searchParams.get("batch");
  const initialTab: OrdersTab = urlTab === "orders" || urlTab === "logs" || urlTab === "tracking-logs"
    ? urlTab
    : saved?.tab ?? "orders";
  const [activeTab, setActiveTab] = useState<OrdersTab>(initialTab);

  // 필터/탭 상태 변경 시 저장소와 URL에 저장
  useEffect(() => {
    saveFilterState({
      tab: activeTab,
      month: selectedMonth,
      marketplace: selectedMarketplace,
      search: activeSearch,
      dateFrom: selectedDateFrom,
      dateTo: selectedDateTo,
      columnFilters,
    });
    replaceUrlParams({
      tab: activeTab,
      month: selectedMonth,
      marketplace: selectedMarketplace,
      search: activeSearch || null,
      dateFrom: selectedDateFrom,
      dateTo: selectedDateTo,
    });
    rememberWorkspaceHref("/workspace/orders");
  }, [activeTab, selectedMonth, selectedMarketplace, activeSearch, selectedDateFrom, selectedDateTo, columnFilters]);

  const monthMountedRef = useRef(false);
  useEffect(() => {
    if (!monthMountedRef.current) {
      monthMountedRef.current = true;
      return;
    }
    activeMonthRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [selectedMonth]);

  const monthOptions = useMemo(() => generateMonthOptions(), []);

  // 택배사 코드 로드
  useEffect(() => {
    if (!session?.access_token) return;
    fetch("/api/courier-codes", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data && Array.isArray(data) && data.length > 0) {
          // 기본값과 병합 (DB 커스텀 코드가 기본값을 덮어씀)
          const map: Record<string, number> = { ...DEFAULT_COURIER_CODES };
          for (const c of data) map[c.courier_name] = c.courier_code;
          setCourierCodeMap(map);
        }
      })
      .catch(() => {});
  }, [session?.access_token]);

  // 드롭다운 메뉴 외부 클릭 닫기
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (autoMenuRef.current && !autoMenuRef.current.contains(e.target as Node)) {
        setShowAutoMenu(false);
      }
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) {
        setShowImportMenu(false);
      }
    };
    if (showExportMenu || showAutoMenu || showImportMenu) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showExportMenu, showAutoMenu, showImportMenu]);

  const handleSearchClear = () => {
    setSearch("");
    setActiveSearch("");
  };
  const handleTabChange = (tab: OrdersTab) => {
    setActiveTab(tab);
    setSelectedIds(new Set());
  };


  const handleMonthChange = (month: string | null) => {
    setSelectedMonth(month);
    // 날짜 필터가 새 월에 속하지 않으면 초기화
    if (month) {
      if (selectedDateFrom && !selectedDateFrom.startsWith(month)) {
        setSelectedDateFrom(null);
        setSelectedDateTo(null);
      }
    }
  };

  const handleDateFromChange = (date: string) => {
    if (!date) {
      setSelectedDateFrom(null);
      setSelectedDateTo(null);
      return;
    }
    const month = date.slice(0, 7);
    if (month !== selectedMonth) setSelectedMonth(month);
    setSelectedDateFrom(date);
    // dateTo가 dateFrom보다 앞이면 초기화
    if (selectedDateTo && selectedDateTo < date) setSelectedDateTo(null);
  };

  const handleDateToChange = (date: string) => {
    if (!date) { setSelectedDateTo(null); return; }
    // dateTo가 다른 월이면 month를 null로 (전체)
    if (selectedDateFrom) {
      const fromMonth = selectedDateFrom.slice(0, 7);
      const toMonth = date.slice(0, 7);
      if (fromMonth !== toMonth) setSelectedMonth(null);
    }
    setSelectedDateTo(date);
  };

  const clearDateFilter = () => {
    setSelectedDateFrom(null);
    setSelectedDateTo(null);
  };

  const { orders, allOrders, loading, months, checkDuplicates, insertOrders, updateOrder, flushPendingUpdates, getOrdersByIds, deleteOrders, undo, startBatchUndo, endBatchUndo, refetch } = useOrders({
    month: selectedMonth,
    marketplace: selectedMarketplace,
    search: activeSearch,
    dateFrom: selectedDateFrom,
    dateTo: selectedDateTo,
    columnFilters,
  });
  const getLatestSelectedOrders = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return [];

    await flushPendingUpdates();
    const latestOrders = await getOrdersByIds(ids);
    if (latestOrders.length > 0) return latestOrders;

    return orders.filter((o) => selectedIds.has(o.id));
  }, [flushPendingUpdates, getOrdersByIds, orders, selectedIds]);

  const handleOpenAutoPurchase = useCallback(async () => {
    setShowAutoMenu(false);
    const selectedOrders = await getLatestSelectedOrders();
    autoPurchase.open({ orders: selectedOrders });
  }, [autoPurchase, getLatestSelectedOrders]);

  const handleOpenTrackingCollect = useCallback(async () => {
    setShowAutoMenu(false);
    const selectedOrders = await getLatestSelectedOrders();
    trackingCollect.open({ orders: selectedOrders, courierCodeMap });
  }, [courierCodeMap, getLatestSelectedOrders, trackingCollect]);
  const pushCostRefreshLog = useCallback((message: string) => {
    setCostRefreshLog((prev) => [...prev.slice(-80), message]);
  }, []);

  const runCostRefreshOnce = useCallback(async (
    productIds: string[],
    productNames: Map<string, string>,
    abortController: AbortController,
  ): Promise<{ successes: CostRefreshResult[]; botBlocked: CostRetryItem[]; stopped: boolean }> => {
    const successes: CostRefreshResult[] = [];
    const botBlocked: CostRetryItem[] = [];
    let stopped = false;

    try {
      const res = await fetch("/api/products/scrape-prices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ productIds }),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) {
        pushCostRefreshLog("원가 수집 실패 (서버 응답 오류)");
        return { successes, botBlocked, stopped };
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
            const event = JSON.parse(data) as CostScrapeEvent;
            if (event.type === "progress") {
              setCostRefreshProcessed(event.index);

              const failReasonText: Record<string, string> = {
                bot_blocked: "봇 감지",
                sold_out: "품절/판매종료",
                timeout: "페이지 로딩 타임아웃",
                selector_changed: "가격 추출 실패",
                network_error: "네트워크 오류",
              };
              const priceText = event.bot_blocked
                ? "봇 감지"
                : event.price > 0
                  ? event.price !== event.previous_price
                    ? `${event.previous_price.toLocaleString()}→${event.price.toLocaleString()}원`
                    : `${event.price.toLocaleString()}원 (변동없음)`
                  : (failReasonText[event.fail_reason ?? ""] || "실패");

              pushCostRefreshLog(`(${event.index}/${event.total}) ${event.name} → ${priceText}`);

              if (event.bot_blocked) {
                botBlocked.push({ id: event.id, name: event.name });
              } else if (event.price > 0) {
                successes.push({
                  productId: event.id,
                  productName: productNames.get(event.id) ?? event.name,
                  previous: event.previous_price,
                  price: event.price,
                  orderCount: 0,
                });
              }
            } else if (event.type === "done") {
              const blockedText = event.bot_blocked > 0 ? `, ${event.bot_blocked}개 봇감지` : "";
              const soldOutText = event.sold_out > 0 ? `, ${event.sold_out}개 품절` : "";
              pushCostRefreshLog(`수집 완료: ${event.updated}개 변동, ${event.unchanged ?? 0}개 변동없음, ${event.failed}개 실패${soldOutText}${blockedText}`);
            } else if (event.type === "error") {
              pushCostRefreshLog(`오류: ${event.message}`);
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        stopped = true;
        pushCostRefreshLog(`중단됨: 지금까지 성공한 상품 ${successes.length}개를 확인 후 적용할 수 있습니다.`);
      } else {
        pushCostRefreshLog("원가 수집 중 오류 발생");
      }
    }

    return { successes, botBlocked, stopped };
  }, [pushCostRefreshLog, session?.access_token]);

  const applyCostRefreshResults = useCallback(async (
    results: CostRefreshResult[],
    groups: Map<string, { product: ProductCostRow; orders: Order[] }>,
  ) => {
    if (results.length === 0) return { productCount: 0, orderCount: 0 };

    const changed = results.filter((r) => r.price !== r.previous);
    for (let i = 0; i < changed.length; i += 500) {
      const batch = changed.slice(i, i + 500);
      const res = await fetch("/api/products/apply-price-updates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          updates: batch.map((r) => ({ id: r.productId, price: r.price, previous_price: r.previous })),
          source: "scrape",
        }),
      });
      const json = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "상품소싱 최저가 적용 실패");
    }

    let updatedOrders = 0;
    startBatchUndo();
    try {
      const saves: Promise<void>[] = [];
      for (const result of results) {
        const group = groups.get(result.productId);
        if (!group) continue;

        for (const order of group.orders) {
          const nextCost = result.price * (order.quantity || 1);
          if (order.cost === nextCost) continue;
          updatedOrders++;
          saves.push(updateOrder(order.id, { cost: nextCost }));
        }
      }
      endBatchUndo();
      await Promise.all(saves);
    } catch (err) {
      endBatchUndo();
      throw err;
    }

    return { productCount: results.length, orderCount: updatedOrders };
  }, [endBatchUndo, session?.access_token, startBatchUndo, updateOrder]);

  const handleStopCostRefresh = useCallback(() => {
    costRefreshAbortRef.current?.abort();
  }, []);

  const handleRefreshSelectedCosts = useCallback(async () => {
    setShowAutoMenu(false);
    if (refreshingCosts) return;
    if (!user || !session?.access_token) {
      showToast("로그인이 필요합니다.", "error");
      return;
    }

    const selectedOrders = await getLatestSelectedOrders();
    if (selectedOrders.length === 0) return;

    let productRows: ProductCostRow[];
    try {
      productRows = await fetchProductCostRows(user.id);
    } catch {
      showToast("상품소싱 목록을 불러오지 못했습니다.", "error");
      return;
    }

    const productMap = new Map<string, ProductCostRow>();
    for (const product of productRows) {
      if (!product.product_name) continue;
      const key = normalizeProductNameForMatch(product.product_name);
      const previous = productMap.get(key);
      if (!previous || (!isSupportedCostRefreshUrl(previous.purchase_url) && isSupportedCostRefreshUrl(product.purchase_url))) {
        productMap.set(key, product);
      }
    }

    const groups = new Map<string, { product: ProductCostRow; orders: Order[] }>();
    let unmatched = 0;
    let unsupported = 0;

    for (const order of selectedOrders) {
      if (!order.product_name) {
        unmatched++;
        continue;
      }

      const product = productMap.get(normalizeProductNameForMatch(order.product_name));
      if (!product) {
        unmatched++;
        continue;
      }
      if (!isSupportedCostRefreshUrl(product.purchase_url)) {
        unsupported++;
        continue;
      }

      const group = groups.get(product.id) ?? { product, orders: [] };
      group.orders.push(order);
      groups.set(product.id, group);
    }

    if (groups.size === 0) {
      showToast(`갱신 가능한 상품이 없습니다. 미매칭 ${unmatched}건, 미지원 링크 ${unsupported}건`, "info");
      return;
    }

    if (!confirm(`선택한 ${selectedOrders.length}건 중 상품 ${groups.size}개 원가를 갱신합니다.\n같은 상품은 한 번만 접속하고, 수집 완료 후 결과를 확인한 뒤 적용합니다.`)) {
      return;
    }

    const abortController = new AbortController();
    costRefreshAbortRef.current = abortController;
    setRefreshingCosts(true);
    setCostRefreshLog([
      `원가 갱신 준비 중... 주문 ${selectedOrders.length}건 → 상품 ${groups.size}개`,
      ...(unmatched > 0 ? [`상품소싱 미매칭 ${unmatched}건 제외`] : []),
      ...(unsupported > 0 ? [`미지원 최저가링크 ${unsupported}건 제외`] : []),
    ]);
    setCostRefreshTotal(groups.size);
    setCostRefreshProcessed(0);
    setCostRefreshCollapsed(false);
    costRefreshGroupsRef.current = groups;
    setCostRefreshResults([]);
    setCostRefreshResultOpen(false);

    const productNames = new Map([...groups].map(([id, group]) => [id, group.product.product_name || "상품명 없음"]));
    const successMap = new Map<string, CostRefreshResult>();
    let retryItems: CostRetryItem[] = [...groups].map(([id, group]) => ({ id, name: group.product.product_name || "상품명 없음" }));
    let stopped = false;

    try {
      for (let attempt = 1; attempt <= MAX_COST_REFRESH_ATTEMPTS && retryItems.length > 0; attempt++) {
        if (attempt > 1) {
          pushCostRefreshLog(`봇감지 ${retryItems.length}개 자동 재시도 (${attempt}/${MAX_COST_REFRESH_ATTEMPTS})...`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          if (abortController.signal.aborted) {
            stopped = true;
            break;
          }
        }

        const result = await runCostRefreshOnce(retryItems.map((item) => item.id), productNames, abortController);
        for (const success of result.successes) {
          const group = groups.get(success.productId);
          successMap.set(success.productId, { ...success, orderCount: group?.orders.length ?? 0 });
        }

        stopped = result.stopped;
        if (stopped) break;

        retryItems = result.botBlocked.filter((item) => !successMap.has(item.id));
        if (retryItems.length === 0) break;
      }

      const collectedResults = [...successMap.values()];
      setCostRefreshResults(collectedResults);

      const remainingText = retryItems.length > 0 && !stopped ? `, 봇감지 미완료 ${retryItems.length}개` : "";
      const stoppedText = stopped ? ", 중단됨" : "";
      pushCostRefreshLog(`수집 완료: 상품 ${collectedResults.length}개 확인됨${remainingText}${stoppedText}. 결과 확인 후 적용하세요.`);
      if (collectedResults.length > 0) {
        setCostRefreshResultOpen(true);
        showToast(`원가 수집 완료: 상품 ${collectedResults.length}개 확인`, "success");
      } else {
        showToast("적용할 원가 수집 결과가 없습니다.", "info");
      }
    } catch (err) {
      pushCostRefreshLog(`오류: ${err instanceof Error ? err.message : "원가 갱신 실패"}`);
      showToast("원가 갱신 중 오류가 발생했습니다.", "error");
    } finally {
      costRefreshAbortRef.current = null;
      setRefreshingCosts(false);
      setCostRefreshCollapsed(true);
    }
  }, [
    getLatestSelectedOrders,
    pushCostRefreshLog,
    refreshingCosts,
    runCostRefreshOnce,
    session?.access_token,
    showToast,
    user,
  ]);

  const handleApplyCollectedCosts = useCallback(async () => {
    if (costRefreshResults.length === 0 || applyingCostRefresh) return;

    setApplyingCostRefresh(true);
    try {
      const applied = await applyCostRefreshResults(costRefreshResults, costRefreshGroupsRef.current);
      await refetch();
      pushCostRefreshLog(`적용 완료: 상품 ${applied.productCount}개 확인, 발주서 ${applied.orderCount}건 수정`);
      showToast(`원가 적용 완료: 발주서 ${applied.orderCount}건 수정`, "success");
      setCostRefreshResultOpen(false);
      setCostRefreshResults([]);
    } catch (err) {
      pushCostRefreshLog(`적용 오류: ${err instanceof Error ? err.message : "원가 적용 실패"}`);
      showToast("원가 적용 중 오류가 발생했습니다.", "error");
    } finally {
      setApplyingCostRefresh(false);
    }
  }, [applyCostRefreshResults, applyingCostRefresh, costRefreshResults, pushCostRefreshLog, refetch, showToast]);

  const costRefreshPreview = useMemo(() => costRefreshResults.map((result) => {
    const group = costRefreshGroupsRef.current.get(result.productId);
    const orderChanges = (group?.orders ?? []).map((order) => {
      const previousCost = order.cost || 0;
      const nextCost = result.price * (order.quantity || 1);
      return {
        id: order.id,
        recipient: order.recipient_name || "-",
        quantity: order.quantity || 1,
        previousCost,
        nextCost,
        changed: previousCost !== nextCost,
      };
    });

    return {
      ...result,
      orderChanges,
      changedOrderCount: orderChanges.filter((order) => order.changed).length,
    };
  }), [costRefreshResults]);

  const costRefreshChangedProductCount = useMemo(
    () => costRefreshResults.filter((result) => result.price !== result.previous).length,
    [costRefreshResults],
  );
  const costRefreshChangedOrderCount = useMemo(
    () => costRefreshPreview.reduce((sum, row) => sum + row.changedOrderCount, 0),
    [costRefreshPreview],
  );
  const costRefreshOrderPreview = useMemo(
    () => costRefreshPreview.flatMap((row) =>
      row.orderChanges.map((order) => ({
        ...order,
        productId: row.productId,
        productName: row.productName,
        productPrice: row.price,
        productPreviousPrice: row.previous,
      })),
    ),
    [costRefreshPreview],
  );


  // 자동구매·운송장수집(백그라운드) 완료 시 발주서 갱신 (initial 0은 무시)
  useEffect(() => {
    if (autoPurchase.completionTick > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPurchase.completionTick]);
  useEffect(() => {
    if (trackingCollect.completionTick > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackingCollect.completionTick]);

  const stats = useMemo(() => {
    const totalRevenue = orders.reduce((sum, o) => sum + (o.revenue || 0), 0);
    const totalMargin = orders.reduce((sum, o) => sum + (o.margin || 0), 0);
    const totalSettlement = orders.reduce((sum, o) => sum + (o.settlement || 0), 0);
    const totalCost = orders.reduce((sum, o) => sum + (o.cost || 0), 0);
    const marketplaceRevenue: Record<string, number> = {};
    for (const o of orders) {
      if (o.marketplace) {
        marketplaceRevenue[o.marketplace] = (marketplaceRevenue[o.marketplace] || 0) + (o.revenue || 0);
      }
    }
    return { count: orders.length, totalRevenue, totalMargin, totalSettlement, totalCost, marketplaceRevenue };
  }, [orders]);

  const handleImport = async (rows: OrderInsert[]) => {
    const result = await insertOrders(rows);
    if (!result.error && rows.length > 0) {
      // 가장 많은 주문이 있는 월로 자동 이동
      const monthCounts: Record<string, number> = {};
      for (const row of rows) {
        if (row.order_date) {
          const m = getKoreanMonthKey(row.order_date);
          if (m) monthCounts[m] = (monthCounts[m] || 0) + 1;
        }
      }
      const topMonth = Object.entries(monthCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
      setSelectedMonth(topMonth || null);
      await refetch();
    }
    return result;
  };

  const handleAddOrder = async (order: OrderInsert) => {
    return insertOrders([order]);
  };

  const handleSelectToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === orders.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(orders.map((o) => o.id)));
    }
  };

  const [deleting, setDeleting] = useState(false);
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size}건을 삭제하시겠습니까?`)) return;
    setDeleting(true);
    const result = await deleteOrders([...selectedIds]);
    setDeleting(false);
    if (result.error) {
      alert(`삭제 실패: ${result.error}`);
    }
    setSelectedIds(new Set());
  };

  const handleClearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleBulkStatusChange = useCallback((status: string) => {
    const ids = [...selectedIds];
    startBatchUndo();
    for (const id of ids) updateOrder(id, { delivery_status: status }, false);
    endBatchUndo();
    showToast(`${ids.length}개 주문 상태 변경: ${status}`, "success");
    handleClearSelection();
  }, [selectedIds, startBatchUndo, endBatchUndo, updateOrder, showToast, handleClearSelection]);

  const handleColumnFilterChange = useCallback((key: string, values: string[]) => {
    setColumnFilters((prev) => {
      const next = { ...prev };
      if (values.length === 0) {
        delete next[key];
      } else {
        next[key] = values;
      }
      return next;
    });
  }, []);

  // 내보내기할 대상 결정 (선택된 주문 또는 전체)
  const exportTargetOrders = useMemo(() => {
    if (selectedIds.size > 0) {
      return orders.filter((o) => selectedIds.has(o.id));
    }
    return orders;
  }, [orders, selectedIds]);

  const handleExportOrder = async () => {
    const exportData = exportTargetOrders.map((o) => ({
      묶음번호: o.bundle_no,
      주문일시: o.order_date ? formatKoreanDateTime(o.order_date) : null,
      판매처: o.marketplace,
      수취인명: o.recipient_name,
      상품명: o.product_name,
      수량: o.quantity,
      수령자번호: o.recipient_phone,
      주문자번호: o.orderer_phone,
      우편번호: o.postal_code,
      기본주소: o.address,
      상세주소: o.address_detail,
      배송메모: o.delivery_memo,
      매출: o.revenue,
      정산예정: o.settlement,
      원가: o.cost,
      마진: o.margin,
      결제방식: o.payment_method,
      구매처: o.purchase_source,
      구매아이디: o.purchase_id,
      주문번호: o.purchase_order_no,
      택배사: o.courier,
      운송장: o.tracking_no,
      배송상태: o.delivery_status,
      최저가링크: o.purchase_url,
    }));
    const monthLabel = selectedMonth || "전체";
    await exportOrdersToCSV(exportData, `발주서_${monthLabel}.xlsx`);
    setShowExportMenu(false);
  };

  const handleExportPlayAuto = async () => {
    const { buffer, filename } = await generatePlayAutoTrackingExcel(exportTargetOrders, courierCodeMap);
    downloadExcel(buffer, filename);
    setShowExportMenu(false);

    // 보관함에 자동 저장
    if (session?.access_token) {
      const base64 = arrayBufferToBase64(buffer);
      fetch("/api/archives", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          file_name: filename,
          file_type: "playauto_tracking",
          file_data: base64,
          order_count: exportTargetOrders.filter((o) => o.tracking_no).length,
        }),
      }).catch(() => {});
    }
  };

  // 데이터가 있는 월 + 전체 12개월 병합
  const allMonths = useMemo(() => {
    const set = new Set([...monthOptions, ...months]);
    return [...set].sort();
  }, [monthOptions, months]);

  return (
    <div className="space-y-3">
      {/* 상위 탭: 발주서 / 구매 로그 / 운송장 로그 */}
      <div className="flex items-center gap-1 border-b border-[var(--border)]">
        <button
          onClick={() => handleTabChange("orders")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "orders"
              ? "border-blue-500 text-blue-400"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <FileSpreadsheet className="w-4 h-4" />
          발주서
        </button>
        <button
          onClick={() => handleTabChange("logs")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "logs"
              ? "border-blue-500 text-blue-400"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <History className="w-4 h-4" />
          구매 로그
        </button>
        <button
          onClick={() => handleTabChange("tracking-logs")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "tracking-logs"
              ? "border-blue-500 text-blue-400"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Truck className="w-4 h-4" />
          운송장 로그
        </button>
      </div>

      {/* 구매 로그 탭 */}
      {activeTab === "logs" && <PurchaseLogTab initialBatchId={activeBatchId} />}

      {/* 운송장 로그 탭 */}
      {activeTab === "tracking-logs" && <TrackingLogTab initialBatchId={activeBatchId} />}

      {/* 발주서 탭 */}
      {activeTab === "orders" && (<>
      {/* 월별 탭 */}
      <div
        ref={monthScrollRef}
        className="flex items-center gap-1 md:gap-1.5 overflow-x-auto pb-1 scrollbar-hide flex-nowrap scroll-smooth"
        style={{ scrollSnapType: "x mandatory" }}
      >
        <button
          ref={!selectedMonth ? activeMonthRef : undefined}
          onClick={() => handleMonthChange(null)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors min-h-[36px] flex items-center shrink-0 scroll-snap-align-start ${
            !selectedMonth ? "bg-blue-600/20 text-blue-400" : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          전체
        </button>
        {allMonths.map((m) => {
          const hasData = months.includes(m);
          const isActive = selectedMonth === m;
          return (
            <button
              key={m}
              ref={isActive ? activeMonthRef : undefined}
              onClick={() => handleMonthChange(m === selectedMonth ? null : m)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors min-h-[36px] flex items-center shrink-0 ${
                isActive
                  ? "bg-blue-600/20 text-blue-400"
                  : hasData
                    ? "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    : "text-[var(--text-disabled)] hover:text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              {m.slice(5)}월
            </button>
          );
        })}
        <div className="relative shrink-0">
          <button
            onClick={() => setShowMonthPicker(!showMonthPicker)}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-tertiary)]"
          >
            <Calendar className="w-4 h-4" />
          </button>
          {showMonthPicker && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl p-2">
              <input
                type="month"
                onChange={(e) => {
                  if (e.target.value) handleMonthChange(e.target.value);
                  setShowMonthPicker(false);
                }}
                className="bg-[var(--bg-hover)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
              />
            </div>
          )}
        </div>
      </div>

      {/* 액션 바 */}
      <div className="space-y-2">
        {/* 줄 1: 검색 + 필터 */}
        <FilterBar
          search={search}
          onSearchChange={setSearch}
          onSearchSubmit={() => setActiveSearch(search)}
          onSearchClear={handleSearchClear}
          placeholder="검색어 입력..."
        >
          <select
            value={selectedMarketplace || "전체"}
            onChange={(e) => setSelectedMarketplace(e.target.value === "전체" ? null : e.target.value)}
            className="px-2 md:px-3 py-2 min-h-[44px] sm:min-h-0 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] outline-none"
          >
            {MARKETPLACE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>

          {/* 날짜 범위 필터 */}
          <div className={`flex items-center gap-1 px-2 py-1.5 min-h-[44px] sm:min-h-0 border rounded-lg transition-colors ${selectedDateFrom || selectedDateTo ? "bg-blue-600/10 border-blue-500/40" : "bg-[var(--bg-hover)] border-[var(--border)]"}`}>
            <Calendar className={`w-3.5 h-3.5 shrink-0 ${selectedDateFrom || selectedDateTo ? "text-blue-400" : "text-[var(--text-muted)]"}`} />
            <input
              type="date"
              value={selectedDateFrom || ""}
              onChange={(e) => handleDateFromChange(e.target.value)}
              className="bg-transparent text-xs text-[var(--text-primary)] outline-none w-[105px] cursor-pointer [color-scheme:dark]"
            />
            <span className="text-[var(--text-muted)] text-xs shrink-0">~</span>
            <input
              type="date"
              value={selectedDateTo || ""}
              min={selectedDateFrom || undefined}
              onChange={(e) => handleDateToChange(e.target.value)}
              className="bg-transparent text-xs text-[var(--text-primary)] outline-none w-[105px] cursor-pointer [color-scheme:dark]"
            />
            {(selectedDateFrom || selectedDateTo) && (
              <button onClick={clearDateFilter} className="text-blue-400/60 hover:text-blue-300 text-xs leading-none ml-0.5 shrink-0">✕</button>
            )}
          </div>
        </FilterBar>

        {/* 줄 2: 액션 버튼들 */}
        <div className="flex items-center gap-2 flex-wrap">
          {selectedIds.size > 0 && (
            <button
              onClick={handleBulkDelete}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] md:min-h-0 bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50 text-sm rounded-lg transition-colors whitespace-nowrap"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? "삭제 중..." : `${selectedIds.size}건 삭제`}
            </button>
          )}
          <div className="relative" ref={autoMenuRef}>
            <button
              onClick={() => setShowAutoMenu(!showAutoMenu)}
              className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] md:min-h-0 bg-orange-500 text-white border border-orange-600 hover:bg-orange-600 dark:bg-orange-600 dark:text-white dark:border-orange-700 dark:hover:bg-orange-700 text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
            >
              <Zap className="w-4 h-4" />
              <span className="hidden sm:inline">자동화</span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {showAutoMenu && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl py-1 min-w-44">
                <button
                  onClick={handleOpenAutoPurchase}
                  disabled={selectedIds.size === 0}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ShoppingCart className="w-4 h-4 text-orange-400" />
                  구매 자동화{selectedIds.size > 0 ? ` (${selectedIds.size}건)` : ""}
                </button>
                <button
                  onClick={handleOpenTrackingCollect}
                  disabled={selectedIds.size === 0}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Truck className="w-4 h-4 text-purple-400" />
                  배송조회 수집{selectedIds.size > 0 ? ` (${selectedIds.size}건)` : ""}
                </button>
                <button
                  onClick={handleRefreshSelectedCosts}
                  disabled={selectedIds.size === 0 || refreshingCosts}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 text-cyan-400 ${refreshingCosts ? "animate-spin" : ""}`} />
                  원가 갱신{selectedIds.size > 0 ? ` (${selectedIds.size}건)` : ""}
                </button>
                <button
                  onClick={() => { setShowAutoMenu(false); setShowBulkSms(true); }}
                  disabled={selectedIds.size === 0}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <MessageSquare className="w-4 h-4 text-green-400" />
                  단체문자{selectedIds.size > 0 ? ` (${selectedIds.size}건)` : ""}
                </button>
              </div>
            )}
          </div>
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] md:min-h-0 bg-[var(--bg-hover)] border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm rounded-lg transition-colors whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">내보내기{selectedIds.size > 0 ? ` (${selectedIds.size}건)` : ""}</span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {showExportMenu && (
              <div className="absolute top-full right-0 mt-1 z-50 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl py-1 min-w-44">
                <button
                  onClick={handleExportOrder}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <FileSpreadsheet className="w-4 h-4 text-blue-400" />
                  발주서 양식
                </button>
                <button
                  onClick={handleExportPlayAuto}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <Truck className="w-4 h-4 text-purple-400" />
                  플레이오토 운송장
                </button>
              </div>
            )}
          </div>
          <div className="relative" ref={importMenuRef}>
            <button
              onClick={() => setShowImportMenu(!showImportMenu)}
              className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] md:min-h-0 bg-green-100 text-green-700 border border-green-200 hover:bg-green-200 dark:bg-green-600/20 dark:text-green-400 dark:border-transparent dark:hover:bg-green-600/30 text-sm rounded-lg transition-colors whitespace-nowrap"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span className="hidden md:inline">엑셀 가져오기</span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {showImportMenu && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl py-1 whitespace-nowrap">
                <button
                  onClick={() => { setShowImportMenu(false); setShowImport(true); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <FileSpreadsheet className="w-4 h-4 text-green-400" />
                  발주서 가져오기
                </button>
                <button
                  onClick={() => { setShowImportMenu(false); setShowSettlementImport(true); }}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <Download className="w-4 h-4 text-blue-400" />
                  정산금액 가져오기
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 통계 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:gap-x-6 text-xs text-[var(--text-muted)]">
        <span>총 <strong className="text-[var(--text-secondary)]">{stats.count}</strong>건</span>
        <span>매출 <strong className="text-[var(--text-secondary)]">{stats.totalRevenue.toLocaleString()}</strong>원</span>
        {Object.keys(stats.marketplaceRevenue).length > 0 && (
          <>
            <span className="hidden md:inline text-[var(--text-disabled)]">|</span>
            {Object.entries(stats.marketplaceRevenue)
              .sort((a, b) => b[1] - a[1])
              .map(([name, revenue]) => (
                <span key={name} className="hidden md:inline">{name} <strong className="text-[var(--text-secondary)]">{revenue.toLocaleString()}</strong>원</span>
              ))}
            <span className="hidden md:inline text-[var(--text-disabled)]">|</span>
          </>
        )}
        <span>정산예정 <strong className="text-[var(--text-secondary)]">{stats.totalSettlement.toLocaleString()}</strong>원</span>
        <span>원가 <strong className="text-[var(--text-secondary)]">{stats.totalCost.toLocaleString()}</strong>원</span>
        <span>
          마진{" "}
          <strong className={stats.totalMargin >= 0 ? "text-green-400" : "text-red-400"}>
            {stats.totalMargin.toLocaleString()}
          </strong>
          원
        </span>
        {(Object.values(columnFilters).some((v) => v.length > 0) || selectedDateFrom || selectedDateTo) && (
          <button
            onClick={() => { setColumnFilters({}); clearDateFilter(); }}
            className="text-blue-400 hover:text-blue-300"
          >
            필터 초기화
          </button>
        )}
      </div>

      {/* 테이블 */}
      <OrderTable
        orders={orders}
        allOrders={allOrders}
        loading={loading}
        selectedIds={selectedIds}
        onSelectToggle={handleSelectToggle}
        onSelectAll={handleSelectAll}
        onUpdate={updateOrder}
        onUndo={undo}
        onDeleteSelected={handleBulkDelete}
        onStartBatchUndo={startBatchUndo}
        onEndBatchUndo={endBatchUndo}
        onRowClick={(order) => setSidePanelOrder(order)}
        columnFilters={columnFilters}
        onColumnFilterChange={handleColumnFilterChange}
      />
      </>)}

      {showImport && (
        <ExcelImport onImport={handleImport} onClose={() => setShowImport(false)} checkDuplicates={checkDuplicates} />
      )}
      {showSettlementImport && (
        <SettlementImportModal
          orders={orders}
          onUpdate={updateOrder}
          onClose={() => setShowSettlementImport(false)}
          startBatchUndo={startBatchUndo}
          endBatchUndo={endBatchUndo}
          refetch={refetch}
        />
      )}
      {showAddModal && (
        <OrderModal onSave={handleAddOrder} onClose={() => setShowAddModal(false)} />
      )}
      {sidePanelOrder && !isMobile && (
        <OrderSidePanel
          order={orders.find((o) => o.id === sidePanelOrder.id) || sidePanelOrder}
          onUpdate={updateOrder}
          onClose={() => setSidePanelOrder(null)}
        />
      )}
      {isMobile && (
        <MobileSheet
          open={!!sidePanelOrder}
          onClose={() => setSidePanelOrder(null)}
          title="주문 상세"
        >
          {sidePanelOrder && (
            <OrderSidePanelContent
              order={orders.find((o) => o.id === sidePanelOrder.id) || sidePanelOrder}
              onUpdate={updateOrder}
              onClose={() => setSidePanelOrder(null)}
            />
          )}
        </MobileSheet>
      )}
      {showBulkSms && (
        <BulkSmsModal
          orders={orders.filter((o) => selectedIds.has(o.id))}
          onClose={() => setShowBulkSms(false)}
        />
      )}
      {costRefreshResultOpen && costRefreshResults.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => !applyingCostRefresh && setCostRefreshResultOpen(false)} />
          <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-2xl p-6 mx-3">
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">원가 갱신 결과 확인</h3>
            <p className="text-xs text-[var(--text-muted)] mb-4">
              상품 {costRefreshResults.length}개 확인 · 상품소싱 가격 변동 {costRefreshChangedProductCount}개 · 발주서 원가 수정 예정 {costRefreshChangedOrderCount}건
            </p>

            <div className="max-h-[55vh] overflow-y-auto space-y-1.5 mb-4 pr-1">
              {costRefreshOrderPreview.map((order) => {
                const productChanged = order.productPrice !== order.productPreviousPrice;
                return (
                  <div
                    key={`${order.productId}-${order.id}`}
                    className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs ${order.changed ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)] opacity-75"}`}
                  >
                    <div className="min-w-0 truncate">
                      <span className="font-medium text-[var(--text-primary)]">{order.productName}</span>
                      <span className="text-[var(--text-muted)]"> · {order.recipient} · 수량 {order.quantity}</span>
                      {!productChanged && <span className="text-[var(--text-muted)]"> · 상품소싱 변동없음</span>}
                    </div>
                    <div className="shrink-0 tabular-nums text-right">
                      <span className="text-[var(--text-muted)]">{order.previousCost.toLocaleString()}</span>
                      <span className="text-[var(--text-muted)] mx-1">→</span>
                      <span className={order.nextCost > order.previousCost ? "text-red-400 font-medium" : order.nextCost < order.previousCost ? "text-blue-400 font-medium" : "text-[var(--text-muted)]"}>
                        {order.nextCost.toLocaleString()}원
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCostRefreshResultOpen(false)}
                disabled={applyingCostRefresh}
                className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
              >
                나중에 적용
              </button>
              <button
                type="button"
                onClick={handleApplyCollectedCosts}
                disabled={applyingCostRefresh}
                className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
              >
                {applyingCostRefresh ? "적용 중..." : `적용하기 (${costRefreshChangedOrderCount}건)`}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 자동구매 모달은 레이아웃의 AutoPurchaseHost에서 렌더 (백그라운드 유지) */}
      {(refreshingCosts || costRefreshLog.length > 0) && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 w-[min(520px,calc(100vw-24px))] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-lg overflow-hidden">
          <div className={`flex items-center justify-between gap-3 px-4 py-2.5 ${costRefreshCollapsed ? "" : "border-b border-[var(--border)]"}`}>
            <button
              type="button"
              onClick={() => setCostRefreshCollapsed((v) => !v)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left"
              aria-expanded={!costRefreshCollapsed}
            >
              {refreshingCosts && <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />}
              <span className="text-sm font-medium text-[var(--text-primary)]">원가 갱신</span>
              {costRefreshTotal > 0 && (
                <span className="text-xs text-[var(--text-muted)] shrink-0 tabular-nums">
                  {costRefreshProcessed}/{costRefreshTotal}
                </span>
              )}
              {costRefreshCollapsed && costRefreshLog.length > 0 && (
                <span className="text-xs text-[var(--text-muted)] truncate">{costRefreshLog[costRefreshLog.length - 1]}</span>
              )}
            </button>
            <div className="flex items-center gap-2 shrink-0">
              {refreshingCosts ? (
                <button
                  type="button"
                  onClick={handleStopCostRefresh}
                  className="px-2 py-1 text-xs rounded-md bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
                >
                  중단
                </button>
              ) : (
                <>
                  {costRefreshResults.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setCostRefreshResultOpen(true)}
                      className="px-2 py-1 text-xs rounded-md bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 transition-colors"
                    >
                      결과 보기
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setCostRefreshLog([])}
                    className="px-2 py-1 text-xs rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    닫기
                  </button>
                </>
              )}
            </div>
          </div>
          {!costRefreshCollapsed && (
            <div className="max-h-56 overflow-y-auto px-4 py-3 space-y-1.5">
              {costRefreshLog.map((line, index) => (
                <div key={`${index}-${line}`} className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {selectedIds.size > 0 && (
        <BulkEditBar
          count={selectedIds.size}
          onChangeStatus={handleBulkStatusChange}
          onClearSelection={handleClearSelection}
        />
      )}
      {/* 운송장수집 모달은 레이아웃의 TrackingCollectHost에서 렌더 (백그라운드 유지) */}
    </div>
  );
}
