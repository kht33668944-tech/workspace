"use client";

import { useState, useEffect } from "react";
import { formatKRW } from "@/lib/finance-utils";
import type { DailySnapshot } from "@/types/database";

interface FinanceSummaryTabProps {
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

export default function FinanceSummaryTab({ fetchTrendData }: FinanceSummaryTabProps) {
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
      // 로컬(KST) 기준 YYYY-MM-DD — toISOString()(UTC)은 저녁 시간대에 하루 밀림
      const weekAgoStr = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, "0")}-${String(weekAgo.getDate()).padStart(2, "0")}`;
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      setSummary({
        weekStart: snapshots.find((s) => s.date >= weekAgoStr) ?? null,
        weekEnd: snapshots[snapshots.length - 1] ?? null,
        monthStart: snapshots.find((s) => s.date >= monthStart) ?? null,
        monthEnd: snapshots[snapshots.length - 1] ?? null,
      });
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [fetchTrendData]);

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
    </div>
  );
}
