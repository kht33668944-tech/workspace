// 하루 요약 (#주문수집-자동화, 매일 21:00 이후 첫 주문수집 때 1회)
//  오늘(KST) 주문 기준: 마켓별 건수·매출·정산예정·원가·순수익(정산예정−원가), 송장 전송·취소·반품 건수

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyAutomationResult } from "@/lib/discord-notifier";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

const CANCELED = new Set(["취소완료", "재고부족", "취소요청", "취소준비"]);
const MARKET_ORDER = ["쿠팡", "스마트스토어", "지마켓", "옥션", "11번가"];

function kstDayRange(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 3600000);
  const day = kst.toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 86400000);
  return { day, start: start.toISOString(), end: end.toISOString() };
}

const won = (n: number) => `${Math.round(n).toLocaleString()}원`;

export async function buildDailySummary(supabase: AnySupabase, userId: string, date = new Date()) {
  const { day, start, end } = kstDayRange(date);
  const { data, error } = await supabase
    .from("orders")
    .select("marketplace,delivery_status,revenue,settlement,cost,settlement_source,tracking_no,shipped_to_marketplace_at")
    .eq("user_id", userId)
    .gte("order_date", start)
    .lt("order_date", end)
    .limit(5000);
  if (error) throw new Error(`오늘 주문 조회 실패: ${error.message}`);
  type Row = { marketplace: string | null; delivery_status: string; revenue: number; settlement: number; cost: number; settlement_source: string | null };
  const rows = (data ?? []) as Row[];

  const per = new Map<string, { count: number; revenue: number; settlement: number; cost: number; costMissing: number }>();
  let canceled = 0, returns = 0, exchanges = 0, actualSettled = 0;
  for (const r of rows) {
    if (r.delivery_status === "반품준비" || r.delivery_status === "반품완료") returns++;
    if (r.delivery_status === "교환준비" || r.delivery_status === "교환완료") exchanges++;
    if (CANCELED.has(r.delivery_status)) { canceled++; continue; }
    const m = MARKET_ORDER.find((x) => (r.marketplace ?? "").includes(x)) ?? (r.marketplace || "기타");
    const p = per.get(m) ?? { count: 0, revenue: 0, settlement: 0, cost: 0, costMissing: 0 };
    p.count++; p.revenue += r.revenue || 0; p.settlement += r.settlement || 0; p.cost += r.cost || 0;
    if (!r.cost) p.costMissing++;
    if (r.settlement_source === "api") actualSettled++;
    per.set(m, p);
  }
  const total = [...per.values()].reduce((a, p) => ({ count: a.count + p.count, revenue: a.revenue + p.revenue, settlement: a.settlement + p.settlement, cost: a.cost + p.cost, costMissing: a.costMissing + p.costMissing }), { count: 0, revenue: 0, settlement: 0, cost: 0, costMissing: 0 });

  // 오늘 마켓에 전송한 송장 수 (API 로그 기준 — 기준선 일괄 표시와 구분)
  const { count: shipped } = await supabase.from("marketplace_api_logs").select("id", { count: "exact", head: true }).eq("user_id", userId).in("action", ["ship", "ship-fix"]).eq("status", "success").gte("created_at", start).lt("created_at", end);
  // 오늘 구매(결제)한 카드값 — 카드사별 (구매일 purchased_at 기준, 취소·반품 제외)
  const { data: buys } = await supabase
    .from("orders")
    .select("cost,payment_method,delivery_status")
    .eq("user_id", userId)
    .gte("purchased_at", start)
    .lt("purchased_at", end)
    .not("purchase_order_no", "is", null)
    .neq("purchase_order_no", "")
    .limit(5000);
  const cards = new Map<string, number>();
  let cardTotal = 0;
  for (const b of (buys ?? []) as Array<{ cost: number; payment_method: string | null; delivery_status: string }>) {
    if (["취소완료", "재고부족", "반품완료", "교환완료"].includes(b.delivery_status)) continue;
    const name = b.payment_method?.trim() || "미확인";
    cards.set(name, (cards.get(name) ?? 0) + (b.cost || 0));
    cardTotal += b.cost || 0;
  }
  // 오늘 실패한 자동화 로그
  const { count: failedLogs } = await supabase.from("marketplace_api_logs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "failed").gte("created_at", start).lt("created_at", end);

  const lines: string[] = [];
  lines.push(`💰 순수익 **${won(total.settlement - total.cost)}**  (정산예정 ${won(total.settlement)} − 원가 ${won(total.cost)})`);
  lines.push(`주문 ${total.count}건 · 매출 ${won(total.revenue)}${canceled ? ` · 취소 ${canceled}` : ""}${returns ? ` · 반품 ${returns}` : ""}${exchanges ? ` · 교환 ${exchanges}` : ""}`);
  lines.push("");
  const ordered = [...per.entries()].sort((a, b) => MARKET_ORDER.indexOf(a[0]) - MARKET_ORDER.indexOf(b[0]));
  for (const [m, p] of ordered) {
    lines.push(`${m} ${p.count}건 · 매출 ${won(p.revenue)} · 정산예정 ${won(p.settlement)} · 순수익 ${won(p.settlement - p.cost)}${p.costMissing ? ` (원가 미입력 ${p.costMissing})` : ""}`);
  }
  lines.push("");
  if (cards.size > 0) {
    const perCard = [...cards.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${won(v)}`).join(" · ");
    lines.push(`💳 오늘 카드값 ${won(cardTotal)}  (${perCard})`);
    lines.push("");
  }
  const notes: string[] = [];
  notes.push(`송장 전송 ${shipped ?? 0}건`);
  if (total.costMissing > 0) notes.push(`원가 미입력 ${total.costMissing}건 → 순수익 과대`);
  notes.push(actualSettled > 0 ? `정산 확정 반영 ${actualSettled}건` : "정산예정은 추정치(구매확정 후 실제값으로 갱신)");
  if ((failedLogs ?? 0) > 0) notes.push(`자동화 오류 ${failedLogs}건 (설정 → 로그)`);
  lines.push(notes.join(" · "));

  const [y, mo, d] = day.split("-");
  return { day, title: `📊 오늘 요약 ${Number(mo)}/${Number(d)} (${y})`, summary: lines.join("\n"), total, failed: (failedLogs ?? 0) > 0 };
}

export async function sendDailySummary(supabase: AnySupabase, userId: string, date = new Date()) {
  const s = await buildDailySummary(supabase, userId, date);
  await notifyAutomationResult({ channel: "orders", title: s.title, status: "success", summary: s.summary }); // 요약은 항상 초록 — 오류는 본문 숫자로
  return s;
}
