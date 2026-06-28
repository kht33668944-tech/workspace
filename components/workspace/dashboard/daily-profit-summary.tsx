"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, CreditCard } from "lucide-react";
import SkeletonBlock from "./skeleton-block";
import type { DashboardDailyProfitRow, DashboardMonthlyProfitSummary } from "@/hooks/use-dashboard";

interface DailyProfitSummaryProps {
  rows: DashboardDailyProfitRow[];
  summary: DashboardMonthlyProfitSummary;
  loading: boolean;
}

function formatKRW(value: number): string {
  return "₩" + value.toLocaleString("ko-KR");
}

function formatDateLabel(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

function Money({ value, strong = false }: { value: number; strong?: boolean }) {
  const color = value < 0 ? "text-red-400" : strong ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]";
  return <span className={`${color} ${strong ? "font-semibold" : ""}`}>{formatKRW(value)}</span>;
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-[var(--text-primary)]";
  return (
    <div className="min-w-0">
      <p className="text-xs text-[var(--text-muted)] mb-1 truncate">{label}</p>
      <p className={`text-lg md:text-xl font-bold truncate ${color}`}>{formatKRW(value)}</p>
    </div>
  );
}

function CardUsageList({ cards }: { cards: DashboardDailyProfitRow["cards"] }) {
  if (cards.length === 0) {
    return <p className="text-xs text-[var(--text-muted)]">카드 사용 기록이 없습니다.</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {cards.map((card) => (
        <div
          key={card.name}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] px-2.5 py-1.5 text-xs"
        >
          <CreditCard className="h-3.5 w-3.5 text-blue-400" />
          <span className="text-[var(--text-secondary)]">{card.name}</span>
          <span className="font-semibold text-[var(--text-primary)]">{formatKRW(card.amount)}</span>
          <span className="text-[var(--text-muted)]">{card.count}건</span>
        </div>
      ))}
    </div>
  );
}

export default function DailyProfitSummary({ rows, summary, loading }: DailyProfitSummaryProps) {
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  const toggleDate = (date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 md:p-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-secondary)]">이번 달 손익</h2>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            매출은 배송완료일, 카드 사용은 구매일, 반품은 반품완료일 기준
          </p>
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          {!loading && (
            <p className="text-xs text-[var(--text-muted)]">
              배송완료 {summary.deliveredCount.toLocaleString("ko-KR")}건 · 반품완료 {summary.returnCount.toLocaleString("ko-KR")}건 · 구매 {summary.cardCount.toLocaleString("ko-KR")}건
            </p>
          )}
          <Link
            href="/workspace/finance?tab=order-profit"
            className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            자세히 보기
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-5">
          <SummaryMetric label="매출" value={summary.netRevenue} />
          <SummaryMetric label="정산예정" value={summary.netSettlement} />
          <SummaryMetric label="원가" value={summary.netCost} />
          <SummaryMetric label="예상 마진" value={summary.netMargin} tone={summary.netMargin >= 0 ? "good" : "bad"} />
          <SummaryMetric label="반품 차감" value={summary.returnRevenue} tone="bad" />
          <SummaryMetric label="카드 사용" value={summary.cardSpend} />
        </div>
      )}

      {!loading && summary.cards.length > 0 && (
        <div className="mb-5 border-t border-[var(--border-subtle)] pt-4">
          <p className="text-xs font-medium text-[var(--text-muted)] mb-2">카드사별 이번 달 사용액</p>
          <CardUsageList cards={summary.cards} />
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="bg-[var(--bg-elevated)]">
              <th className="text-xs text-[var(--text-muted)] font-medium text-left py-2 px-3 rounded-l">날짜</th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-right py-2 px-3">배송완료</th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-right py-2 px-3">매출</th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-right py-2 px-3">정산예정</th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-right py-2 px-3">원가</th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-right py-2 px-3">마진</th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-right py-2 px-3">반품</th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-right py-2 px-3 rounded-r">카드사용</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-t border-[var(--border-subtle)]">
                  {Array.from({ length: 8 }).map((__, j) => (
                    <td key={j} className="py-3 px-3">
                      <SkeletonBlock className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center text-[var(--text-muted)] py-8 text-sm">
                  이번 달 손익 데이터가 없습니다.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const expanded = expandedDates.has(row.date);
                const hasDetail = row.cards.length > 0 || row.returnCount > 0;
                return (
                  <tr key={row.date} className="border-t border-[var(--border-subtle)]">
                    <td colSpan={8} className="p-0">
                      <button
                        type="button"
                        onClick={() => hasDetail && toggleDate(row.date)}
                        className={`grid w-full grid-cols-[140px_repeat(7,minmax(90px,1fr))] items-center px-3 py-2.5 text-left transition-colors ${hasDetail ? "hover:bg-[var(--bg-hover)]" : "cursor-default"}`}
                      >
                        <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-primary)] whitespace-nowrap">
                          {hasDetail ? (
                            expanded ? <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                          ) : (
                            <span className="h-3.5 w-3.5" />
                          )}
                          {formatDateLabel(row.date)}
                        </span>
                        <span className="text-right text-xs text-[var(--text-secondary)]">{row.deliveredCount.toLocaleString("ko-KR")}건</span>
                        <span className="text-right text-xs"><Money value={row.netRevenue} /></span>
                        <span className="text-right text-xs"><Money value={row.netSettlement} /></span>
                        <span className="text-right text-xs"><Money value={row.netCost} /></span>
                        <span className="text-right text-xs"><Money value={row.netMargin} strong /></span>
                        <span className="text-right text-xs text-red-400">
                          {row.returnCount > 0 ? `${row.returnCount.toLocaleString("ko-KR")}건 · -${formatKRW(row.returnRevenue)}` : "-"}
                        </span>
                        <span className="text-right text-xs"><Money value={row.cardSpend} /></span>
                      </button>
                      {expanded && (
                        <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-5 py-3">
                          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
                            <CardUsageList cards={row.cards} />
                            <div className="text-xs text-[var(--text-muted)] md:text-right">
                              반품 {row.returnCount.toLocaleString("ko-KR")}건 · 반품 정산 {formatKRW(row.returnSettlement)} · 반품 원가 {formatKRW(row.returnCost)}
                            </div>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
