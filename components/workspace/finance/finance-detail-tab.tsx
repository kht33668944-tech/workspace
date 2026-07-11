"use client";

import React, { useCallback, useMemo, useState } from "react";
import { CreditCard, Plus, ReceiptText, Trash2, X } from "lucide-react";
import {
  calcPlatformTotal,
  formatKRW,
  getCardPaymentTotal,
  getCardPersonalExcluded,
  normalizeCard,
  normalizePlatform,
} from "@/lib/finance-utils";
import type { CardEntry, CashEntry, DailySnapshot, DailySnapshotUpdate, PlatformEntry } from "@/types/database";

interface FinanceDetailTabProps {
  snapshot: DailySnapshot;
  prevSnapshot: DailySnapshot | null;
  onSave: (updates: DailySnapshotUpdate) => void;
}

const NumInput = React.memo(function NumInput({
  value,
  onChange,
  className = "",
  placeholder = "0",
  disabled = false,
}: {
  value: number;
  onChange: (v: number) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");

  return (
    <input
      type="text"
      inputMode="numeric"
      disabled={disabled}
      placeholder={placeholder}
      value={editing ? raw : value === 0 ? "" : value.toLocaleString("ko-KR")}
      onFocus={() => {
        if (disabled) return;
        setEditing(true);
        setRaw(value === 0 ? "" : String(value));
      }}
      onChange={(e) => setRaw(e.target.value.replace(/[^0-9-]/g, ""))}
      onBlur={() => {
        setEditing(false);
        const num = parseInt(raw, 10);
        if (raw === "" && value !== 0) onChange(0);
        else if (!isNaN(num) && num !== value) onChange(num);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={`w-full rounded border border-[var(--border)] bg-[var(--bg-main)] px-2 py-1 text-right text-sm text-[var(--text-primary)] outline-none focus:border-blue-400 disabled:cursor-default disabled:text-[var(--text-muted)] ${className}`}
    />
  );
});

function ChangeValue({ value, favorable = "up" }: { value: number; favorable?: "up" | "down" }) {
  if (value === 0) return null;
  const isGood = favorable === "up" ? value > 0 : value < 0;
  return (
    <span className={`text-xs font-semibold ${isGood ? "text-green-400" : "text-red-400"}`}>
      {formatKRW(value, true)}
    </span>
  );
}

function prevByName<T extends { name: string }>(items: T[] | undefined, name: string): T | null {
  return items?.find((item) => item.name === name) ?? null;
}

function namesFrom<T extends { name: string }>(left: T[], right: T[]): string[] {
  return [...new Set([...left.map((item) => item.name), ...right.map((item) => item.name)])];
}

function SectionHeader({
  title,
  total,
  icon,
  action,
}: {
  title: string;
  total?: number;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        {icon}
        {title}
        {total !== undefined && <span className="text-xs font-normal text-[var(--text-muted)]">합계 {formatKRW(total)}</span>}
      </h3>
      {action}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)]">
      <div className="border-b border-[var(--border-subtle)] px-3 py-2">
        <p className="text-xs font-semibold text-[var(--text-muted)]">{title}</p>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

const th = "px-2 py-2 text-left text-xs font-medium text-[var(--text-muted)] whitespace-nowrap";
const td = "px-2 py-2 align-middle";

export default function FinanceDetailTab({ snapshot, prevSnapshot, onSave }: FinanceDetailTabProps) {
  const [paymentTarget, setPaymentTarget] = useState<number | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMemo, setPaymentMemo] = useState("");

  const cards = useMemo(() => snapshot.cards.map(normalizeCard), [snapshot.cards]);
  const prevCards = useMemo(() => (prevSnapshot?.cards ?? []).map(normalizeCard), [prevSnapshot?.cards]);
  const platforms = useMemo(() => snapshot.platforms.map(normalizePlatform), [snapshot.platforms]);
  const prevPlatforms = useMemo(() => (prevSnapshot?.platforms ?? []).map(normalizePlatform), [prevSnapshot?.platforms]);

  const updateCard = useCallback(
    (idx: number, updates: Partial<CardEntry>) => {
      const next = snapshot.cards.map((card, i) => (i === idx ? normalizeCard({ ...card, ...updates }) : normalizeCard(card)));
      onSave({ cards: next });
    },
    [snapshot.cards, onSave]
  );

  const addCard = useCallback(() => {
    onSave({
      cards: [
        ...snapshot.cards.map(normalizeCard),
        normalizeCard({ name: "새 카드", accumulated: 0, daily_payment: 0, installment: 0, personal_excluded: 0, payments: [], total: 0 }),
      ],
    });
  }, [snapshot.cards, onSave]);

  const removeCard = useCallback(
    (idx: number) => {
      onSave({ cards: snapshot.cards.filter((_, i) => i !== idx).map(normalizeCard) });
    },
    [snapshot.cards, onSave]
  );

  const openPayment = (idx: number) => {
    setPaymentTarget(idx);
    setPaymentAmount("");
    setPaymentMemo("");
  };

  const closePayment = () => {
    setPaymentTarget(null);
    setPaymentAmount("");
    setPaymentMemo("");
  };

  const addPayment = () => {
    if (paymentTarget === null) return;
    const amount = parseInt(paymentAmount.replace(/[^0-9-]/g, ""), 10);
    if (!amount || amount <= 0) return;

    const next = snapshot.cards.map((card, i) => {
      if (i !== paymentTarget) return normalizeCard(card);
      return normalizeCard({
        ...card,
        payments: [...(card.payments ?? []), { date: snapshot.date, amount, memo: paymentMemo.trim() || undefined }],
      });
    });
    onSave({ cards: next });
    closePayment();
  };

  const removePayment = (cardIdx: number, paymentIdx: number) => {
    const next = snapshot.cards.map((card, i) => {
      if (i !== cardIdx) return normalizeCard(card);
      return normalizeCard({ ...card, payments: (card.payments ?? []).filter((_, j) => j !== paymentIdx) });
    });
    onSave({ cards: next });
  };

  const updatePlatform = useCallback(
    (idx: number, updates: Partial<PlatformEntry>) => {
      const next = snapshot.platforms.map((platform, i) => (i === idx ? normalizePlatform({ ...platform, ...updates }) : normalizePlatform(platform)));
      onSave({ platforms: next });
    },
    [snapshot.platforms, onSave]
  );

  const addPlatform = useCallback(() => {
    onSave({
      platforms: [
        ...snapshot.platforms.map(normalizePlatform),
        normalizePlatform({ name: "새 플랫폼", delivered: 0, shipping: 0, cs: 0, total: 0 }),
      ],
    });
  }, [snapshot.platforms, onSave]);

  const removePlatform = useCallback(
    (idx: number) => {
      onSave({ platforms: snapshot.platforms.filter((_, i) => i !== idx).map(normalizePlatform) });
    },
    [snapshot.platforms, onSave]
  );

  const updateCash = useCallback(
    (idx: number, updates: Partial<CashEntry>) => {
      onSave({ cash: snapshot.cash.map((item, i) => (i === idx ? { ...item, ...updates } : item)) });
    },
    [snapshot.cash, onSave]
  );

  const addCash = useCallback(() => {
    onSave({ cash: [...snapshot.cash, { name: "새 항목", amount: 0 }] });
  }, [snapshot.cash, onSave]);

  const removeCash = useCallback(
    (idx: number) => {
      onSave({ cash: snapshot.cash.filter((_, i) => i !== idx) });
    },
    [snapshot.cash, onSave]
  );

  return (
    <div className="space-y-5">
      <section>
        <SectionHeader
          title="카드 지출"
          total={snapshot.total_cards}
          icon={<CreditCard className="h-4 w-4 text-blue-400" />}
          action={
            <button onClick={addCard} className="flex min-h-[36px] items-center gap-1 rounded-lg px-2 text-xs text-blue-400 hover:bg-[var(--bg-hover)]">
              <Plus className="h-3.5 w-3.5" /> 카드 추가
            </button>
          }
        />
        <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
          <Panel title="전날 카드 데이터">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className={th}>카드</th>
                    <th className={`${th} text-right`}>시작 카드값</th>
                    <th className={`${th} text-right`}>자동구매</th>
                    <th className={`${th} text-right`}>납부</th>
                    <th className={`${th} text-right`}>개인사용 제외</th>
                    <th className={`${th} text-right`}>전날 최종</th>
                  </tr>
                </thead>
                <tbody>
                  {namesFrom(prevCards, cards).map((name) => {
                    const prev = prevByName(prevCards, name);
                    const paid = prev ? getCardPaymentTotal(prev) : 0;
                    const excluded = prev ? getCardPersonalExcluded(prev) : 0;
                    return (
                      <tr key={name} className="border-b border-[var(--border-subtle)] last:border-0">
                        <td className={`${td} text-[var(--text-secondary)]`}>{name}</td>
                        <td className={`${td} text-right text-[var(--text-muted)]`}>{formatKRW(prev?.accumulated ?? 0)}</td>
                        <td className={`${td} text-right text-[var(--text-muted)]`}>{formatKRW(prev?.daily_payment ?? 0)}</td>
                        <td className={`${td} text-right text-[var(--text-muted)]`}>{formatKRW(paid)}</td>
                        <td className={`${td} text-right text-[var(--text-muted)]`}>{formatKRW(excluded)}</td>
                        <td className={`${td} text-right`}>
                          <span className="block font-semibold text-[var(--text-secondary)]">{formatKRW(prev?.total ?? 0)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="오늘 카드 입력">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className={th}>카드</th>
                    <th className={`${th} text-right`}>전날 최종값</th>
                    <th className={`${th} text-right`}>자동구매</th>
                    <th className={`${th} text-right`}>납부</th>
                    <th className={`${th} text-right`}>개인사용 제외</th>
                    <th className={`${th} text-right`}>오늘 최종</th>
                    <th className={th}>납부 기록</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((card, i) => {
                    const prev = prevByName(prevCards, card.name);
                    const paid = getCardPaymentTotal(card);
                    const excluded = getCardPersonalExcluded(card);
                    return (
                      <tr key={`${card.name}-${i}`} className="border-b border-[var(--border-subtle)] last:border-0">
                        <td className={td}>
                          <input
                            value={card.name}
                            onChange={(e) => updateCard(i, { name: e.target.value })}
                            className="w-24 rounded border border-transparent bg-transparent px-2 py-1 text-[var(--text-primary)] outline-none focus:border-blue-400"
                          />
                        </td>
                        <td className={td}>
                          <NumInput value={card.accumulated} onChange={(v) => updateCard(i, { accumulated: v })} className="w-24" />
                        </td>
                        <td className={td}><NumInput value={card.daily_payment} onChange={() => undefined} disabled /></td>
                        <td className={td}>
                          <div className="flex items-center justify-end gap-2">
                            <span className="w-20 text-right text-[var(--text-secondary)]">{formatKRW(paid)}</span>
                            <button onClick={() => openPayment(i)} className="min-h-[28px] rounded bg-blue-600 px-1.5 text-[11px] text-white hover:bg-blue-500">납부</button>
                          </div>
                        </td>
                        <td className={td}>
                          <NumInput value={excluded} onChange={(v) => updateCard(i, { personal_excluded: v, installment: v })} className="w-24" />
                        </td>
                        <td className={`${td} text-right`}>
                          <span className="block font-semibold text-[var(--text-primary)]">{formatKRW(card.total)}</span>
                          <ChangeValue value={card.total - (prev?.total ?? 0)} favorable="down" />
                        </td>
                        <td className={td}>
                          {(card.payments ?? []).length === 0 ? (
                            <span className="text-xs text-[var(--text-muted)]">-</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {(card.payments ?? []).map((payment, paymentIdx) => (
                                <button
                                  key={`${payment.date}-${payment.amount}-${paymentIdx}`}
                                  onClick={() => removePayment(i, paymentIdx)}
                                  className="inline-flex items-center gap-1 rounded bg-[var(--bg-main)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-red-400"
                                  title="클릭하면 납부 기록을 삭제합니다"
                                >
                                  {formatKRW(payment.amount)}
                                  <X className="h-3 w-3" />
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className={`${td} text-right`}>
                          <button onClick={() => removeCard(i)} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-red-400">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </section>

      <section>
        <SectionHeader
          title="플랫폼 정산"
          total={snapshot.total_platforms}
          icon={<ReceiptText className="h-4 w-4 text-green-400" />}
          action={
            <button onClick={addPlatform} className="flex min-h-[36px] items-center gap-1 rounded-lg px-2 text-xs text-blue-400 hover:bg-[var(--bg-hover)]">
              <Plus className="h-3.5 w-3.5" /> 플랫폼 추가
            </button>
          }
        />
        <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
          <Panel title="전날 플랫폼 데이터">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className={th}>플랫폼</th>
                    <th className={`${th} text-right`}>배송완료</th>
                    <th className={`${th} text-right`}>배송중</th>
                    <th className={`${th} text-right`}>CS</th>
                    <th className={`${th} text-right`}>총금액</th>
                  </tr>
                </thead>
                <tbody>
                  {namesFrom(prevPlatforms, platforms).map((name) => {
                    const prev = prevByName(prevPlatforms, name);
                    return (
                      <tr key={name} className="border-b border-[var(--border-subtle)] last:border-0">
                        <td className={`${td} text-[var(--text-secondary)]`}>{name}</td>
                        <td className={`${td} text-right text-[var(--text-secondary)]`}>{formatKRW(prev?.delivered ?? 0)}</td>
                        <td className={`${td} text-right text-[var(--text-secondary)]`}>{formatKRW(prev?.shipping ?? 0)}</td>
                        <td className={`${td} text-right text-[var(--text-secondary)]`}>{formatKRW(prev?.cs ?? 0)}</td>
                        <td className={`${td} text-right font-semibold text-[var(--text-secondary)]`}>{formatKRW(prev ? calcPlatformTotal(prev) : 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="오늘 플랫폼 입력">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[740px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className={th}>플랫폼</th>
                    <th className={`${th} text-right`}>오늘 총금액</th>
                    <th className={`${th} text-right`}>배송완료</th>
                    <th className={`${th} text-right`}>배송중</th>
                    <th className={`${th} text-right`}>카드취소 대기금</th>
                    <th className={`${th} text-right`}>정산입금</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {platforms.map((platform, i) => {
                    const prev = prevByName(prevPlatforms, platform.name);
                    return (
                      <tr key={`${platform.name}-${i}`} className="border-b border-[var(--border-subtle)] last:border-0">
                        <td className={td}>
                          <input
                            value={platform.name}
                            onChange={(e) => updatePlatform(i, { name: e.target.value })}
                            className="w-24 rounded border border-transparent bg-transparent px-2 py-1 text-[var(--text-primary)] outline-none focus:border-blue-400"
                          />
                        </td>
                        <td className={`${td} text-right`}>
                          <span className="block font-semibold text-[var(--text-primary)]">{formatKRW(calcPlatformTotal(platform))}</span>
                          <ChangeValue value={calcPlatformTotal(platform) - (prev?.total ?? 0)} favorable="up" />
                        </td>
                        <td className={td}><NumInput value={platform.delivered} onChange={(v) => updatePlatform(i, { delivered: v })} /></td>
                        <td className={td}><NumInput value={platform.shipping} onChange={(v) => updatePlatform(i, { shipping: v })} /></td>
                        <td className={td}><NumInput value={platform.cs} onChange={(v) => updatePlatform(i, { cs: v })} /></td>
                        <td className={td}><NumInput value={platform.settled_amount ?? 0} onChange={(v) => updatePlatform(i, { settled_amount: v })} /></td>
                        <td className={`${td} text-right`}>
                          <button onClick={() => removePlatform(i)} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-red-400">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </section>

      <section>
        <SectionHeader
          title="현금 & 결제중"
          action={
            <button onClick={addCash} className="flex min-h-[36px] items-center gap-1 rounded-lg px-2 text-xs text-blue-400 hover:bg-[var(--bg-hover)]">
              <Plus className="h-3.5 w-3.5" /> 현금 항목 추가
            </button>
          }
        />
        <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
          <Panel title="전날 현금 데이터">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[360px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className={th}>항목</th>
                    <th className={`${th} text-right`}>금액</th>
                  </tr>
                </thead>
                <tbody>
                  {namesFrom(prevSnapshot?.cash ?? [], snapshot.cash).map((name) => {
                    const prev = prevByName(prevSnapshot?.cash ?? [], name);
                    return (
                      <tr key={name} className="border-b border-[var(--border-subtle)] last:border-0">
                        <td className={`${td} text-[var(--text-secondary)]`}>{name}</td>
                        <td className={`${td} text-right text-[var(--text-secondary)]`}>{formatKRW(prev?.amount ?? 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-[var(--border-subtle)] pt-3 text-sm">
              <span className="text-[var(--text-muted)]">전날 결제중</span>
              <span className="text-[var(--text-secondary)]">{formatKRW(prevSnapshot?.pending_purchase ?? 0)}</span>
            </div>
          </Panel>

          <Panel title="오늘 현금 입력">
            <div className="space-y-3">
              {snapshot.cash.map((cash, i) => {
                const prev = prevByName(prevSnapshot?.cash ?? [], cash.name);
                return (
                  <div key={`${cash.name}-${i}`} className="grid grid-cols-[120px_1fr_auto_auto] items-center gap-2">
                    <input
                      value={cash.name}
                      onChange={(e) => updateCash(i, { name: e.target.value })}
                      className="rounded border border-[var(--border)] bg-[var(--bg-main)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none focus:border-blue-400"
                    />
                    <NumInput value={cash.amount} onChange={(v) => updateCash(i, { amount: v })} />
                    <ChangeValue value={cash.amount - (prev?.amount ?? 0)} favorable="up" />
                    <button onClick={() => removeCash(i)} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-red-400">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              <div className="grid grid-cols-[120px_1fr_auto] items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
                <span className="text-sm text-[var(--text-muted)]">오늘 결제중</span>
                <NumInput value={snapshot.pending_purchase} onChange={(v) => onSave({ pending_purchase: v })} />
                <ChangeValue value={snapshot.pending_purchase - (prevSnapshot?.pending_purchase ?? 0)} favorable="up" />
              </div>
            </div>
          </Panel>
        </div>
      </section>

      <section>
        <p className="mb-1 text-xs text-[var(--text-muted)]">메모</p>
        <textarea
          value={snapshot.memo ?? ""}
          onChange={(e) => onSave({ memo: e.target.value })}
          placeholder="오늘 확인한 내용..."
          rows={2}
          className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-main)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-400"
        />
      </section>

      {paymentTarget !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                {snapshot.cards[paymentTarget]?.name ?? "카드"} 납부하기
              </h4>
              <button onClick={closePayment} className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block text-xs text-[var(--text-muted)]">
                납부 금액
                <input
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value.replace(/[^0-9]/g, ""))}
                  inputMode="numeric"
                  autoFocus
                  className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-main)] px-3 py-2 text-right text-sm text-[var(--text-primary)] outline-none focus:border-blue-400"
                />
              </label>
              <label className="block text-xs text-[var(--text-muted)]">
                메모
                <input
                  value={paymentMemo}
                  onChange={(e) => setPaymentMemo(e.target.value)}
                  placeholder="선택 입력"
                  className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-main)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-400"
                />
              </label>
              <div className="flex justify-end gap-2">
                <button onClick={closePayment} className="min-h-[38px] rounded border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">취소</button>
                <button onClick={addPayment} className="min-h-[38px] rounded bg-blue-600 px-3 text-sm text-white hover:bg-blue-500">저장</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
