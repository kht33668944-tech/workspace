import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getCardPaymentTotal, normalizeCard, normalizePlatform, recalcTotals } from "@/lib/finance-utils";
import type { CardEntry, PlatformEntry, CashEntry, DailySnapshot } from "@/types/database";

type SupabaseClient = ReturnType<typeof getSupabaseClient>;

interface PurchaseAmountRow {
  cost: number | null;
  payment_method: string | null;
  purchase_order_no: string | null;
  delivery_status: string | null;
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00+09:00");
  d.setUTCDate(d.getUTCDate() + days);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function kstDayRange(date: string): { start: string; end: string } {
  return {
    start: new Date(date + "T00:00:00+09:00").toISOString(),
    end: new Date(addDays(date, 1) + "T00:00:00+09:00").toISOString(),
  };
}

async function getDailyCardPurchases(supabase: SupabaseClient, userId: string, date: string): Promise<Map<string, number>> {
  const { start, end } = kstDayRange(date);
  const { data, error } = await supabase
    .from("orders")
    .select("cost,payment_method,purchase_order_no,delivery_status")
    .eq("user_id", userId)
    .gte("purchased_at", start)
    .lt("purchased_at", end)
    .not("purchase_order_no", "is", null)
    .neq("purchase_order_no", "")
    .not("delivery_status", "in", "(취소완료,재고부족,반품완료,교환완료)");

  if (error) throw error;

  const map = new Map<string, number>();
  for (const row of (data ?? []) as PurchaseAmountRow[]) {
    const cardName = row.payment_method?.trim() || "미확인";
    map.set(cardName, (map.get(cardName) ?? 0) + (row.cost ?? 0));
  }
  return map;
}

function applyCardPurchases(cards: CardEntry[], purchases: Map<string, number>): CardEntry[] {
  const next = cards.map((card) => {
    const name = card.name?.trim() || "미확인";
    const daily_payment = purchases.get(name) ?? 0;
    purchases.delete(name);
    return normalizeCard({ ...card, name, daily_payment });
  });

  for (const [name, daily_payment] of purchases) {
    next.push(normalizeCard({ name, accumulated: 0, daily_payment, installment: 0, personal_excluded: 0, payments: [], total: 0 }));
  }

  return next;
}

function normalizeSnapshot(snapshot: DailySnapshot): DailySnapshot {
  const cards = ((snapshot.cards ?? []) as CardEntry[]).map(normalizeCard);
  const platforms = ((snapshot.platforms ?? []) as PlatformEntry[]).map(normalizePlatform);
  const cash = (snapshot.cash ?? []) as CashEntry[];
  const totals = recalcTotals(cards, platforms, cash, snapshot.pending_purchase ?? 0);
  return { ...snapshot, cards, platforms, cash, ...totals };
}

function carryPreviousCardTotals(snapshot: DailySnapshot | null, prevSnapshot: DailySnapshot | null): DailySnapshot | null {
  if (!snapshot || !prevSnapshot) return snapshot;

  const prevCards = ((prevSnapshot.cards ?? []) as CardEntry[]).map(normalizeCard);
  const cards = ((snapshot.cards ?? []) as CardEntry[]).map((card) => {
    const normalized = normalizeCard(card);
    const prev = prevCards.find((prevCard) => prevCard.name === normalized.name);
    return prev ? normalizeCard({ ...normalized, accumulated: prev.total }) : normalized;
  });
  const platforms = ((snapshot.platforms ?? []) as PlatformEntry[]).map(normalizePlatform);
  const cash = (snapshot.cash ?? []) as CashEntry[];
  const totals = recalcTotals(cards, platforms, cash, snapshot.pending_purchase ?? 0);
  return { ...snapshot, cards, platforms, cash, ...totals };
}

async function hydrateSnapshot(supabase: SupabaseClient, userId: string, snapshot: DailySnapshot | null): Promise<DailySnapshot | null> {
  if (!snapshot) return null;
  const purchases = await getDailyCardPurchases(supabase, userId, snapshot.date);
  const cards = applyCardPurchases((snapshot.cards ?? []) as CardEntry[], purchases);
  const platforms = ((snapshot.platforms ?? []) as PlatformEntry[]).map(normalizePlatform);
  const cash = (snapshot.cash ?? []) as CashEntry[];
  const totals = recalcTotals(cards, platforms, cash, snapshot.pending_purchase ?? 0);
  return { ...snapshot, cards, platforms, cash, ...totals };
}

// GET: 스냅샷 조회
// ?date=YYYY-MM-DD → { snapshot, prevSnapshot }
// ?from=YYYY-MM-DD&to=YYYY-MM-DD → { snapshots: [] }
export async function GET(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  // 범위 조회 (추이 탭용)
  if (from && to) {
    const { data, error } = await supabase
      .from("daily_snapshots")
      .select("*")
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ snapshots: ((data ?? []) as DailySnapshot[]).map(normalizeSnapshot) });
  }

  // 단일 날짜 조회
  if (date) {
    const { data: snapshot, error } = await supabase
      .from("daily_snapshots")
      .select("*")
      .eq("date", date)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // 전일 스냅샷 조회 (변동 비교용)
    const { data: prevSnapshot } = await supabase
      .from("daily_snapshots")
      .select("*")
      .lt("date", date)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const hydratedPrev = await hydrateSnapshot(supabase, user.id, prevSnapshot as DailySnapshot | null);
    const hydratedSnapshot = await hydrateSnapshot(supabase, user.id, snapshot as DailySnapshot | null);

    return NextResponse.json({
      snapshot: carryPreviousCardTotals(hydratedSnapshot, hydratedPrev),
      prevSnapshot: hydratedPrev,
    });
  }

  return NextResponse.json({ error: "date 또는 from/to 파라미터 필요" }, { status: 400 });
}

// POST: 스냅샷 생성
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const supabase = getSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const body = await request.json();
  const { date, copy_from_previous } = body;

  if (!date) return NextResponse.json({ error: "date 필수" }, { status: 400 });

  // 이미 존재하는지 확인
  const { data: existing } = await supabase
    .from("daily_snapshots")
    .select("id")
    .eq("date", date)
    .maybeSingle();

  if (existing) return NextResponse.json({ error: "해당 날짜에 이미 스냅샷이 존재합니다" }, { status: 409 });

  const DEFAULT_CARDS: CardEntry[] = [
    { name: "삼성", accumulated: 0, daily_payment: 0, installment: 0, total: 0 },
    { name: "국민", accumulated: 0, daily_payment: 0, installment: 0, total: 0 },
    { name: "신한", accumulated: 0, daily_payment: 0, installment: 0, total: 0 },
    { name: "우리", accumulated: 0, daily_payment: 0, installment: 0, total: 0 },
    { name: "롯데", accumulated: 0, daily_payment: 0, installment: 0, total: 0 },
  ];
  const DEFAULT_PLATFORMS: PlatformEntry[] = [
    { name: "쿠팡", delivered: 0, shipping: 0, cs: 0, total: 0 },
    { name: "ESM", delivered: 0, shipping: 0, cs: 0, total: 0 },
    { name: "스마트", delivered: 0, shipping: 0, cs: 0, total: 0 },
    { name: "11번가", delivered: 0, shipping: 0, cs: 0, total: 0 },
  ];
  const DEFAULT_CASH: CashEntry[] = [{ name: "농협체크", amount: 0 }];

  let cards: CardEntry[] = body.cards ?? DEFAULT_CARDS;
  let platforms: PlatformEntry[] = body.platforms ?? DEFAULT_PLATFORMS;
  let cash: CashEntry[] = body.cash ?? DEFAULT_CASH;
  let pending_purchase: number = body.pending_purchase ?? 0;
  let memo: string | null = body.memo ?? null;

  // 전날 복사
  if (copy_from_previous) {
    const { data: prev } = await supabase
      .from("daily_snapshots")
      .select("*")
      .lt("date", date)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (prev) {
      // 과거 스냅샷에 필드가 누락됐을 수 있어 빈 배열로 방어 (reduce 런타임 예외 방지)
      const prevSnapshot = await hydrateSnapshot(supabase, user.id, prev as DailySnapshot);
      const prevCards = (prevSnapshot?.cards ?? []) as CardEntry[];
      const prevPlatforms = (prevSnapshot?.platforms ?? []) as PlatformEntry[];
      const prevCash = (prev.cash ?? []) as CashEntry[];

      // 전날 카드 납부액 합계 (돈 나감 → 현금 감소)
      const totalPaymentMade = prevCards.reduce((s, c) => s + getCardPaymentTotal(c), 0);
      // 전날 플랫폼 정산입금 합계 (돈 들어옴 → 현금 증가)
      const totalSettled = prevPlatforms.reduce((s, p) => s + (p.settled_amount ?? 0), 0);
      const cashAdjustment = totalSettled - totalPaymentMade;

      const purchases = await getDailyCardPurchases(supabase, user.id, date);
      cards = applyCardPurchases(
        prevCards.map((c) => ({
          ...c,
          accumulated: c.total,
          daily_payment: 0,
          installment: 0,
          personal_excluded: 0,
          payments: [],
          payment_made: 0,
        })),
        purchases
      );
      // 플랫폼: settled_amount 초기화
      platforms = prevPlatforms.map(p => normalizePlatform({ ...p, settled_amount: 0 }));
      // 현금: 첫 번째 현금 항목에 전날 정산입금 반영
      cash = prevCash.map((c, i) => i === 0 ? { ...c, amount: c.amount + cashAdjustment } : { ...c });
      pending_purchase = prev.pending_purchase;
      memo = null;
    } else {
      // 최초 생성 - 기본 템플릿 사용 (위에서 이미 설정됨)
      cards = DEFAULT_CARDS;
      platforms = DEFAULT_PLATFORMS;
      cash = DEFAULT_CASH;
    }
  }

  cards = applyCardPurchases(cards, await getDailyCardPurchases(supabase, user.id, date));
  platforms = platforms.map(normalizePlatform);

  const totals = recalcTotals(cards, platforms, cash, pending_purchase);

  const { data, error } = await supabase
    .from("daily_snapshots")
    .insert({
      user_id: user.id,
      date,
      cards,
      platforms,
      cash,
      pending_purchase,
      ...totals,
      memo,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 전일 스냅샷도 함께 반환
  const { data: prevSnapshot } = await supabase
    .from("daily_snapshots")
    .select("*")
    .lt("date", date)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const hydratedPrev = await hydrateSnapshot(supabase, user.id, prevSnapshot as DailySnapshot | null);
  const hydratedSnapshot = await hydrateSnapshot(supabase, user.id, data as DailySnapshot);

  return NextResponse.json({
    snapshot: carryPreviousCardTotals(hydratedSnapshot, hydratedPrev),
    prevSnapshot: hydratedPrev,
  });
}
