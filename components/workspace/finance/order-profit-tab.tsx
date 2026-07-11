"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CreditCard, Store, TrendingUp } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import SkeletonBlock from "@/components/workspace/dashboard/skeleton-block";

type IssueType = "missing_cost" | "missing_settlement" | "missing_payment" | "missing_purchased_at" | "missing_delivered_at" | "missing_returned_at";
type OrderProfitKind = "delivered" | "purchased" | "returned" | "issue";

interface DetailOrder {
  id: string;
  kind: OrderProfitKind;
  issueType?: IssueType;
  date: string;
  marketplace: string | null;
  recipient_name: string | null;
  product_name: string | null;
  revenue: number;
  settlement: number;
  cost: number;
  margin: number;
  payment_method: string | null;
  purchase_source: string | null;
  purchase_order_no: string | null;
  tracking_no: string | null;
  delivery_status: string;
}

interface CardBucket {
  name: string;
  amount: number;
  count: number;
}

interface MarketplaceBucket {
  name: string;
  count: number;
  revenue: number;
  settlement: number;
  cost: number;
  margin: number;
  marginRate: number;
}

interface DailyRow {
  date: string;
  deliveredCount: number;
  deliveredRevenue: number;
  deliveredSettlement: number;
  deliveredCost: number;
  deliveredMargin: number;
  returnCount: number;
  returnRevenue: number;
  returnSettlement: number;
  returnCost: number;
  returnMargin: number;
  netRevenue: number;
  netSettlement: number;
  netCost: number;
  netMargin: number;
  cardSpend: number;
  cardCount: number;
  cards: CardBucket[];
  deliveredOrders: DetailOrder[];
  purchasedOrders: DetailOrder[];
  returnedOrders: DetailOrder[];
}

interface IssueSummary {
  type: IssueType;
  label: string;
  count: number;
  amount: number;
  orders: DetailOrder[];
}

interface Summary {
  month: string;
  deliveredCount: number;
  deliveredRevenue: number;
  deliveredSettlement: number;
  deliveredCost: number;
  deliveredMargin: number;
  returnCount: number;
  returnRevenue: number;
  returnSettlement: number;
  returnCost: number;
  returnMargin: number;
  netRevenue: number;
  netSettlement: number;
  netCost: number;
  netMargin: number;
  marginRate: number;
  cardSpend: number;
  cardCount: number;
}

interface OrderProfitData {
  month: string;
  summary: Summary;
  dailyRows: DailyRow[];
  cards: CardBucket[];
  marketplaces: MarketplaceBucket[];
  issues: IssueSummary[];
  orderCount: number;
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month: string, diff: number): string {
  const [year, monthNum] = month.split("-").map(Number);
  const d = new Date(year, monthNum - 1 + diff, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatKRW(value: number): string {
  return "₩" + value.toLocaleString("ko-KR");
}

function formatDateLabel(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

function shortText(value: string | null, fallback = "-"): string {
  return value?.trim() || fallback;
}

function Metric({ label, value, tone, suffix }: { label: string; value: number; tone?: "good" | "bad" | "neutral"; suffix?: string }) {
  const color = tone === "good" ? "text-green-400" : tone === "bad" ? "text-red-400" : "text-[var(--text-primary)]";
  return (
    <div className="min-w-0">
      <p className="text-xs text-[var(--text-muted)] mb-1 truncate">{label}</p>
      <p className={`text-xl font-bold truncate ${color}`}>{suffix ? `${value.toLocaleString("ko-KR")}${suffix}` : formatKRW(value)}</p>
    </div>
  );
}

function Money({ value, strong = false }: { value: number; strong?: boolean }) {
  const color = value < 0 ? "text-red-400" : strong ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]";
  return <span className={`${color} ${strong ? "font-semibold" : ""}`}>{formatKRW(value)}</span>;
}

interface CardMarketplaceRow {
  key: string;
  cardName: string;
  marketplace: string;
  count: number;
  revenue: number;
  settlement: number;
  cost: number;
  margin: number;
}

function normalizeName(value: string | null, fallback: string): string {
  return value?.trim() || fallback;
}

function buildCardMarketplaceRows(orders: DetailOrder[]): CardMarketplaceRow[] {
  const map = new Map<string, CardMarketplaceRow>();

  for (const order of orders) {
    const cardName = normalizeName(order.payment_method, "미확인");
    const marketplace = normalizeName(order.marketplace, "미입력");
    const key = `${cardName}::${marketplace}`;
    const row = map.get(key) ?? {
      key,
      cardName,
      marketplace,
      count: 0,
      revenue: 0,
      settlement: 0,
      cost: 0,
      margin: 0,
    };

    row.count += 1;
    row.revenue += order.revenue;
    row.settlement += order.settlement;
    row.cost += order.cost;
    row.margin += order.margin;
    map.set(key, row);
  }

  return [...map.values()].sort((a, b) => {
    const cardCompare = a.cardName.localeCompare(b.cardName, "ko-KR");
    if (cardCompare !== 0) return cardCompare;
    return b.cost - a.cost;
  });
}

function CardMarketplaceSummary({ orders }: { orders: DetailOrder[] }) {
  if (orders.length === 0) return null;

  const rows = buildCardMarketplaceRows(orders);
  const total = rows.reduce(
    (acc, row) => ({
      count: acc.count + row.count,
      revenue: acc.revenue + row.revenue,
      settlement: acc.settlement + row.settlement,
      cost: acc.cost + row.cost,
      margin: acc.margin + row.margin,
    }),
    { count: 0, revenue: 0, settlement: 0, cost: 0, margin: 0 }
  );

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-[var(--text-muted)]">카드 사용 판매처별 합계</p>
        <p className="text-xs text-[var(--text-muted)]">
          전체 {total.count.toLocaleString("ko-KR")}건 · <span className="text-[var(--text-primary)]">{formatKRW(total.cost)}</span>
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="bg-[var(--bg-main)] text-[var(--text-muted)]">
            <tr>
              <th className="px-2 py-2 text-left font-medium">카드</th>
              <th className="px-2 py-2 text-left font-medium">판매처</th>
              <th className="px-2 py-2 text-right font-medium">건수</th>
              <th className="px-2 py-2 text-right font-medium">매출</th>
              <th className="px-2 py-2 text-right font-medium">정산</th>
              <th className="px-2 py-2 text-right font-medium">원가</th>
              <th className="px-2 py-2 text-right font-medium">마진</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-[var(--border-subtle)]">
                <td className="px-2 py-2 text-[var(--text-secondary)]">{row.cardName}</td>
                <td className="px-2 py-2 text-[var(--text-primary)]">{row.marketplace}</td>
                <td className="px-2 py-2 text-right text-[var(--text-secondary)]">{row.count.toLocaleString("ko-KR")}건</td>
                <td className="px-2 py-2 text-right"><Money value={row.revenue} /></td>
                <td className="px-2 py-2 text-right"><Money value={row.settlement} /></td>
                <td className="px-2 py-2 text-right"><Money value={row.cost} /></td>
                <td className="px-2 py-2 text-right"><Money value={row.margin} strong /></td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-[var(--border)] bg-[var(--bg-main)]">
            <tr>
              <td className="px-2 py-2 font-semibold text-[var(--text-primary)]" colSpan={2}>전체 합계</td>
              <td className="px-2 py-2 text-right font-semibold text-[var(--text-primary)]">{total.count.toLocaleString("ko-KR")}건</td>
              <td className="px-2 py-2 text-right"><Money value={total.revenue} strong /></td>
              <td className="px-2 py-2 text-right"><Money value={total.settlement} strong /></td>
              <td className="px-2 py-2 text-right"><Money value={total.cost} strong /></td>
              <td className="px-2 py-2 text-right"><Money value={total.margin} strong /></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function OrderMiniTable({ title, orders }: { title: string; orders: DetailOrder[] }) {
  if (orders.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold text-[var(--text-muted)] mb-2">{title}</p>
      <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="bg-[var(--bg-main)] text-[var(--text-muted)]">
            <tr>
              <th className="px-2 py-2 text-left font-medium">판매처</th>
              <th className="px-2 py-2 text-left font-medium">수취인</th>
              <th className="px-2 py-2 text-left font-medium">상품</th>
              <th className="px-2 py-2 text-right font-medium">매출</th>
              <th className="px-2 py-2 text-right font-medium">정산</th>
              <th className="px-2 py-2 text-right font-medium">원가</th>
              <th className="px-2 py-2 text-right font-medium">마진</th>
              <th className="px-2 py-2 text-left font-medium">카드</th>
            </tr>
          </thead>
          <tbody>
            {orders.slice(0, 40).map((order) => (
              <tr key={`${order.kind}-${order.id}-${order.issueType ?? ""}`} className="border-t border-[var(--border-subtle)]">
                <td className="px-2 py-2 text-[var(--text-secondary)]">{shortText(order.marketplace)}</td>
                <td className="px-2 py-2 text-[var(--text-secondary)]">{shortText(order.recipient_name)}</td>
                <td className="px-2 py-2 text-[var(--text-primary)]">
                  <span className="block max-w-[240px] truncate" title={order.product_name ?? ""}>{shortText(order.product_name)}</span>
                </td>
                <td className="px-2 py-2 text-right"><Money value={order.revenue} /></td>
                <td className="px-2 py-2 text-right"><Money value={order.settlement} /></td>
                <td className="px-2 py-2 text-right"><Money value={order.cost} /></td>
                <td className="px-2 py-2 text-right"><Money value={order.margin} strong /></td>
                <td className="px-2 py-2 text-[var(--text-secondary)]">{shortText(order.payment_method)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {orders.length > 40 && <p className="mt-2 text-xs text-[var(--text-muted)]">상위 40건만 표시 중입니다.</p>}
    </div>
  );
}

function ChipList({ cards }: { cards: CardBucket[] }) {
  if (cards.length === 0) return <p className="text-xs text-[var(--text-muted)]">카드 사용 기록이 없습니다.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {cards.map((card) => (
        <div key={card.name} className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] px-2.5 py-1.5 text-xs">
          <CreditCard className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-[var(--text-secondary)]">{card.name}</span>
          <span className="font-semibold text-[var(--text-primary)]">{formatKRW(card.amount)}</span>
          <span className="text-[var(--text-muted)]">{card.count}건</span>
        </div>
      ))}
    </div>
  );
}

export default function OrderProfitTab() {
  const { session } = useAuth();
  const [month, setMonth] = useState(getCurrentMonth());
  const [data, setData] = useState<OrderProfitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [expandedIssues, setExpandedIssues] = useState<Set<IssueType>>(new Set());

  useEffect(() => {
    if (!session?.access_token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/finance/order-profit?month=${month}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "주문 손익 조회 실패");
        return res.json() as Promise<OrderProfitData>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [month, session?.access_token]);

  const issueTotal = useMemo(() => data?.issues.reduce((sum, issue) => sum + issue.count, 0) ?? 0, [data?.issues]);

  const toggleDate = (date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const toggleIssue = (type: IssueType) => {
    setExpandedIssues((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">주문 손익</h2>
          <p className="text-xs text-[var(--text-muted)] mt-1">배송완료일·구매일·반품완료일 기준으로 주문 손익을 검토합니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setMonth((m) => addMonths(m, -1))} className="px-3 py-2 min-h-[40px] text-sm rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">이전달</button>
          <input
            type="month"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="px-3 py-2 min-h-[40px] rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-sm text-[var(--text-primary)] outline-none"
          />
          <button onClick={() => setMonth((m) => addMonths(m, 1))} className="px-3 py-2 min-h-[40px] text-sm rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">다음달</button>
          <button onClick={() => setMonth(getCurrentMonth())} className="px-3 py-2 min-h-[40px] text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500">이번달</button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {loading || !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonBlock key={i} className="h-16 w-full" />)}
          </div>
          <SkeletonBlock className="h-72 w-full" />
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 md:grid-cols-7 gap-3">
            <div className="md:col-span-1 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
              <Metric label="주문수" value={data.orderCount} suffix="건" />
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4"><Metric label="매출" value={data.summary.netRevenue} /></div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4"><Metric label="정산예정" value={data.summary.netSettlement} /></div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4"><Metric label="원가" value={data.summary.netCost} /></div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4"><Metric label="순마진" value={data.summary.netMargin} tone={data.summary.netMargin >= 0 ? "good" : "bad"} /></div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4"><Metric label="마진율" value={data.summary.marginRate} suffix="%" tone={data.summary.marginRate >= 0 ? "good" : "bad"} /></div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4"><Metric label="확인 필요" value={issueTotal} suffix="건" tone={issueTotal > 0 ? "bad" : "good"} /></div>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2"><CreditCard className="w-4 h-4 text-blue-400" /> 카드사별 사용액</h3>
              <ChipList cards={data.cards} />
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2"><Store className="w-4 h-4 text-green-400" /> 판매처별 손익</h3>
              {data.marketplaces.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">판매처별 배송완료 데이터가 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {data.marketplaces.map((marketplace) => (
                    <div key={marketplace.name} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center text-xs">
                      <span className="font-medium text-[var(--text-primary)] truncate">{marketplace.name}</span>
                      <span className="text-[var(--text-muted)]">{marketplace.count}건</span>
                      <span className="text-[var(--text-secondary)]">{formatKRW(marketplace.revenue)}</span>
                      <span className={marketplace.margin >= 0 ? "text-green-400" : "text-red-400"}>{formatKRW(marketplace.margin)} · {marketplace.marginRate}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-yellow-400" /> 문제 데이터</h3>
            {data.issues.length === 0 ? (
              <p className="text-xs text-green-400">확인 필요한 주문 데이터가 없습니다.</p>
            ) : (
              <div className="space-y-2">
                {data.issues.map((issue) => {
                  const expanded = expandedIssues.has(issue.type);
                  return (
                    <div key={issue.type} className="rounded-lg border border-[var(--border-subtle)]">
                      <button onClick={() => toggleIssue(issue.type)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[var(--bg-hover)]">
                        <span className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                          {expanded ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />}
                          {issue.label}
                        </span>
                        <span className="text-xs text-red-400">{issue.count.toLocaleString("ko-KR")}건 · {formatKRW(issue.amount)}</span>
                      </button>
                      {expanded && <div className="p-3 border-t border-[var(--border-subtle)]"><OrderMiniTable title={issue.label} orders={issue.orders} /></div>}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-blue-400" /> 날짜별 손익</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="bg-[var(--bg-elevated)] text-xs text-[var(--text-muted)]">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium rounded-l">날짜</th>
                    <th className="px-3 py-2 text-right font-medium">배송완료</th>
                    <th className="px-3 py-2 text-right font-medium">매출</th>
                    <th className="px-3 py-2 text-right font-medium">정산예정</th>
                    <th className="px-3 py-2 text-right font-medium">원가</th>
                    <th className="px-3 py-2 text-right font-medium">마진</th>
                    <th className="px-3 py-2 text-right font-medium">반품</th>
                    <th className="px-3 py-2 text-right font-medium rounded-r">카드사용</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dailyRows.map((row) => {
                    const expanded = expandedDates.has(row.date);
                    const hasDetail = row.deliveredOrders.length > 0 || row.purchasedOrders.length > 0 || row.returnedOrders.length > 0;
                    return (
                      <tr key={row.date} className="border-t border-[var(--border-subtle)]">
                        <td colSpan={8} className="p-0">
                          <button
                            onClick={() => hasDetail && toggleDate(row.date)}
                            className={`grid w-full grid-cols-[150px_repeat(7,minmax(100px,1fr))] items-center px-3 py-2.5 text-left ${hasDetail ? "hover:bg-[var(--bg-hover)]" : "cursor-default"}`}
                          >
                            <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                              {hasDetail ? expanded ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" /> : <span className="w-4" />}
                              {formatDateLabel(row.date)}
                            </span>
                            <span className="text-right text-xs text-[var(--text-secondary)]">{row.deliveredCount}건</span>
                            <span className="text-right text-xs"><Money value={row.netRevenue} /></span>
                            <span className="text-right text-xs"><Money value={row.netSettlement} /></span>
                            <span className="text-right text-xs"><Money value={row.netCost} /></span>
                            <span className="text-right text-xs"><Money value={row.netMargin} strong /></span>
                            <span className="text-right text-xs text-red-400">{row.returnCount > 0 ? `${row.returnCount}건 · -${formatKRW(row.returnRevenue)}` : "-"}</span>
                            <span className="text-right text-xs"><Money value={row.cardSpend} /></span>
                          </button>
                          {expanded && (
                            <div className="space-y-4 border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4">
                              <ChipList cards={row.cards} />
                              <CardMarketplaceSummary orders={row.purchasedOrders} />
                              <OrderMiniTable title="배송완료 주문" orders={row.deliveredOrders} />
                              <OrderMiniTable title="구매/카드 사용 주문" orders={row.purchasedOrders} />
                              <OrderMiniTable title="반품완료 주문" orders={row.returnedOrders} />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
