"use client";

import { useState, useEffect } from "react";
import { CalendarClock } from "lucide-react";
import { formatKRW, getNextPaymentDay } from "@/lib/finance-utils";
import type { DailySnapshot, CardEntry } from "@/types/database";

interface FinanceSummaryTabProps {
  snapshot: DailySnapshot | null;
  fetchTrendData: (days: number) => Promise<DailySnapshot[]>;
}

interface SummaryData {
  weekStart: DailySnapshot | null;
  weekEnd: DailySnapshot | null;
  monthStart: DailySnapshot | null;
  monthEnd: DailySnapshot | null;
}

function SummaryCard({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: number; color: string }[];
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
      <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-3">{title}</h4>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between">
            <span className="text-sm text-[var(--text-secondary)]">{item.label}</span>
            <span className={`text-sm font-medium ${item.color}`}>
              {formatKRW(item.value, true)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FinanceSummaryTab({ snapshot, fetchTrendData }: FinanceSummaryTabProps) {
  const [summary, setSummary] = useState<SummaryData>({
    weekStart: null,
    weekEnd: null,
    monthStart: null,
    monthEnd: null,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchTrendData(31).then((snapshots) => {
      if (cancelled || snapshots.length === 0) {
        setLoading(false);
        return;
      }

      const now = new Date();
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      setSummary({
        weekStart: snapshots.find((s) => s.date >= weekAgo.toISOString().slice(0, 10)) ?? null,
        weekEnd: snapshots[snapshots.length - 1] ?? null,
        monthStart: snapshots.find((s) => s.date >= monthStart) ?? null,
        monthEnd: snapshots[snapshots.length - 1] ?? null,
      });
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [fetchTrendData]);

  const cardDDays = (snapshot?.cards ?? [])
    .filter((c: CardEntry) => c.payment_day && c.payment_day > 0)
    .map((c: CardEntry) => ({ name: c.name, ...getNextPaymentDay(c.payment_day!), amount: c.total }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-[var(--text-muted)] text-sm">
        요약 데이터 로딩 중...
      </div>
    );
  }

  const weekCardChange = (summary.weekEnd?.total_cards ?? 0) - (summary.weekStart?.total_cards ?? 0);
  const weekPlatformChange = (summary.weekEnd?.total_platforms ?? 0) - (summary.weekStart?.total_platforms ?? 0);
  const weekBalanceChange = (summary.weekEnd?.net_balance ?? 0) - (summary.weekStart?.net_balance ?? 0);

  const monthCardChange = (summary.monthEnd?.total_cards ?? 0) - (summary.monthStart?.total_cards ?? 0);
  const monthPlatformChange = (summary.monthEnd?.total_platforms ?? 0) - (summary.monthStart?.total_platforms ?? 0);
  const monthBalanceChange = (summary.monthEnd?.net_balance ?? 0) - (summary.monthStart?.net_balance ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SummaryCard
          title="주간 요약 (최근 7일)"
          items={[
            { label: "카드값 변동", value: weekCardChange, color: weekCardChange > 0 ? "text-red-400" : "text-green-400" },
            { label: "정산예정 변동", value: weekPlatformChange, color: weekPlatformChange > 0 ? "text-green-400" : "text-red-400" },
            { label: "순잔액 변동", value: weekBalanceChange, color: weekBalanceChange >= 0 ? "text-green-400" : "text-red-400" },
          ]}
        />
        <SummaryCard
          title="월간 요약 (이번 달)"
          items={[
            { label: "카드값 변동", value: monthCardChange, color: monthCardChange > 0 ? "text-red-400" : "text-green-400" },
            { label: "정산예정 변동", value: monthPlatformChange, color: monthPlatformChange > 0 ? "text-green-400" : "text-red-400" },
            { label: "순잔액 변동", value: monthBalanceChange, color: monthBalanceChange >= 0 ? "text-green-400" : "text-red-400" },
          ]}
        />
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
        <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-3 flex items-center gap-1">
          <CalendarClock className="w-3.5 h-3.5" />
          카드 결제일
        </h4>
        {cardDDays.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            카드 결제일을 입력하면 D-Day가 표시됩니다.
          </p>
        ) : (
          <div className="space-y-2">
            {cardDDays.map((c) => (
              <div key={c.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      c.daysLeft <= 3
                        ? "bg-red-500/10 text-red-400"
                        : c.daysLeft <= 7
                          ? "bg-yellow-500/10 text-yellow-400"
                          : "bg-[var(--bg-elevated)] text-[var(--text-muted)]"
                    }`}
                  >
                    D-{c.daysLeft}
                  </span>
                  <span className="text-sm text-[var(--text-primary)]">
                    {c.name} 결제일 ({c.dateStr})
                  </span>
                </div>
                <span className="text-sm font-medium text-red-400">
                  -{formatKRW(c.amount)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
