// 운송장 수집·송장 전송 디스코드 알림 공용 포맷 — 크론(tracking-and-ship.mts)·수동 모달·API 직접호출·송장 전송 버튼이 모두 이 빌더를 쓴다.
// 주문 건별로 "판매처 · 수취인 · 상품 수량 / 택배사 운송장" 을 나열하고, 미수집·전송 실패는 사유를 붙인다.
// 서버/클라이언트 양쪽에서 import 하므로 순수 함수만 둔다 (fetch·env·DB 접근 금지).

import type { AutomationNotifyStatus, DiscordChannel } from "@/lib/discord-notifier";
import type { ScrapeResult } from "@/lib/scrapers/types";
import { allOrderNos, getPurchaseOrders, type PurchaseOrderSource } from "@/lib/purchase-orders";

/** 알림 건별 표시에 필요한 발주서 행 (Order 전체 또는 필요한 컬럼만 select 한 행) */
export type TrackingOrderRow = PurchaseOrderSource & {
  id: string;
  marketplace?: string | null;
  recipient_name?: string | null;
  product_name?: string | null;
  quantity?: number | null;
};

export interface TrackingNotifyOrder {
  marketplace?: string | null;
  recipientName?: string | null;
  productName?: string | null;
  quantity?: number | null;
  /** 이번에 수집된 운송장 (수량 N개 자동구매는 주문 N건 → 운송장 N개일 수 있다) */
  collected: { courier: string; trackingNo: string }[];
  /** 수집 못 한 구매처 주문번호와 사유 (미발견 = 구매처 발송 전) */
  missing: { orderNo: string; reason: string }[];
}

export interface TrackingShipItem {
  /** 마켓 표시명 (쿠팡/스토어) */
  platform: string;
  recipientName?: string | null;
  productName?: string | null;
  courier?: string | null;
  trackingNo?: string | null;
  status: "success" | "already" | "failed" | "dry";
  message?: string;
}

export interface TrackingNotifyInput {
  trigger: "manual" | "scheduler";
  dryRun?: boolean;
  cancelled?: boolean;
  /** 운송장 수집 결과 (수집을 안 한 흐름 — 송장 전송 버튼 — 은 생략) */
  orders?: TrackingNotifyOrder[];
  /** 구매 계정에 매칭되지 않아 수집 못 한 발주서 행 수 */
  unmatched?: number;
  /** 마켓 송장 전송 결과 행 */
  ship?: TrackingShipItem[];
  esm?: { count: number; file: string | null } | null;
  /** 건별로 못 묶는 오류 (계정 로그인 실패·API 오류·DB 반영 실패 등) */
  errors?: string[];
}

export interface TrackingNotifyPayload {
  title: string;
  status: AutomationNotifyStatus;
  summary: string;
  fields: { name: string; value: string }[];
  channel: DiscordChannel;
}

/** 섹션당 최대 나열 건수 — 디스코드 description 4096자 한도 보호 */
const MAX_LINES_PER_SECTION = 20;

export const NOT_FOUND_REASON = "미발견 (구매처 발송 전 — 다음 회차 재시도)";
const SHIP_PLATFORM_LABEL: Record<string, string> = { coupang: "쿠팡", smartstore: "스토어", gmarket: "지마켓", auction: "옥션" };

export function shipPlatformLabel(platform: string): string {
  return SHIP_PLATFORM_LABEL[platform] ?? platform;
}

/**
 * 스크래퍼 결과(구매처 주문번호 단위)를 발주서 행(주문 건) 단위로 묶는다.
 * 어느 행에도 속하지 않는 주문번호는 "주문번호 …" 행으로 남겨 누락되지 않게 한다.
 */
export function groupScrapeResultsByOrder(rows: TrackingOrderRow[], results: ScrapeResult[]): TrackingNotifyOrder[] {
  const byRow = new Map<string, TrackingNotifyOrder>();
  const rowOfOrderNo = new Map<string, string>();
  for (const row of rows) {
    for (const no of allOrderNos(getPurchaseOrders(row))) if (!rowOfOrderNo.has(no)) rowOfOrderNo.set(no, row.id);
  }
  const ensure = (orderNo: string): TrackingNotifyOrder => {
    const rowId = rowOfOrderNo.get(orderNo);
    const key = rowId ?? `no:${orderNo}`;
    let item = byRow.get(key);
    if (!item) {
      const row = rowId ? rows.find((r) => r.id === rowId) : undefined;
      item = row
        ? { marketplace: row.marketplace ?? null, recipientName: row.recipient_name ?? null, productName: row.product_name ?? null, quantity: row.quantity ?? 1, collected: [], missing: [] }
        : { marketplace: null, recipientName: null, productName: `주문번호 ${orderNo}`, quantity: 1, collected: [], missing: [] };
      byRow.set(key, item);
    }
    return item;
  };
  for (const r of results) {
    for (const s of r.success) ensure(s.orderNo).collected.push({ courier: s.courier, trackingNo: s.trackingNo });
    for (const f of r.failed) ensure(f.orderNo).missing.push({ orderNo: f.orderNo, reason: f.reason });
    for (const n of r.notFound) ensure(n).missing.push({ orderNo: n, reason: NOT_FOUND_REASON });
  }
  // 입력 행 순서 유지, 행에 없는 주문번호는 뒤에
  const ordered: TrackingNotifyOrder[] = [];
  for (const row of rows) { const it = byRow.get(row.id); if (it) ordered.push(it); }
  for (const [key, it] of byRow) if (key.startsWith("no:")) ordered.push(it);
  return ordered;
}

function headLine(o: { marketplace?: string | null; recipientName?: string | null; productName?: string | null; quantity?: number | null }): string {
  const qty = Math.max(Number(o.quantity) || 1, 1);
  return `▸ ${[o.marketplace?.trim() || "판매처?", o.recipientName?.trim() || "수취인?", `${o.productName?.trim() || "상품?"} ${qty}개`].join(" · ")}`;
}

function trackingText(t: { courier?: string | null; trackingNo?: string | null }): string {
  return `${t.courier?.trim() || "택배사?"} ${t.trackingNo?.trim() || "-"}`;
}

function collectedLines(o: TrackingNotifyOrder): string[] {
  const lines = [headLine(o), `  ${o.collected.map(trackingText).join(", ")}`];
  if (o.missing.length > 0) lines.push(`  일부 미수집 ${o.missing.length}건: ${o.missing[0].reason}`);
  return lines;
}

function missingLines(o: TrackingNotifyOrder): string[] {
  const reasons = Array.from(new Set(o.missing.map((m) => m.reason)));
  return [headLine(o), `  사유: ${reasons.join(" / ")}`];
}

function shipOkLines(s: TrackingShipItem): string[] {
  return [`${headLine({ marketplace: s.platform, recipientName: s.recipientName, productName: s.productName, quantity: 1 }).replace(/ 1개$/, "")} → ${trackingText(s)}`];
}

function shipFailLines(s: TrackingShipItem): string[] {
  return [`${headLine({ marketplace: s.platform, recipientName: s.recipientName, productName: s.productName, quantity: 1 }).replace(/ 1개$/, "")} → ${trackingText(s)}`, `  사유: ${s.message?.trim() || "알 수 없음"}`];
}

function section<T>(title: string, items: T[], render: (item: T) => string[]): string[] {
  if (items.length === 0) return [];
  const lines = [`${title} ${items.length}건`];
  for (const item of items.slice(0, MAX_LINES_PER_SECTION)) lines.push(...render(item));
  if (items.length > MAX_LINES_PER_SECTION) lines.push(`  …외 ${items.length - MAX_LINES_PER_SECTION}건`);
  return lines;
}

/**
 * 알림 본문 생성. 스케줄러는 아무 일도 없었으면(수집·전송·ESM·오류 0) null 을 돌려주고, 수동은 항상 만든다.
 */
export function buildTrackingNotification(input: TrackingNotifyInput): TrackingNotifyPayload | null {
  const orders = input.orders ?? [];
  const collected = orders.filter((o) => o.collected.length > 0);
  const missingOnly = orders.filter((o) => o.collected.length === 0 && o.missing.length > 0);
  const ship = input.ship ?? [];
  const shipOk = ship.filter((s) => s.status === "success" || s.status === "dry");
  const shipAlready = ship.filter((s) => s.status === "already");
  const shipFailed = ship.filter((s) => s.status === "failed");
  const esmCount = input.esm?.count ?? 0;
  const errors = (input.errors ?? []).filter((e) => e && e.trim());
  const unmatched = input.unmatched ?? 0;

  const nothingHappened = collected.length === 0 && shipOk.length === 0 && shipFailed.length === 0 && esmCount === 0 && errors.length === 0;
  if (input.trigger === "scheduler" && nothingHappened) return null;

  // 사람이 손대야 하는 일: ESM 엑셀 업로드, 송장 전송 실패, 계정 오류
  const todo = (esmCount > 0 ? 1 : 0) + (shipFailed.length > 0 ? 1 : 0) + errors.length;
  const failed = errors.length > 0 && collected.length === 0 && shipOk.length === 0 && esmCount === 0;
  const status: AutomationNotifyStatus = input.cancelled && collected.length === 0 ? "cancelled" : failed ? "failed" : todo > 0 ? "partial" : "success";
  const headline = input.cancelled && collected.length === 0 ? "⏹ 중단됨" : failed ? "❌ 실패" : todo > 0 ? `⚠️ 확인 필요 ${todo}건` : "✅ 할 일 없음";

  const counts: string[] = [];
  if (input.orders) counts.push(`수집 ${collected.length}건`, `미수집 ${missingOnly.length}건`);
  if (input.ship) counts.push(`송장 전송 ${shipOk.length}건${shipAlready.length > 0 ? ` (이미 전송 ${shipAlready.length})` : ""}`);
  if (input.esm) counts.push(`ESM ${esmCount}건`);
  const header = `${input.trigger === "scheduler" ? "자동" : "수동"} · ${counts.join(" · ")}${input.cancelled ? " · 중단됨" : ""}${input.dryRun ? " [드라이런]" : ""}`;

  const blocks: string[][] = [[header]];
  // 할 일은 맨 위 — 제목만 보고 넘어가도 첫 줄에서 잡히게
  const todoLines: string[] = [];
  if (esmCount > 0) todoLines.push(`👉 ESM 운송장 ${esmCount}건 엑셀 저장 → 플레이오토에 업로드`, `   ${input.esm?.file ?? ""}`);
  if (shipFailed.length > 0) todoLines.push(`👉 송장 전송 실패 ${shipFailed.length}건 — 아래 사유 확인 후 '송장 전송 (API)' 재시도`);
  if (todoLines.length > 0) blocks.push(todoLines);

  blocks.push(section("📦 운송장 수집", collected, collectedLines));
  blocks.push(section("⏳ 미수집", missingOnly, missingLines));
  if (unmatched > 0) blocks.push([`계정 매칭 안 됨 ${unmatched}건 — 발주서 구매아이디와 계정 관리의 아이디를 맞춰야 수집된다`]);
  blocks.push(section("📤 마켓 송장 전송", shipOk, shipOkLines));
  blocks.push(section("❌ 송장 전송 실패", shipFailed, shipFailLines));
  if (errors.length > 0) blocks.push(["⚠ 오류", ...errors.slice(0, 8).map((e) => `- ${e.slice(0, 160)}`), ...(errors.length > 8 ? [`- …외 ${errors.length - 8}건`] : [])]);

  const fields: { name: string; value: string }[] = [];
  if (input.orders) fields.push({ name: "📦 수집", value: `${collected.length}건` }, { name: "⏳ 미수집", value: `${missingOnly.length}건` });
  if (input.ship) fields.push({ name: "📤 송장 전송", value: `${shipOk.length}건${shipFailed.length > 0 ? ` / 실패 ${shipFailed.length}` : ""}` });
  if (input.esm) fields.push({ name: "📑 ESM 엑셀", value: `${esmCount}건` });

  return {
    title: `🚚 운송장·송장${input.trigger === "manual" ? "(수동)" : ""} ${headline}`,
    status,
    channel: "tracking",
    summary: blocks.filter((b) => b.length > 0).map((b) => b.join("\n")).join("\n\n"),
    fields,
  };
}
