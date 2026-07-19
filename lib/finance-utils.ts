import type { CardEntry, PlatformEntry, CashEntry } from "@/types/database";

function numeric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function getCardPersonalExcluded(card: CardEntry): number {
  if (card.personal_excluded !== undefined) return numeric(card.personal_excluded);
  const legacyInstallment = numeric(card.installment);
  return legacyInstallment > 0 ? -legacyInstallment : legacyInstallment;
}

export function getCardPaymentTotal(card: CardEntry): number {
  const recordTotal = (card.payments ?? []).reduce((sum, payment) => sum + numeric(payment.amount), 0);
  return recordTotal + numeric(card.payment_made);
}

export function calcCardTotal(card: CardEntry): number {
  return numeric(card.accumulated) + numeric(card.daily_payment) - getCardPaymentTotal(card) + getCardPersonalExcluded(card);
}

export function normalizeCard(card: CardEntry): CardEntry {
  return {
    ...card,
    accumulated: numeric(card.accumulated),
    daily_payment: numeric(card.daily_payment),
    installment: numeric(card.installment),
    personal_excluded: getCardPersonalExcluded(card),
    payments: card.payments ?? [],
    total: calcCardTotal(card),
  };
}

export function calcPlatformTotal(platform: PlatformEntry): number {
  return numeric(platform.delivered) + numeric(platform.shipping) + numeric(platform.cs);
}

export function normalizePlatform(platform: PlatformEntry): PlatformEntry {
  return {
    ...platform,
    delivered: numeric(platform.delivered),
    shipping: numeric(platform.shipping),
    cs: numeric(platform.cs),
    settled_amount: numeric(platform.settled_amount),
    total: calcPlatformTotal(platform),
  };
}

export function recalcTotals(
  cards: CardEntry[],
  platforms: PlatformEntry[],
  cash: CashEntry[],
  pendingPurchase: number
) {
  const total_cards = cards.reduce((s, c) => s + calcCardTotal(c), 0);
  const total_platforms = platforms.reduce((s, p) => s + calcPlatformTotal(p), 0);
  const total_cash = cash.reduce((s, c) => s + numeric(c.amount), 0);
  const net_balance = total_platforms + total_cash + pendingPurchase - total_cards;
  return { total_cards, total_platforms, total_cash, net_balance };
}

export function getNextPaymentDay(day: number): { daysLeft: number; dateStr: string } {
  const now = new Date();
  // 결제일이 해당 월 말일보다 크면 말일로 클램프 (예: 2월 31일 → 2월 28/29일)
  const dayInMonth = (year: number, month: number) =>
    new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate()));
  const thisMonth = dayInMonth(now.getFullYear(), now.getMonth());
  const target = thisMonth > now ? thisMonth : dayInMonth(now.getFullYear(), now.getMonth() + 1);
  const diff = Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const m = String(target.getMonth() + 1).padStart(2, "0");
  const d = String(target.getDate()).padStart(2, "0");
  return { daysLeft: diff, dateStr: `${m}/${d}` };
}

export function formatKRW(value: number, withSign = false): string {
  const prefix = withSign ? (value >= 0 ? "+" : "") : (value < 0 ? "-" : "");
  return prefix + "₩" + Math.abs(value).toLocaleString("ko-KR");
}
