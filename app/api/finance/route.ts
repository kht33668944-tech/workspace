import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { recalcTotals } from "@/lib/finance-utils";
import type { CardEntry, PlatformEntry, CashEntry } from "@/types/database";

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

  // 범위 조회 (추이 탭용)
  if (from && to) {
    const { data, error } = await supabase
      .from("daily_snapshots")
      .select("*")
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ snapshots: data });
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

    return NextResponse.json({ snapshot, prevSnapshot });
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
      const prevCards = prev.cards as CardEntry[];
      const prevPlatforms = prev.platforms as PlatformEntry[];
      const prevCash = prev.cash as CashEntry[];

      // 전날 카드 납부액 합계 (돈 나감 → 현금 감소)
      const totalPaymentMade = prevCards.reduce((s, c) => s + (c.payment_made ?? 0), 0);
      // 전날 플랫폼 정산입금 합계 (돈 들어옴 → 현금 증가)
      const totalSettled = prevPlatforms.reduce((s, p) => s + (p.settled_amount ?? 0), 0);
      const cashAdjustment = totalSettled - totalPaymentMade;

      // 카드: daily_payment, payment_made 초기화
      cards = prevCards.map(c => ({ ...c, daily_payment: 0, payment_made: 0 }));
      // 플랫폼: settled_amount 초기화
      platforms = prevPlatforms.map(p => ({ ...p, settled_amount: 0 }));
      // 현금: 첫 번째 현금 항목에 정산입금/납부액 반영
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

  return NextResponse.json({ snapshot: data, prevSnapshot });
}
