"use client";

import React from "react";
import { TrendingUp, TrendingDown, AlertTriangle, BarChart3 } from "lucide-react";
import { usePriceHistory, type PriceFilter } from "@/hooks/use-price-history";

const FILTER_CARDS: { key: PriceFilter; label: string; icon: React.ElementType; color: string; activeColor: string }[] = [
  { key: "all", label: "전체", icon: BarChart3, color: "text-[var(--text-muted)]", activeColor: "bg-blue-500/20 text-blue-400 border-blue-500/50" },
  { key: "up", label: "상승", icon: TrendingUp, color: "text-red-400", activeColor: "bg-red-500/20 text-red-400 border-red-500/50" },
  { key: "down", label: "하락", icon: TrendingDown, color: "text-blue-400", activeColor: "bg-blue-500/20 text-blue-400 border-blue-500/50" },
  { key: "alert", label: "주의 (10%+)", icon: AlertTriangle, color: "text-yellow-400", activeColor: "bg-yellow-500/20 text-yellow-400 border-yellow-500/50" },
];

export default function PriceHistoryTab() {
  const { history, loading, summary, filter, setFilter, dateRange, setDateRange } = usePriceHistory();

  const filterCount = (key: PriceFilter) => {
    if (key === "all") return summary.total;
    if (key === "up") return summary.up;
    if (key === "down") return summary.down;
    return summary.alert;
  };

  return (
    <div className="space-y-4">
      {/* 날짜 선택 */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-[var(--text-muted)]">기간</label>
        <input
          type="date"
          value={dateRange.from}
          onChange={(e) => setDateRange(prev => ({ ...prev, from: e.target.value }))}
          className="px-3 py-1.5 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] outline-none focus:border-blue-400"
        />
        <span className="text-[var(--text-muted)]">~</span>
        <input
          type="date"
          value={dateRange.to}
          onChange={(e) => setDateRange(prev => ({ ...prev, to: e.target.value }))}
          className="px-3 py-1.5 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] outline-none focus:border-blue-400"
        />
      </div>

      {/* 요약 필터 카드 */}
      <div className="flex items-center gap-3">
        {FILTER_CARDS.map((card) => {
          const count = filterCount(card.key);
          const isActive = filter === card.key;
          const Icon = card.icon;
          return (
            <button
              key={card.key}
              onClick={() => setFilter(isActive && card.key !== "all" ? "all" : card.key)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border transition-colors ${
                isActive
                  ? card.activeColor
                  : "border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-main)]"
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? "" : card.color}`} />
              <span className="text-sm font-medium">{card.label}</span>
              <span className={`text-lg font-bold ${isActive ? "" : "text-[var(--text-primary)]"}`}>{count}</span>
              {card.key === "up" && summary.avgUpRate > 0 && (
                <span className="text-xs text-[var(--text-muted)]">(+{summary.avgUpRate}%)</span>
              )}
              {card.key === "down" && summary.avgDownRate < 0 && (
                <span className="text-xs text-[var(--text-muted)]">({summary.avgDownRate}%)</span>
              )}
            </button>
          );
        })}
      </div>

      {/* 이력 테이블 */}
      <div className="border border-[var(--border)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--bg-main)] text-[var(--text-muted)] text-left">
              <th className="px-4 py-3 font-medium">수집 시점</th>
              <th className="px-4 py-3 font-medium">상품명</th>
              <th className="px-4 py-3 font-medium">카테고리</th>
              <th className="px-4 py-3 font-medium text-right">이전 가격</th>
              <th className="px-4 py-3 font-medium text-right">변경 가격</th>
              <th className="px-4 py-3 font-medium text-right">변동</th>
              <th className="px-4 py-3 font-medium text-right">변동률</th>
              <th className="px-4 py-3 font-medium">출처</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-[var(--text-muted)]">
                  불러오는 중...
                </td>
              </tr>
            ) : history.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-[var(--text-muted)]">
                  해당 기간에 가격 변동 이력이 없습니다.
                </td>
              </tr>
            ) : (
              history.map((h) => {
                const isUp = h.change_amount > 0;
                const isAlert = Math.abs(h.change_rate) >= 10;
                const isHighAlert = Math.abs(h.change_rate) >= 5;
                const rowBg = isAlert
                  ? "bg-red-500/5"
                  : isHighAlert
                  ? "bg-yellow-500/5"
                  : "";

                return (
                  <tr key={h.id} className={`border-t border-[var(--border)] hover:bg-[var(--bg-main)] ${rowBg}`}>
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                      {new Date(h.scraped_at).toLocaleString("ko-KR", {
                        month: "2-digit", day: "2-digit",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-primary)] max-w-[250px] truncate">
                      {h.products.product_name}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {h.products.category || "-"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--text-secondary)]">
                      {h.previous_price.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-[var(--text-primary)]">
                      {h.new_price.toLocaleString()}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-medium ${isUp ? "text-red-400" : "text-blue-400"}`}>
                      {isUp ? "+" : ""}{h.change_amount.toLocaleString()}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-medium ${isUp ? "text-red-400" : "text-blue-400"}`}>
                      {isUp ? "+" : ""}{h.change_rate}%
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {h.source === "scrape" ? "자동" : "수동"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
