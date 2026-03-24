"use client";

import { useMemo } from "react";
import SkeletonBlock from "@/components/workspace/dashboard/skeleton-block";
import { formatKRW, getNextPaymentDay } from "@/lib/finance-utils";
import type { DailySnapshot, CardEntry } from "@/types/database";
import type { SnapshotChanges } from "@/hooks/use-finance";

interface FinanceKpiCardsProps {
  snapshot: DailySnapshot | null;
  changes: SnapshotChanges | null;
  loading: boolean;
}

function ChangeBadge({ value, favorable }: { value: number; favorable: "up" | "down" }) {
  if (value === 0) return null;
  const isGood = favorable === "up" ? value > 0 : value < 0;
  const color = isGood ? "text-green-400" : "text-red-400";
  const arrow = value > 0 ? "▲" : "▼";
  return (
    <span className={`text-xs font-medium ${color}`}>
      {arrow} {formatKRW(value)}
    </span>
  );
}

export default function FinanceKpiCards({ snapshot, changes, loading }: FinanceKpiCardsProps) {
  const nearestCard = useMemo(() => {
    return (snapshot?.cards ?? [])
      .filter((c: CardEntry) => c.payment_day && c.payment_day > 0)
      .map((c: CardEntry) => ({
        name: c.name,
        ...getNextPaymentDay(c.payment_day!),
        amount: c.total,
      }))
      .sort((a, b) => a.daysLeft - b.daysLeft)[0] ?? null;
  }, [snapshot?.cards]);

  const cards = [
    {
      label: "총 카드값",
      value: snapshot?.total_cards ?? 0,
      change: changes?.totalCards ?? 0,
      favorable: "down" as const,
      borderClass: "",
    },
    {
      label: "총 정산예정",
      value: snapshot?.total_platforms ?? 0,
      change: changes?.totalPlatforms ?? 0,
      favorable: "up" as const,
      borderClass: "",
    },
    {
      label: "보유 현금",
      value: snapshot?.total_cash ?? 0,
      change: changes?.totalCash ?? 0,
      favorable: "up" as const,
      borderClass: "",
    },
    {
      label: "순잔액",
      value: snapshot?.net_balance ?? 0,
      change: changes?.netBalance ?? 0,
      favorable: "up" as const,
      borderClass: (snapshot?.net_balance ?? 0) >= 0
        ? "border-green-500/30"
        : "border-red-500/30",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      {cards.map((card, idx) => (
        <div
          key={card.label}
          className={`bg-[var(--bg-card)] border ${card.borderClass || "border-[var(--border)]"} rounded-xl p-4 md:p-5`}
        >
          <p className="text-xs text-[var(--text-muted)] mb-2">{card.label}</p>
          {loading ? (
            <SkeletonBlock className="h-7 w-28 mb-2" />
          ) : (
            <p
              className={`text-2xl font-bold mb-1 truncate ${
                card.label === "순잔액" && card.value < 0
                  ? "text-red-400"
                  : "text-[var(--text-primary)]"
              }`}
            >
              {formatKRW(card.value)}
            </p>
          )}
          {loading ? (
            <SkeletonBlock className="h-4 w-20" />
          ) : (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                <ChangeBadge value={card.change} favorable={card.favorable} />
                {card.change !== 0 && <span>전일 대비</span>}
              </div>
              {idx === 3 && nearestCard && (
                <span
                  className={`text-[10px] mt-0.5 ${
                    nearestCard.daysLeft <= 3 ? "text-red-400" : "text-[var(--text-muted)]"
                  }`}
                >
                  {nearestCard.name} D-{nearestCard.daysLeft} · -{formatKRW(nearestCard.amount)}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
