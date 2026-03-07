"use client";

import { useState, useMemo, useCallback } from "react";
import { FileSpreadsheet, Plus, Trash2, Download, Search, Calendar, Truck } from "lucide-react";
import { useOrders } from "@/hooks/use-orders";
import { supabase } from "@/lib/supabase";
import { exportOrdersToCSV } from "@/lib/excel-parser";
import OrderTable from "@/components/workspace/orders/order-table";
import ExcelImport from "@/components/workspace/orders/excel-import";
import OrderModal from "@/components/workspace/orders/order-modal";
import OrderSidePanel from "@/components/workspace/orders/order-side-panel";
import TrackingCollectModal from "@/components/workspace/orders/tracking-collect-modal";
import type { Order, OrderInsert } from "@/types/database";

const MARKETPLACE_OPTIONS = ["전체", "쿠팡", "스마트스토어", "지마켓", "옥션", "11번가"];

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

  const monthOptions = useMemo(() => generateMonthOptions(), []);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") setActiveSearch(search);
  };
  const handleSearchClear = () => {
    setSearch("");
    setActiveSearch("");
  };

  const { orders, allOrders, loading, months, insertOrders, updateOrder, deleteOrders, undo } = useOrders({
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

  const handleExport = () => {
    const exportData = orders.map((o) => ({
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
      구매아이디: o.purchase_id,
      구매처: o.purchase_source,
      주문번호: o.purchase_order_no,
      택배사: o.courier,
      운송장: o.tracking_no,
      배송상태: o.delivery_status,
    }));
    const monthLabel = selectedMonth || "전체";
    exportOrdersToCSV(exportData, `발주서_${monthLabel}.xlsx`);
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
            !selectedMonth ? "bg-blue-600/20 text-blue-400" : "text-white/40 hover:text-white hover:bg-white/5"
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
                    ? "text-white/60 hover:text-white hover:bg-white/5"
                    : "text-white/20 hover:text-white/40 hover:bg-white/5"
              }`}
            >
              {m.slice(5)}월
            </button>
          );
        })}
        <div className="relative">
          <button
            onClick={() => setShowMonthPicker(!showMonthPicker)}
            className="p-1.5 text-white/30 hover:text-white/60"
          >
            <Calendar className="w-4 h-4" />
          </button>
          {showMonthPicker && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-[#1e1e2e] border border-white/10 rounded-lg shadow-xl p-2">
              <input
                type="month"
                onChange={(e) => {
                  if (e.target.value) setSelectedMonth(e.target.value);
                  setShowMonthPicker(false);
                }}
                className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none"
              />
            </div>
          )}
        </div>
      </div>

      {/* 액션 바 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="검색어 입력 후 Enter..."
            className="w-full pl-9 pr-8 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-white/30 outline-none focus:border-blue-500/50"
          />
          {search && (
            <button onClick={handleSearchClear} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white">
              <span className="text-xs">✕</span>
            </button>
          )}
        </div>

        <select
          value={selectedMarketplace || "전체"}
          onChange={(e) => setSelectedMarketplace(e.target.value === "전체" ? null : e.target.value)}
          className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none"
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
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 bg-white/5 border border-white/10 text-white/60 hover:text-white text-sm rounded-lg transition-colors"
          >
            <Download className="w-4 h-4" />
            내보내기
          </button>
          <button
            onClick={() => setShowTrackingCollect(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 text-sm rounded-lg transition-colors"
          >
            <Truck className="w-4 h-4" />
            배송조회 수집
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-green-600/20 text-green-400 hover:bg-green-600/30 text-sm rounded-lg transition-colors"
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
      <div className="flex items-center gap-6 text-xs text-white/40">
        <span>총 <strong className="text-white/70">{stats.count}</strong>건</span>
        <span>매출 <strong className="text-white/70">{stats.totalRevenue.toLocaleString()}</strong>원</span>
        {Object.keys(stats.marketplaceRevenue).length > 0 && (
          <>
            <span className="text-white/20">|</span>
            {Object.entries(stats.marketplaceRevenue)
              .sort((a, b) => b[1] - a[1])
              .map(([name, revenue]) => (
                <span key={name}>{name} <strong className="text-white/70">{revenue.toLocaleString()}</strong>원</span>
              ))}
            <span className="text-white/20">|</span>
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
      {showTrackingCollect && (
        <TrackingCollectModal
          orders={orders}
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
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}
