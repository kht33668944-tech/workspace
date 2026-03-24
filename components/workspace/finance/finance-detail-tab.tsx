"use client";

import React, { useState, useCallback } from "react";
import { Plus, X } from "lucide-react";
import { formatKRW } from "@/lib/finance-utils";
import type { DailySnapshot, CardEntry, PlatformEntry, CashEntry, DailySnapshotUpdate } from "@/types/database";
import type { SnapshotChanges } from "@/hooks/use-finance";

interface FinanceDetailTabProps {
  snapshot: DailySnapshot;
  changes: SnapshotChanges | null;
  onSave: (updates: DailySnapshotUpdate) => void;
}

const NumInput = React.memo(function NumInput({
  value,
  onChange,
  className = "",
  placeholder = "",
}: {
  value: number;
  onChange: (v: number) => void;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");

  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder={placeholder}
      value={editing ? raw : (value === 0 ? "" : value.toLocaleString("ko-KR"))}
      onFocus={() => {
        setEditing(true);
        setRaw(value === 0 ? "" : String(value));
      }}
      onChange={(e) => setRaw(e.target.value.replace(/[^0-9-]/g, ""))}
      onBlur={() => {
        setEditing(false);
        const num = parseInt(raw, 10);
        if (raw === "" && value !== 0) {
          onChange(0);
        } else if (!isNaN(num) && num !== value) {
          onChange(num);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={`w-full px-2 py-1 text-sm text-right bg-[var(--bg-main)] border border-[var(--border)] rounded outline-none focus:border-blue-400 text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] ${className}`}
    />
  );
});

function ChangeIndicator({ value, favorable = "down" }: { value: number | undefined; favorable?: "up" | "down" }) {
  if (!value) return null;
  const isGood = favorable === "up" ? value > 0 : value < 0;
  const color = isGood ? "text-green-400" : "text-red-400";
  return (
    <span className={`text-[10px] ${color} whitespace-nowrap`}>
      {value > 0 ? "+" : ""}{value.toLocaleString("ko-KR")}
    </span>
  );
}

export default function FinanceDetailTab({ snapshot, changes, onSave }: FinanceDetailTabProps) {
  const updateCard = useCallback(
    (idx: number, field: keyof CardEntry, value: number | string) => {
      const cards = [...snapshot.cards];
      const card = { ...cards[idx], [field]: value };
      if (field === "accumulated" || field === "daily_payment" || field === "installment") {
        card.total = card.accumulated + card.daily_payment + card.installment;
      }
      cards[idx] = card;
      onSave({ cards });
    },
    [snapshot.cards, onSave]
  );

  const addCard = useCallback(() => {
    const cards = [...snapshot.cards, { name: "새 카드", accumulated: 0, daily_payment: 0, installment: 0, total: 0 }];
    onSave({ cards });
  }, [snapshot.cards, onSave]);

  const removeCard = useCallback(
    (idx: number) => {
      const cards = snapshot.cards.filter((_, i) => i !== idx);
      onSave({ cards });
    },
    [snapshot.cards, onSave]
  );

  const updatePlatform = useCallback(
    (idx: number, field: keyof PlatformEntry, value: number | string) => {
      const platforms = [...snapshot.platforms];
      const plat = { ...platforms[idx], [field]: value };
      if (field === "delivered" || field === "shipping" || field === "cs") {
        plat.total = plat.delivered + plat.shipping - plat.cs;
      }
      platforms[idx] = plat;
      onSave({ platforms });
    },
    [snapshot.platforms, onSave]
  );

  const addPlatform = useCallback(() => {
    const platforms = [...snapshot.platforms, { name: "새 플랫폼", delivered: 0, shipping: 0, cs: 0, total: 0 }];
    onSave({ platforms });
  }, [snapshot.platforms, onSave]);

  const removePlatform = useCallback(
    (idx: number) => {
      const platforms = snapshot.platforms.filter((_, i) => i !== idx);
      onSave({ platforms });
    },
    [snapshot.platforms, onSave]
  );

  const updateCash = useCallback(
    (idx: number, field: keyof CashEntry, value: number | string) => {
      const cash = [...snapshot.cash];
      cash[idx] = { ...cash[idx], [field]: value };
      onSave({ cash });
    },
    [snapshot.cash, onSave]
  );

  const addCash = useCallback(() => {
    const cash = [...snapshot.cash, { name: "새 항목", amount: 0 }];
    onSave({ cash });
  }, [snapshot.cash, onSave]);

  const removeCash = useCallback(
    (idx: number) => {
      const cash = snapshot.cash.filter((_, i) => i !== idx);
      onSave({ cash });
    },
    [snapshot.cash, onSave]
  );

  const thClass = "px-2 py-2 text-xs font-medium text-[var(--text-muted)] text-left whitespace-nowrap";
  const tdClass = "px-1 py-1";

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            카드 지출
            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
              합계: {formatKRW(snapshot.total_cards)}
            </span>
          </h3>
          <button onClick={addCard} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-0.5">
            <Plus className="w-3 h-3" /> 추가
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className={thClass}>카드명</th>
                <th className={`${thClass} text-right`}>누적결제</th>
                <th className={`${thClass} text-right`}>당일결제</th>
                <th className={`${thClass} text-right`}>할부</th>
                <th className={`${thClass} text-right`}>총금액</th>
                <th className={`${thClass} text-right`}>결제일</th>
                <th className={`${thClass} text-right`}>납부액</th>
                <th className={thClass} style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {snapshot.cards.map((card, i) => {
                const chg = changes?.cards.find((c) => c.name === card.name);
                return (
                  <tr key={i} className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]">
                    <td className={tdClass}>
                      <input
                        type="text"
                        value={card.name}
                        onChange={(e) => updateCard(i, "name", e.target.value)}
                        className="w-full px-2 py-1 text-sm bg-transparent border-none outline-none text-[var(--text-primary)]"
                      />
                    </td>
                    <td className={tdClass}>
                      <NumInput value={card.accumulated} onChange={(v) => updateCard(i, "accumulated", v)} placeholder="0" />
                    </td>
                    <td className={tdClass}>
                      <NumInput value={card.daily_payment} onChange={(v) => updateCard(i, "daily_payment", v)} placeholder="0" />
                    </td>
                    <td className={tdClass}>
                      <NumInput value={card.installment} onChange={(v) => updateCard(i, "installment", v)} placeholder="0" />
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <div className="flex flex-col items-end">
                        <span className="text-sm font-medium text-[var(--text-primary)]">
                          {formatKRW(card.total)}
                        </span>
                        <ChangeIndicator value={chg?.totalChange} favorable="down" />
                      </div>
                    </td>
                    <td className={tdClass}>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={card.payment_day ?? ""}
                        placeholder="-"
                        onChange={(e) => updateCard(i, "payment_day", e.target.value ? parseInt(e.target.value) : 0)}
                        className="w-12 px-1 py-1 text-sm text-center bg-[var(--bg-main)] border border-[var(--border)] rounded outline-none focus:border-blue-400 text-[var(--text-primary)]"
                      />
                    </td>
                    <td className={tdClass}>
                      <NumInput value={card.payment_made ?? 0} onChange={(v) => updateCard(i, "payment_made", v)} placeholder="-" className="w-24" />
                    </td>
                    <td className={tdClass}>
                      <button onClick={() => removeCard(i)} className="p-1 text-[var(--text-muted)] hover:text-red-400 transition-colors">
                        <X className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            플랫폼 정산
            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
              합계: {formatKRW(snapshot.total_platforms)}
            </span>
          </h3>
          <button onClick={addPlatform} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-0.5">
            <Plus className="w-3 h-3" /> 추가
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className={thClass}>플랫폼</th>
                <th className={`${thClass} text-right`}>배송완료</th>
                <th className={`${thClass} text-right`}>배송중</th>
                <th className={`${thClass} text-right`}>CS</th>
                <th className={`${thClass} text-right`}>총금액</th>
                <th className={`${thClass} text-right`}>정산입금</th>
                <th className={thClass} style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {snapshot.platforms.map((plat, i) => {
                const chg = changes?.platforms.find((p) => p.name === plat.name);
                return (
                  <tr key={i} className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]">
                    <td className={tdClass}>
                      <input
                        type="text"
                        value={plat.name}
                        onChange={(e) => updatePlatform(i, "name", e.target.value)}
                        className="w-full px-2 py-1 text-sm bg-transparent border-none outline-none text-[var(--text-primary)]"
                      />
                    </td>
                    <td className={tdClass}>
                      <NumInput value={plat.delivered} onChange={(v) => updatePlatform(i, "delivered", v)} placeholder="0" />
                    </td>
                    <td className={tdClass}>
                      <NumInput value={plat.shipping} onChange={(v) => updatePlatform(i, "shipping", v)} placeholder="0" />
                    </td>
                    <td className={tdClass}>
                      <NumInput value={plat.cs} onChange={(v) => updatePlatform(i, "cs", v)} placeholder="0" />
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <div className="flex flex-col items-end">
                        <NumInput value={plat.total} onChange={(v) => updatePlatform(i, "total", v)} className="w-28 font-medium" placeholder="0" />
                        <ChangeIndicator value={chg?.totalChange} favorable="up" />
                      </div>
                    </td>
                    <td className={tdClass}>
                      <NumInput value={plat.settled_amount ?? 0} onChange={(v) => updatePlatform(i, "settled_amount", v)} className="w-24" placeholder="-" />
                    </td>
                    <td className={tdClass}>
                      <button onClick={() => removePlatform(i)} className="p-1 text-[var(--text-muted)] hover:text-red-400 transition-colors">
                        <X className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">보유 현금 & 결제중</h3>
          <button onClick={addCash} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-0.5">
            <Plus className="w-3 h-3" /> 추가
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)]">현금 항목</p>
            {snapshot.cash.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={c.name}
                  onChange={(e) => updateCash(i, "name", e.target.value)}
                  className="w-24 px-2 py-1 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded outline-none focus:border-blue-400 text-[var(--text-primary)]"
                />
                <NumInput value={c.amount} onChange={(v) => updateCash(i, "amount", v)} className="flex-1" placeholder="0" />
                <button onClick={() => removeCash(i)} className="p-1 text-[var(--text-muted)] hover:text-red-400 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)]">결제중 (매입 완료, 미출발)</p>
            <NumInput value={snapshot.pending_purchase} onChange={(v) => onSave({ pending_purchase: v })} placeholder="0" />
          </div>
        </div>
      </section>

      <section>
        <p className="text-xs text-[var(--text-muted)] mb-1">메모</p>
        <textarea
          value={snapshot.memo ?? ""}
          onChange={(e) => onSave({ memo: e.target.value })}
          placeholder="오늘의 메모..."
          rows={2}
          className="w-full px-3 py-2 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg outline-none focus:border-blue-400 text-[var(--text-primary)] resize-none"
        />
      </section>
    </div>
  );
}
