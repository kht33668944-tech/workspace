import { NextRequest, NextResponse } from "next/server";
import { fetchAllRows, getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getKoreanDateKey } from "@/lib/date-utils";

export const revalidate = 0;

type OrderProfitKind = "delivered" | "purchased" | "returned" | "issue";
type IssueType = "missing_cost" | "missing_settlement" | "missing_payment" | "missing_purchased_at" | "missing_delivered_at" | "missing_returned_at";

interface OrderProfitOrder {
  id: string;
  order_date: string | null;
  marketplace: string | null;
  recipient_name: string | null;
  product_name: string | null;
  revenue: number | null;
  settlement: number | null;
  cost: number | null;
  margin: number | null;
  payment_method: string | null;
  purchase_source: string | null;
  purchase_order_no: string | null;
  tracking_no: string | null;
  delivery_status: string;
  purchased_at: string | null;
  delivered_at: string | null;
  returned_at: string | null;
  updated_at: string;
}

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

interface MoneyBucket {
  count: number;
  revenue: number;
  settlement: number;
  cost: number;
  margin: number;
}

interface CardBucket {
  name: string;
  amount: number;
  count: number;
}

interface MarketplaceBucket extends MoneyBucket {
  name: string;
  marginRate: number;
}

interface DailyRow extends MoneyBucket {
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

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthDays(month: string): string[] {
  const [year, monthNum] = month.split("-").map(Number);
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === monthNum - 1;
  const lastDay = isCurrentMonth ? now.getDate() : new Date(year, monthNum, 0).getDate();
  const days: string[] = [];
  for (let day = 1; day <= lastDay; day++) {
    days.push(`${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  return days;
}

function localDateKey(value: string | null): string | null {
  return getKoreanDateKey(value);
}

function inMonth(date: string | null, month: string): boolean {
  return !!date && date.startsWith(month);
}

function eventDate(order: OrderProfitOrder, field: "purchased_at" | "delivered_at" | "returned_at", month: string): string | null {
  const eventKey = localDateKey(order[field]);
  if (inMonth(eventKey, month)) return eventKey;
  const orderKey = getKoreanDateKey(order.order_date);
  if (inMonth(orderKey, month)) return orderKey;
  return null;
}

function money(order: OrderProfitOrder): MoneyBucket {
  const revenue = order.revenue ?? 0;
  const settlement = order.settlement ?? 0;
  const cost = order.cost ?? 0;
  return {
    count: 1,
    revenue,
    settlement,
    cost,
    margin: order.margin ?? settlement - cost,
  };
}

function emptyDailyRow(date: string): DailyRow {
  return {
    date,
    count: 0,
    revenue: 0,
    settlement: 0,
    cost: 0,
    margin: 0,
    deliveredCount: 0,
    deliveredRevenue: 0,
    deliveredSettlement: 0,
    deliveredCost: 0,
    deliveredMargin: 0,
    returnCount: 0,
    returnRevenue: 0,
    returnSettlement: 0,
    returnCost: 0,
    returnMargin: 0,
    netRevenue: 0,
    netSettlement: 0,
    netCost: 0,
    netMargin: 0,
    cardSpend: 0,
    cardCount: 0,
    cards: [],
    deliveredOrders: [],
    purchasedOrders: [],
    returnedOrders: [],
  };
}

function addCard(map: Map<string, CardBucket>, name: string | null, amount: number) {
  const key = name?.trim() || "미확인";
  const current = map.get(key) ?? { name: key, amount: 0, count: 0 };
  current.amount += amount;
  current.count += 1;
  map.set(key, current);
}

function toDetail(order: OrderProfitOrder, kind: OrderProfitKind, date: string, issueType?: IssueType): DetailOrder {
  const m = money(order);
  return {
    id: order.id,
    kind,
    issueType,
    date,
    marketplace: order.marketplace,
    recipient_name: order.recipient_name,
    product_name: order.product_name,
    revenue: m.revenue,
    settlement: m.settlement,
    cost: m.cost,
    margin: m.margin,
    payment_method: order.payment_method,
    purchase_source: order.purchase_source,
    purchase_order_no: order.purchase_order_no,
    tracking_no: order.tracking_no,
    delivery_status: order.delivery_status,
  };
}

function addMoney(target: MoneyBucket, amount: MoneyBucket) {
  target.count += amount.count;
  target.revenue += amount.revenue;
  target.settlement += amount.settlement;
  target.cost += amount.cost;
  target.margin += amount.margin;
}

function rate(margin: number, settlement: number): number {
  if (settlement === 0) return 0;
  return Number(((margin / settlement) * 100).toFixed(1));
}

export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const searchParams = request.nextUrl.searchParams;
  const month = searchParams.get("month") || getCurrentMonth();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month는 YYYY-MM 형식이어야 합니다." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

    const rows = await fetchAllRows<OrderProfitOrder>((from, to) =>
      supabase
        .from("orders")
        .select("id,order_date,marketplace,recipient_name,product_name,revenue,settlement,cost,margin,payment_method,purchase_source,purchase_order_no,tracking_no,delivery_status,purchased_at,delivered_at,returned_at,updated_at")
        .eq("user_id", user.id)
        .eq("order_month", month)
        .order("order_date", { ascending: false })
        .range(from, to)
    );

    const dailyMap = new Map(getMonthDays(month).map((day) => [day, emptyDailyRow(day)]));
    const dailyCards = new Map([...dailyMap.keys()].map((day) => [day, new Map<string, CardBucket>()]));
    const cardMap = new Map<string, CardBucket>();
    const marketplaceMap = new Map<string, MarketplaceBucket>();
    const issueMap = new Map<IssueType, IssueSummary>();

    const summary: Summary = {
      month,
      deliveredCount: 0,
      deliveredRevenue: 0,
      deliveredSettlement: 0,
      deliveredCost: 0,
      deliveredMargin: 0,
      returnCount: 0,
      returnRevenue: 0,
      returnSettlement: 0,
      returnCost: 0,
      returnMargin: 0,
      netRevenue: 0,
      netSettlement: 0,
      netCost: 0,
      netMargin: 0,
      marginRate: 0,
      cardSpend: 0,
      cardCount: 0,
    };

    const ensureIssue = (type: IssueType, label: string): IssueSummary => {
      const current = issueMap.get(type) ?? { type, label, count: 0, amount: 0, orders: [] };
      issueMap.set(type, current);
      return current;
    };

    const pushIssue = (type: IssueType, label: string, order: OrderProfitOrder, amount: number) => {
      const issue = ensureIssue(type, label);
      issue.count += 1;
      issue.amount += amount;
      if (issue.orders.length < 100) {
        issue.orders.push(toDetail(order, "issue", getKoreanDateKey(order.order_date) ?? month + "-01", type));
      }
    };

    for (const order of rows) {
      const values = money(order);
      const deliveredDate = eventDate(order, "delivered_at", month);
      const purchasedDate = eventDate(order, "purchased_at", month);
      const returnedDate = eventDate(order, "returned_at", month);

      if (order.tracking_no?.trim()) {
        if (deliveredDate) {
          const daily = dailyMap.get(deliveredDate);
          if (daily) {
            daily.deliveredCount += 1;
            daily.deliveredRevenue += values.revenue;
            daily.deliveredSettlement += values.settlement;
            daily.deliveredCost += values.cost;
            daily.deliveredMargin += values.margin;
            daily.deliveredOrders.push(toDetail(order, "delivered", deliveredDate));
          }
          summary.deliveredCount += 1;
          summary.deliveredRevenue += values.revenue;
          summary.deliveredSettlement += values.settlement;
          summary.deliveredCost += values.cost;
          summary.deliveredMargin += values.margin;

          const marketplaceName = order.marketplace?.trim() || "미입력";
          const current = marketplaceMap.get(marketplaceName) ?? { name: marketplaceName, count: 0, revenue: 0, settlement: 0, cost: 0, margin: 0, marginRate: 0 };
          addMoney(current, values);
          current.marginRate = rate(current.margin, current.settlement);
          marketplaceMap.set(marketplaceName, current);
        }
        if (!order.delivered_at) pushIssue("missing_delivered_at", "배송완료일 누락", order, values.revenue);
      }

      if (order.delivery_status === "반품완료") {
        if (returnedDate) {
          const daily = dailyMap.get(returnedDate);
          if (daily) {
            daily.returnCount += 1;
            daily.returnRevenue += values.revenue;
            daily.returnSettlement += values.settlement;
            daily.returnCost += values.cost;
            daily.returnMargin += values.margin;
            daily.returnedOrders.push(toDetail(order, "returned", returnedDate));
          }
          summary.returnCount += 1;
          summary.returnRevenue += values.revenue;
          summary.returnSettlement += values.settlement;
          summary.returnCost += values.cost;
          summary.returnMargin += values.margin;
        }
        if (!order.returned_at) pushIssue("missing_returned_at", "반품완료일 누락", order, values.revenue);
      }

      if (order.purchase_order_no?.trim()) {
        if (purchasedDate) {
          const daily = dailyMap.get(purchasedDate);
          const map = dailyCards.get(purchasedDate);
          if (daily && map) {
            daily.cardSpend += values.cost;
            daily.cardCount += 1;
            daily.purchasedOrders.push(toDetail(order, "purchased", purchasedDate));
            addCard(map, order.payment_method, values.cost);
          }
          summary.cardSpend += values.cost;
          summary.cardCount += 1;
          addCard(cardMap, order.payment_method, values.cost);
        }
        if (!order.purchased_at) pushIssue("missing_purchased_at", "구매일 누락", order, values.cost);
        if (!order.payment_method?.trim()) pushIssue("missing_payment", "카드사 미입력", order, values.cost);
      }

      if (order.tracking_no?.trim() && values.cost === 0) {
        pushIssue("missing_cost", "원가 0원", order, values.revenue);
      }
      if (order.tracking_no?.trim() && values.settlement === 0) {
        pushIssue("missing_settlement", "정산예정 0원", order, values.revenue);
      }
    }

    summary.netRevenue = summary.deliveredRevenue - summary.returnRevenue;
    summary.netSettlement = summary.deliveredSettlement - summary.returnSettlement;
    summary.netCost = summary.deliveredCost - summary.returnCost;
    summary.netMargin = summary.deliveredMargin - summary.returnMargin;
    summary.marginRate = rate(summary.netMargin, summary.netSettlement);

    const dailyRows = [...dailyMap.values()].map((row) => {
      row.cards = [...(dailyCards.get(row.date)?.values() ?? [])].sort((a, b) => b.amount - a.amount);
      row.netRevenue = row.deliveredRevenue - row.returnRevenue;
      row.netSettlement = row.deliveredSettlement - row.returnSettlement;
      row.netCost = row.deliveredCost - row.returnCost;
      row.netMargin = row.deliveredMargin - row.returnMargin;
      return row;
    }).reverse();

    const response = {
      month,
      summary,
      dailyRows,
      cards: [...cardMap.values()].sort((a, b) => b.amount - a.amount),
      marketplaces: [...marketplaceMap.values()].sort((a, b) => b.margin - a.margin),
      issues: [...issueMap.values()].sort((a, b) => b.count - a.count),
      orderCount: rows.length,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[finance/order-profit]", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}