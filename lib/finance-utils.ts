import type { CardEntry, PlatformEntry, CashEntry } from "@/types/database";

export function recalcTotals(
  cards: CardEntry[],
  platforms: PlatformEntry[],
  cash: CashEntry[],
  pendingPurchase: number
) {
  const total_cards = cards.reduce((s, c) => s + c.total, 0);
  const total_platforms = platforms.reduce((s, p) => s + p.total, 0);
  const total_cash = cash.reduce((s, c) => s + c.amount, 0);
  const net_balance = total_platforms + total_cash + pendingPurchase - total_cards;
  return { total_cards, total_platforms, total_cash, net_balance };
}

export function getNextPaymentDay(day: number): { daysLeft: number; dateStr: string } {
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), day);
  const target = thisMonth > now ? thisMonth : new Date(now.getFullYear(), now.getMonth() + 1, day);
  const diff = Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const m = String(target.getMonth() + 1).padStart(2, "0");
  const d = String(target.getDate()).padStart(2, "0");
  return { daysLeft: diff, dateStr: `${m}/${d}` };
}

export function formatKRW(value: number, withSign = false): string {
  const prefix = withSign ? (value >= 0 ? "+" : "") : (value < 0 ? "-" : "");
  return prefix + "₩" + Math.abs(value).toLocaleString("ko-KR");
}
