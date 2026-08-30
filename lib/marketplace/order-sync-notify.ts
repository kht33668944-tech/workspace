import { notifyAutomationResult } from "@/lib/discord-notifier";
import type { SyncResult } from "@/lib/marketplace/order-sync";
import type { ShipResult } from "@/lib/marketplace/order-ship";
import type { CollectAllResult } from "@/lib/tracking/collect-all";
import type { EsmExportResult } from "@/lib/tracking/esm-export";

const LABEL: Record<string, string> = { coupang: "쿠팡", smartstore: "스마트스토어" };

/** 수집 결과 디스코드 알림 — 새 주문·취소요청이 있거나 오류가 있을 때만 보낸다 */
export async function notifySyncResults(results: SyncResult[], trigger: "manual" | "scheduler") {
  const newTotal = results.reduce((n, r) => n + r.newOrders.length, 0);
  const cancelReq = results.flatMap((r) => r.claims.filter((c) => c.to === "취소요청"));
  const otherClaims = results.flatMap((r) => r.claims.filter((c) => c.to !== "취소요청"));
  const errors = results.flatMap((r) => [...r.errors, ...r.confirmErrors]);
  const autoCount = results.reduce((n, r) => n + (r.autoApproved ?? []).length, 0);
  if (newTotal === 0 && cancelReq.length === 0 && otherClaims.length === 0 && errors.length === 0 && autoCount === 0) return;

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${LABEL[r.platform]}: 조회 ${r.remoteCount} · 신규 ${r.newOrders.length} · 발주확인 ${r.confirmed}${r.confirmFailed ? ` (실패 ${r.confirmFailed})` : ""}${r.dryRun ? " [DRY]" : ""}`);
  }
  if (cancelReq.length > 0) {
    const autoIds = new Set(results.flatMap((r) => (r.autoApproved ?? []).filter((a) => a.status !== "failed").map((a) => a.orderId)));
    const manual = cancelReq.filter((c) => !autoIds.has(c.orderId));
    if (manual.length > 0) {
      lines.push("", `⚠️ 취소요청 ${manual.length}건 — 사이트에서 승인/거절 필요`);
      for (const c of manual.slice(0, 10)) lines.push(`• ${c.recipientName ?? "-"} · ${c.productName ?? "-"}${c.reason ? ` (${c.reason})` : ""}`);
    }
  }
  const auto = results.flatMap((r) => r.autoApproved ?? []);
  if (auto.length > 0) {
    lines.push("", `✅ 취소요청 자동 승인 ${auto.length}건`);
    for (const a of auto.slice(0, 8)) lines.push(`• ${a.recipientName ?? "-"} · ${a.productName ?? "-"} — ${a.message}`);
  }
  if (otherClaims.length > 0) {
    lines.push("", `클레임 반영 ${otherClaims.length}건`);
    for (const c of otherClaims.slice(0, 8)) lines.push(`• ${c.recipientName ?? "-"} · ${c.productName ?? "-"} → ${c.to}`);
  }
  if (errors.length > 0) {
    lines.push("", `오류 ${errors.length}건`);
    for (const e of errors.slice(0, 5)) lines.push(`• ${e.slice(0, 160)}`);
  }

  await notifyAutomationResult({
    title: `마켓 주문 수집 (${trigger === "scheduler" ? "자동" : "수동"})`,
    status: errors.length > 0 ? (newTotal > 0 ? "partial" : "failed") : "success",
    summary: lines.join("\n"),
    fields: [
      { name: "신규 주문", value: newTotal },
      { name: "취소요청", value: cancelReq.length },
      { name: "클레임 반영", value: otherClaims.length },
    ],
  });
}

/** 운송장 수집 + 송장 전송 + ESM 엑셀 결과 알림 — 보낸 것/실패/새 엑셀이 있을 때만 */
export async function notifyShipResults(results: ShipResult[], trigger: "manual" | "scheduler", extra: { collect?: CollectAllResult | null; esm?: EsmExportResult | null } = {}) {
  const sent = results.reduce((n, r) => n + r.sent, 0);
  const failed = results.reduce((n, r) => n + r.failed, 0);
  const errors = results.flatMap((r) => r.errors);
  const collected = extra.collect?.groups.reduce((n, g) => n + g.applied, 0) ?? 0;
  const collectErrors = extra.collect?.groups.filter((g) => g.error) ?? [];
  const esmCount = extra.esm?.count ?? 0;
  if (sent === 0 && failed === 0 && errors.length === 0 && collected === 0 && collectErrors.length === 0 && esmCount === 0) return;

  const lines: string[] = [];
  if (extra.collect) {
    lines.push(`운송장 수집: 미수집 ${extra.collect.pending}건 → 반영 ${collected}건${extra.collect.unmatched ? ` (계정 매칭 안 됨 ${extra.collect.unmatched})` : ""}`);
    for (const g of extra.collect.groups) lines.push(`• ${g.platform} ${g.loginId}: 성공 ${g.success} 실패 ${g.failed} 미발견 ${g.notFound}${g.error ? ` — ${g.error.slice(0, 80)}` : ""}`);
  }
  for (const r of results) {
    lines.push(`${LABEL[r.platform]} 송장: 전송 ${r.sent}${r.alreadySent ? ` (이미 ${r.alreadySent})` : ""} · 실패 ${r.failed} · 제외 ${r.skipped.length}${r.dryRun ? " [DRY]" : ""}`);
    for (const row of r.rows.filter((x) => x.status === "failed").slice(0, 5)) lines.push(`  x ${row.recipientName ?? "-"} · ${row.productName ?? "-"}: ${row.message.slice(0, 100)}`);
  }
  if (extra.esm) lines.push(esmCount > 0 ? `📄 ESM 운송장 ${esmCount}건 → ${extra.esm.file} (플레이오토에 업로드)` : "ESM 운송장: 새 건 없음");
  if (errors.length > 0) { lines.push("", `오류 ${errors.length}건`); for (const e of errors.slice(0, 5)) lines.push(`• ${e.slice(0, 160)}`); }

  const status = failed > 0 || errors.length > 0 || collectErrors.length > 0 ? (sent > 0 || collected > 0 ? "partial" : "failed") : "success";
  await notifyAutomationResult({
    title: trigger === "scheduler" ? "운송장 수집·송장 전송 (자동)" : "송장 전송 (API)",
    status,
    summary: lines.join("\n"),
  });
}
