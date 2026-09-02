// 자동구매 디스코드 알림 공용 포맷 — 수동(모달 합산)·무인(주문수집 후 크론)·API 직접호출이 모두 이 빌더를 쓴다.
// 주문 건별로 "판매처 · 수취인 · 상품 수량 / 결제 · 정산 · 마진"을 나열하고, 실패 건은 사유를 붙인다.
// 서버/클라이언트 양쪽에서 import 하므로 순수 함수만 둔다 (fetch·env 접근 금지).

import type { AutomationNotifyStatus, DiscordChannel } from "@/lib/discord-notifier";

/** 결제 1건(수량 루프 1회) — 카드사별 집계 단위 */
export interface PurchaseNotifyUnit {
  cost?: number;
  paymentMethod?: string;
}

export interface PurchaseNotifyItem {
  /** 판매처 (orders.marketplace) */
  marketplace?: string | null;
  recipientName?: string | null;
  productName?: string | null;
  quantity?: number | null;
  /** 정산예정금액 — 마진 = 정산 − 실결제 */
  settlement?: number | null;
  /** 대표 결제금액 (units 가 있으면 units 합이 우선) */
  cost?: number;
  paymentMethod?: string;
  units?: PurchaseNotifyUnit[];
  purchaseOrderNo?: string;
  /** 실패 사유 (failed 목록에만) */
  reason?: string;
}

export interface PurchaseNotifyInput {
  trigger: "manual" | "scheduler";
  dryRun?: boolean;
  cancelled?: boolean;
  success: PurchaseNotifyItem[];
  failed: PurchaseNotifyItem[];
  /** 구매 전 제외된 건 (품절·적자 등, 크론 스테이지) — 0건은 표시하지 않는다 */
  skipped?: { label: string; count: number }[];
  /** 건별로 못 묶는 오류 (API 실패·DB 반영 실패 등) */
  errors?: string[];
  /** 첫 줄 문구를 바꿔야 할 때 (예: "구매 가능한 주문이 없어 종료") */
  headline?: string;
}

export interface PurchaseNotifyPayload {
  title: string;
  status: AutomationNotifyStatus;
  summary: string;
  fields: { name: string; value: string }[];
  channel: DiscordChannel;
}

/** 섹션당 최대 나열 건수 — 디스코드 description 4096자 한도 보호 */
const MAX_LINES_PER_SECTION = 25;

const won = (n: number): string => `${Math.round(n).toLocaleString()}원`;
const signedWon = (n: number): string => `${n >= 0 ? "+" : "-"}${Math.abs(Math.round(n)).toLocaleString()}원`;

/** 실결제 합계: units 가 있으면 단위 합, 없으면 대표 cost */
export function paidAmountOf(item: PurchaseNotifyItem): number | undefined {
  if (item.units && item.units.length > 0) {
    const known = item.units.filter((u) => typeof u.cost === "number");
    if (known.length === 0) return typeof item.cost === "number" ? item.cost : undefined;
    return known.reduce((sum, u) => sum + (u.cost ?? 0), 0);
  }
  return typeof item.cost === "number" ? item.cost : undefined;
}

/** 카드사별 집계 단위 목록 — units 가 없으면 대표값 1건으로 본다 */
function unitsOf(item: PurchaseNotifyItem): PurchaseNotifyUnit[] {
  if (item.units && item.units.length > 0) return item.units;
  if (typeof item.cost === "number" || item.paymentMethod) return [{ cost: item.cost, paymentMethod: item.paymentMethod }];
  return [];
}

function headLine(item: PurchaseNotifyItem): string {
  const qty = Math.max(Number(item.quantity) || 1, 1);
  const parts = [item.marketplace?.trim() || "판매처?", item.recipientName?.trim() || "수취인?", `${item.productName?.trim() || "상품?"} ${qty}개`];
  return `▸ ${parts.join(" · ")}`;
}

/** 카드사별 결제 횟수 — "삼성 2회, 현대 1회" */
function cardCountsOf(item: PurchaseNotifyItem): string {
  const counts = new Map<string, number>();
  for (const u of unitsOf(item)) {
    const key = u.paymentMethod?.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([name, n]) => `${name} ${n}회`).join(", ");
}

function moneyLine(item: PurchaseNotifyItem): string {
  const paid = paidAmountOf(item);
  const settlement = Number(item.settlement) || 0;
  const payCount = unitsOf(item).length; // 수량 N개 = 구매처 결제 N회
  const segs: string[] = [];
  segs.push(paid === undefined ? "결제 미확인" : `결제 ${payCount > 0 ? `${payCount}회 ` : ""}${won(paid)}`);
  if (settlement > 0) segs.push(`정산 ${won(settlement)}`);
  if (settlement > 0 && paid !== undefined) segs.push(`마진 ${signedWon(settlement - paid)}`);
  const cards = cardCountsOf(item);
  return `  ${segs.join(" · ")}${cards ? ` (${cards})` : ""}`;
}

function successLines(item: PurchaseNotifyItem): string[] {
  return [headLine(item), moneyLine(item)];
}

function failedLines(item: PurchaseNotifyItem): string[] {
  const lines = [headLine(item), `  사유: ${item.reason?.trim() || "알 수 없음"}`];
  // 부분구매(수량 일부만 결제된 뒤 실패)면 실제 나간 돈을 같이 보여준다
  const units = item.units ?? [];
  const paid = paidAmountOf(item);
  if (units.length > 0 || item.purchaseOrderNo) {
    const qty = Math.max(Number(item.quantity) || 1, 1);
    const bought = units.length > 0 ? units.length : 1;
    const cards = cardCountsOf(item);
    lines.push(`  부분구매 ${bought}/${qty}개${paid !== undefined ? ` · 결제 ${bought}회 ${won(paid)}` : ""}${cards ? ` (${cards})` : ""}`);
  }
  return lines;
}

function section(title: string, items: PurchaseNotifyItem[], render: (item: PurchaseNotifyItem) => string[]): string[] {
  if (items.length === 0) return [];
  const lines = [`${title} ${items.length}건`];
  for (const item of items.slice(0, MAX_LINES_PER_SECTION)) lines.push(...render(item));
  if (items.length > MAX_LINES_PER_SECTION) lines.push(`  …외 ${items.length - MAX_LINES_PER_SECTION}건`);
  return lines;
}

export function buildPurchaseNotification(input: PurchaseNotifyInput): PurchaseNotifyPayload {
  const { success, failed } = input;
  const errors = (input.errors ?? []).filter((e) => e && e.trim());
  const skipped = (input.skipped ?? []).filter((s) => s.count > 0);
  const skippedTotal = skipped.reduce((sum, s) => sum + s.count, 0);

  const status: AutomationNotifyStatus =
    input.cancelled && success.length === 0
      ? "cancelled"
      : success.length > 0 && (failed.length > 0 || errors.length > 0)
        ? "partial"
        : success.length > 0
          ? "success"
          : failed.length > 0 || errors.length > 0
            ? "failed"
            : "success";

  const triggerLabel = input.trigger === "scheduler" ? "주문수집 후 자동" : "수동";
  const total = success.length + failed.length + skippedTotal;
  const counts = [`성공 ${success.length}`, `실패 ${failed.length}`];
  if (skippedTotal > 0) counts.push(`스킵 ${skippedTotal}`);
  const header = input.headline?.trim()
    || `${triggerLabel} · 총 ${total}건 (${counts.join(" · ")})${input.cancelled ? " · 중단됨" : ""}${input.dryRun ? " [드라이런]" : ""}`;

  const blocks: string[][] = [
    [header],
    section("✅ 구매 성공", success, successLines),
    section("❌ 구매 실패", failed, failedLines),
  ];
  if (skipped.length > 0) blocks.push([`⏭ 스킵: ${skipped.map((s) => `${s.label} ${s.count}`).join(" · ")}`]);
  if (errors.length > 0) blocks.push(["⚠ 오류", ...errors.slice(0, 8).map((e) => `- ${e}`), ...(errors.length > 8 ? [`- …외 ${errors.length - 8}건`] : [])]);

  // 합계 — 총수량·총결제·총마진은 성공 건 기준, 카드별 결제는 실제 나간 돈 전부(부분구매 포함)
  const totalQty = success.reduce((sum, s) => sum + Math.max(Number(s.quantity) || 1, 1), 0);
  let totalPaid = 0;
  let totalMargin = 0;
  let marginKnown = 0;
  for (const s of success) {
    const paid = paidAmountOf(s);
    if (paid === undefined) continue;
    totalPaid += paid;
    const settlement = Number(s.settlement) || 0;
    if (settlement > 0) { totalMargin += settlement - paid; marginKnown++; }
  }
  const cardMap = new Map<string, { count: number; amount: number }>();
  for (const item of [...success, ...failed]) {
    for (const u of unitsOf(item)) {
      const key = u.paymentMethod?.trim() || "미확인";
      const cur = cardMap.get(key) ?? { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += u.cost ?? 0;
      cardMap.set(key, cur);
    }
  }
  const cardBreakdown = Array.from(cardMap.entries()).map(([name, v]) => `${name} ${v.count}회 ${won(v.amount)}`).join("\n") || "-";

  return {
    title: "자동구매",
    status,
    channel: "purchase",
    summary: blocks.filter((b) => b.length > 0).map((b) => b.join("\n")).join("\n\n"),
    fields: [
      { name: "📦 총수량", value: `${totalQty}개` },
      { name: "💳 총결제금액", value: won(totalPaid) },
      { name: "📈 총마진", value: marginKnown > 0 ? `${signedWon(totalMargin)}${marginKnown < success.length ? ` (${marginKnown}/${success.length}건 기준)` : ""}` : "-" },
      { name: "💳 카드별 결제", value: cardBreakdown },
    ],
  };
}
