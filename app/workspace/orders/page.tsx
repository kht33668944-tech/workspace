"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { FileSpreadsheet, Plus, Trash2, Download, Search, Calendar, Truck, ChevronDown, ShoppingCart } from "lucide-react";
import { useOrders } from "@/hooks/use-orders";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { exportOrdersToCSV } from "@/lib/excel-parser";
import { generateOrderExcel, generatePlayAutoTrackingExcel, downloadExcel, arrayBufferToBase64 } from "@/lib/excel-export";
import { DEFAULT_COURIER_CODES } from "@/lib/courier-codes";
import OrderTable from "@/components/workspace/orders/order-table";
import ExcelImport from "@/components/workspace/orders/excel-import";
import OrderModal from "@/components/workspace/orders/order-modal";
import OrderSidePanel from "@/components/workspace/orders/order-side-panel";
import TrackingCollectModal from "@/components/workspace/orders/tracking-collect-modal";
import AutoPurchaseModal from "@/components/workspace/orders/auto-purchase-modal";
import type { Order, OrderInsert } from "@/types/database";

const MARKETPLACE_OPTIONS = ["전체", "쿠팡", "스마트스토어", "지마켓", "옥션", "11번가"];

// Ctrl+S 브라우저 기본 동작(다른 이름으로 저장) 방지
function usePreventBrowserSave() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
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
  usePreventBrowserSave();
  const { session } = useAuth();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(getCurrentMonth);
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [columnFilters, setColumnFilters] = useState<Record<string, string[]>>({});
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [sidePanelOrder, setSidePanelOrder] = useState<Order | null>(null);
  const [showTrackingCollect, setShowTrackingCollect] = useState(false);
  const [showAutoPurchase, setShowAutoPurchase] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [courierCodeMap, setCourierCodeMap] = useState<Record<string, number>>(DEFAULT_COURIER_CODES);
  const exportMenuRef = useRef<HTMLDivElement>(null);

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

  // 내보내기 메뉴 외부 클릭 닫기
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    if (showExportMenu) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showExportMenu]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") setActiveSearch(search);
  };
  const handleSearchClear = () => {
    setSearch("");
    setActiveSearch("");
  };

  const { orders, allOrders, loading, months, insertOrders, updateOrder, deleteOrders, undo, startBatchUndo, endBatchUndo, refetch } = useOrders({
    month: selectedMonth,
    marketplace: selectedMarketplace,
    search: activeSearch,
    columnFilters,
  });

  const stats = useMemo(() => {
    const totalRevenue = orders.reduce((sum, o) => sum + (o.revenue || 0), 0);
    const totalMargin = orders.reduce((sum, o) => sum + (o.margin || 0), 0);
    const marketplaceRevenue: Record<string, number> = {};
    for (const o of orders) {
      if (o.marketplace) {
        marketplaceRevenue[o.marketplace] = (marketplaceRevenue[o.marketplace] || 0) + (o.revenue || 0);
      }
    }
    return { count: orders.length, totalRevenue, totalMargin, marketplaceRevenue };
  }, [orders]);

  const handleImport = async (rows: OrderInsert[]) => {
    const result = await insertOrders(rows);
    if (!result.error && rows.length > 0) {
      // 가장 많은 주문이 있는 월로 자동 이동
      const monthCounts: Record<string, number> = {};
      for (const row of rows) {
        if (row.order_date) {
          const m = row.order_date.slice(0, 7); // YYYY-MM
          monthCounts[m] = (monthCounts[m] || 0) + 1;
        }
      }
      const topMonth = Object.entries(monthCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
      setSelectedMonth(topMonth || null);
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

  const handleExportOrder = () => {
    const exportData = exportTargetOrders.map((o) => ({
      묶음번호: o.bundle_no,
      주문일시: o.order_date ? o.order_date.slice(0, 16).replace("T", " ") : null,
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
    exportOrdersToCSV(exportData, `발주서_${monthLabel}.xlsx`);
    setShowExportMenu(false);
  };

  const handleExportPlayAuto = () => {
    const { buffer, filename } = generatePlayAutoTrackingExcel(exportTargetOrders, courierCodeMap);
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
      {/* 월별 탭 */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        <button
          onClick={() => setSelectedMonth(null)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
            !selectedMonth ? "bg-blue-600/20 text-blue-400" : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          전체
        </button>
        {allMonths.map((m) => {
          const hasData = months.includes(m);
          return (
            <button
              key={m}
              onClick={() => setSelectedMonth(m === selectedMonth ? null : m)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                selectedMonth === m
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
        <div className="relative">
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
                  if (e.target.value) setSelectedMonth(e.target.value);
                  setShowMonthPicker(false);
                }}
                className="bg-[var(--bg-hover)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
              />
            </div>
          )}
        </div>
      </div>

      {/* 액션 바 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="검색어 입력 후 Enter..."
            className="w-full pl-9 pr-8 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50"
          />
          {search && (
            <button onClick={handleSearchClear} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <span className="text-xs">✕</span>
            </button>
          )}
        </div>

        <select
          value={selectedMarketplace || "전체"}
          onChange={(e) => setSelectedMarketplace(e.target.value === "전체" ? null : e.target.value)}
          className="px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] outline-none"
        >
          {MARKETPLACE_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>

        <div className="flex items-center gap-2 ml-auto">
          {selectedIds.size > 0 && (
            <button
              onClick={handleBulkDelete}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-2 bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50 text-sm rounded-lg transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? "삭제 중..." : `${selectedIds.size}건 삭제`}
            </button>
          )}
          <button
            onClick={() => setShowAutoPurchase(true)}
            disabled={selectedIds.size === 0}
            className="flex items-center gap-1.5 px-3 py-2 bg-orange-500 text-white border border-orange-600 hover:bg-orange-600 dark:bg-orange-600 dark:text-white dark:border-orange-700 dark:hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium rounded-lg transition-colors"
          >
            <ShoppingCart className="w-4 h-4" />
            구매 자동화{selectedIds.size > 0 ? ` (${selectedIds.size}건)` : ""}
          </button>
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm rounded-lg transition-colors"
            >
              <Download className="w-4 h-4" />
              내보내기{selectedIds.size > 0 ? ` (${selectedIds.size}건)` : ""}
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
          <button
            onClick={() => setShowTrackingCollect(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-purple-100 text-purple-700 border border-purple-200 hover:bg-purple-200 dark:bg-purple-600/20 dark:text-purple-400 dark:border-transparent dark:hover:bg-purple-600/30 text-sm rounded-lg transition-colors"
          >
            <Truck className="w-4 h-4" />
            배송조회 수집
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-green-100 text-green-700 border border-green-200 hover:bg-green-200 dark:bg-green-600/20 dark:text-green-400 dark:border-transparent dark:hover:bg-green-600/30 text-sm rounded-lg transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4" />
            엑셀 가져오기
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            수동 추가
          </button>
        </div>
      </div>

      {/* 통계 */}
      <div className="flex items-center gap-6 text-xs text-[var(--text-muted)]">
        <span>총 <strong className="text-[var(--text-secondary)]">{stats.count}</strong>건</span>
        <span>매출 <strong className="text-[var(--text-secondary)]">{stats.totalRevenue.toLocaleString()}</strong>원</span>
        {Object.keys(stats.marketplaceRevenue).length > 0 && (
          <>
            <span className="text-[var(--text-disabled)]">|</span>
            {Object.entries(stats.marketplaceRevenue)
              .sort((a, b) => b[1] - a[1])
              .map(([name, revenue]) => (
                <span key={name}>{name} <strong className="text-[var(--text-secondary)]">{revenue.toLocaleString()}</strong>원</span>
              ))}
            <span className="text-[var(--text-disabled)]">|</span>
          </>
        )}
        <span>
          마진{" "}
          <strong className={stats.totalMargin >= 0 ? "text-green-400" : "text-red-400"}>
            {stats.totalMargin.toLocaleString()}
          </strong>
          원
        </span>
        {Object.values(columnFilters).some((v) => v.length > 0) && (
          <button
            onClick={() => setColumnFilters({})}
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

      {showImport && (
        <ExcelImport onImport={handleImport} onClose={() => setShowImport(false)} />
      )}
      {showAddModal && (
        <OrderModal onSave={handleAddOrder} onClose={() => setShowAddModal(false)} />
      )}
      {sidePanelOrder && (
        <OrderSidePanel
          order={orders.find((o) => o.id === sidePanelOrder.id) || sidePanelOrder}
          onUpdate={updateOrder}
          onClose={() => setSidePanelOrder(null)}
        />
      )}
      {showAutoPurchase && (
        <AutoPurchaseModal
          orders={orders.filter((o) => selectedIds.has(o.id))}
          onClose={() => setShowAutoPurchase(false)}
          onComplete={() => {
            setShowAutoPurchase(false);
            refetch();
          }}
        />
      )}
      {showTrackingCollect && (
        <TrackingCollectModal
          orders={orders}
          courierCodeMap={courierCodeMap}
          onClose={() => setShowTrackingCollect(false)}
          onApply={async (updates) => {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch("/api/orders/bulk-update-tracking", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
              },
              body: JSON.stringify({ updates }),
            });
            const data = await res.json();
            if (!res.ok) {
              alert(`업데이트 실패: ${data.error}`);
            } else if (data.failCount > 0) {
              alert(`업데이트: 성공 ${data.successCount}건, 실패 ${data.failCount}건\n${data.errors?.slice(0, 5).join("\n")}`);
            }
            await refetch();
          }}
        />
      )}
    </div>
  );
}
