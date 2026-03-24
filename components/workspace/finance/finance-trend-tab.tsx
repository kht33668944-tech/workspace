"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import type { DailySnapshot } from "@/types/database";

const ResponsiveContainer = dynamic(
  () => import("recharts").then((m) => m.ResponsiveContainer),
  { ssr: false }
);
const LineChart = dynamic(
  () => import("recharts").then((m) => m.LineChart),
  { ssr: false }
);
const Line = dynamic(
  () => import("recharts").then((m) => m.Line),
  { ssr: false }
);
const XAxis = dynamic(
  () => import("recharts").then((m) => m.XAxis),
  { ssr: false }
);
const YAxis = dynamic(
  () => import("recharts").then((m) => m.YAxis),
  { ssr: false }
);
const Tooltip = dynamic(
  () => import("recharts").then((m) => m.Tooltip),
  { ssr: false }
);
const CartesianGrid = dynamic(
  () => import("recharts").then((m) => m.CartesianGrid),
  { ssr: false }
);
const Legend = dynamic(
  () => import("recharts").then((m) => m.Legend),
  { ssr: false }
);

interface FinanceTrendTabProps {
  fetchTrendData: (days: number) => Promise<DailySnapshot[]>;
}

type Period = 7 | 30 | 0;

function formatManWon(value: number): string {
  const man = value / 10000;
  return man.toFixed(0) + "만";
}

function formatDate(dateStr: string): string {
  const parts = dateStr.split("-");
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3 shadow-lg text-xs">
      <p className="text-[var(--text-muted)] mb-1">{label}</p>
      {payload.map((entry: { color: string; name: string; value: number }, i: number) => (
        <p key={i} style={{ color: entry.color }} className="font-medium">
          {entry.name}: ₩{entry.value.toLocaleString("ko-KR")}
        </p>
      ))}
    </div>
  );
}

export default function FinanceTrendTab({ fetchTrendData }: FinanceTrendTabProps) {
  const [period, setPeriod] = useState<Period>(30);
  const [data, setData] = useState<{ date: string; cards: number; platforms: number; balance: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTrendData(period).then((snapshots) => {
      if (cancelled) return;
      setData(
        snapshots.map((s) => ({
          date: formatDate(s.date),
          cards: s.total_cards,
          platforms: s.total_platforms,
          balance: s.net_balance,
        }))
      );
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [period, fetchTrendData]);

  const periods: { label: string; value: Period }[] = [
    { label: "7일", value: 7 },
    { label: "30일", value: 30 },
    { label: "전체", value: 0 },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {periods.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={`px-3 py-1 text-xs rounded-lg transition-colors ${
              period === p.value
                ? "bg-blue-600 text-white"
                : "bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-[var(--text-muted)] text-sm">
          로딩 중...
        </div>
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-64 text-[var(--text-muted)] text-sm">
          데이터가 없습니다. 스냅샷을 먼저 기록해주세요.
        </div>
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="date"
                tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
              />
              <YAxis
                tickFormatter={formatManWon}
                tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                width={55}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
              />
              <Line
                type="monotone"
                dataKey="cards"
                name="총 카드값"
                stroke="#f87171"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="platforms"
                name="총 정산예정"
                stroke="#60a5fa"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="balance"
                name="순잔액"
                stroke="#4ade80"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
