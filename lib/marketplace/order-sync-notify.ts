// 디스코드 알림 — 제목만 보고 판단할 수 있게 "✅ 할 일 없음 / ⚠️ 확인 필요 N건 / ❌ 실패" 를 붙이고,
// 사람이 할 일은 첫 줄 "👉" 로. 새 주문·클레임·오류가 없으면 보내지 않는다(하루 요약은 daily-summary.ts).

import { notifyAutomationResult, type AutomationNotifyStatus } from "@/lib/discord-notifier";
import type { SyncResult } from "@/lib/marketplace/order-sync";
import type { ShipResult } from "@/lib/marketplace/order-ship";
import type { CollectAllResult } from "@/lib/tracking/collect-all";
import type { EsmExportResult } from "@/lib/tracking/esm-export";

const LABEL: Record<string, string> = { coupang: "쿠팡", smartstore: "스토어", gmarket: "지마켓", auction: "옥션", ohouse: "오늘의집" };

function headline(todo: number, failed: boolean) {
  if (failed) return "❌ 실패";
  if (todo > 0) return `⚠️ 확인 필요 ${todo}건`;
  return "✅ 할 일 없음";
}

function joinCounts(pairs: Array<[string, number]>) {
  return pairs.filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ");
}

/** 주문 수집 결과 (#주문수집-자동화) */
export async function notifySyncResults(results: SyncResult[], trigger: "manual" | "scheduler") {
  const newTotal = results.reduce((n, r) => n + r.newOrders.length, 0);
  const errors = results.flatMap((r) => [...r.errors, ...r.confirmErrors]);
  const autoOk = results.flatMap((r) => (r.autoApproved ?? []).filter((a) => a.status !== "failed"));
  const autoIds = new Set(autoOk.map((a) => a.orderId));
  const cancelReq = results.flatMap((r) => r.claims.filter((c) => c.to === "취소요청" && !autoIds.has(c.orderId)));
  const otherClaims = results.flatMap((r) => r.claims.filter((c) => c.to !== "취소요청"));
  const confirmFailed = results.reduce((n, r) => n + r.confirmFailed, 0);
  if (newTotal === 0 && cancelReq.length === 0 && otherClaims.length === 0 && errors.length === 0 && autoOk.length === 0) return;

  const todo = cancelReq.length + (confirmFailed > 0 ? 1 : 0);
  const failed = errors.length > 0 && newTotal === 0 && cancelReq.length === 0;
  const lines: string[] = [];

  if (cancelReq.length > 0) {
    lines.push(`👉 취소요청 ${cancelReq.length}건 → 사이트 '주문 수집' 모달에서 승인/거절`);
    for (const c of cancelReq.slice(0, 6)) lines.push(`   • ${c.recipientName ?? "-"} · ${c.productName ?? "-"}${c.reason ? ` (${c.reason})` : ""}`);
  }
  if (confirmFailed > 0) lines.push(`👉 발주확인 실패 ${confirmFailed}건 — 다음 회차에 재시도, 계속되면 마켓 센터 확인`);
  if (errors.length > 0) {
    lines.push(`👉 오류 ${errors.length}건`);
    for (const e of errors.slice(0, 3)) lines.push(`   • ${e.slice(0, 140)}`);
  }
  if (lines.length > 0) lines.push("");

  if (newTotal > 0) {
    const per = results.map((r) => [LABEL[r.platform], r.newOrders.length] as [string, number]);
    lines.push(`신규 ${newTotal}건 등록·발주확인 완료 (${joinCounts(per)})`);
  }
  if (autoOk.length > 0) {
    lines.push(`취소요청 ${autoOk.length}건 자동 승인 (운송장 없음·구매 전)`);
    for (const a of autoOk.slice(0, 6)) lines.push(`   • ${a.recipientName ?? "-"} · ${a.productName ?? "-"}`);
    if (autoOk.length > 6) lines.push(`   • 외 ${autoOk.length - 6}건`);
  }
  if (otherClaims.length > 0) {
    lines.push(`클레임 반영 ${otherClaims.length}건`);
    for (const c of otherClaims.slice(0, 5)) lines.push(`   • ${c.recipientName ?? "-"} · ${c.productName ?? "-"} → ${c.to}`);
  }
  if (results.some((r) => r.dryRun)) lines.push("(DRY RUN — 실제 반영 없음)");

  const status: AutomationNotifyStatus = failed ? "failed" : todo > 0 || errors.length > 0 ? "partial" : "success";
  await notifyAutomationResult({
    channel: "orders",
    title: `📦 주문 수집${trigger === "manual" ? "(수동)" : ""} ${headline(todo, failed)}`,
    status,
    summary: lines.join("\n").trim(),
  });
}

/** 운송장 수집 + 송장 전송 + ESM 엑셀 결과 (#운송장수집-자동화) */
export async function notifyShipResults(results: ShipResult[], trigger: "manual" | "scheduler", extra: { collect?: CollectAllResult | null; esm?: EsmExportResult | null } = {}) {
  const sent = results.reduce((n, r) => n + r.sent, 0);
  const failedRows = results.flatMap((r) => r.rows.filter((x) => x.status === "failed"));
  const errors = results.flatMap((r) => r.errors);
  const collected = extra.collect?.groups.reduce((n, g) => n + g.applied, 0) ?? 0;
  const collectErrors = extra.collect?.groups.filter((g) => g.error) ?? [];
  const notCollected = extra.collect ? extra.collect.groups.reduce((n, g) => n + g.failed + g.notFound, 0) : 0;
  const esmCount = extra.esm?.count ?? 0;
  if (sent === 0 && failedRows.length === 0 && errors.length === 0 && collected === 0 && collectErrors.length === 0 && esmCount === 0) return;

  const todo = (esmCount > 0 ? 1 : 0) + collectErrors.length + (failedRows.length > 0 ? 1 : 0);
  const failed = (collectErrors.length > 0 || errors.length > 0) && sent === 0 && collected === 0;
  const lines: string[] = [];

  if (esmCount > 0) {
    lines.push(`👉 ESM 운송장 ${esmCount}건 엑셀 저장 → 플레이오토에 업로드`);
    lines.push(`   ${extra.esm?.file ?? ""}`);
  }
  for (const g of collectErrors) lines.push(`👉 ${LABEL[g.platform] ?? g.platform} 수집 실패 (${g.loginId}) — ${g.error?.slice(0, 100)}`);
  if (failedRows.length > 0) {
    lines.push(`👉 송장 전송 실패 ${failedRows.length}건 — 사이트 '송장 전송 (API)'에서 사유 확인`);
    for (const row of failedRows.slice(0, 4)) lines.push(`   • ${row.recipientName ?? "-"} · ${row.productName ?? "-"}: ${row.message.slice(0, 80)}`);
  }
  for (const e of errors.slice(0, 3)) lines.push(`👉 오류: ${e.slice(0, 140)}`);
  if (lines.length > 0) lines.push("");

  const sentPer = joinCounts(results.map((r) => [LABEL[r.platform], r.sent + r.alreadySent] as [string, number]));
  if (extra.collect) {
    lines.push(`운송장 수집 ${collected}건${sent > 0 ? ` → ${sentPer} 마켓 전송 완료` : ""}`);
    if (notCollected > 0) lines.push(`미수집 ${notCollected}건은 다음 회차에 재시도 (구매처 발송 전)`);
  } else if (sent > 0) {
    lines.push(`${sentPer} 송장 전송 완료`);
  }
  if (extra.esm && esmCount === 0 && (collected > 0 || sent > 0)) lines.push("ESM 새 운송장 없음");
  if (results.some((r) => r.dryRun)) lines.push("(DRY RUN — 실제 반영 없음)");

  const status: AutomationNotifyStatus = failed ? "failed" : todo > 0 ? "partial" : "success";
  await notifyAutomationResult({
    channel: "tracking",
    title: `🚚 운송장·송장${trigger === "manual" ? "(수동)" : ""} ${headline(todo, failed)}`,
    status,
    summary: lines.join("\n").trim(),
  });
}
