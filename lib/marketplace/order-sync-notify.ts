import { notifyAutomationResult } from "@/lib/discord-notifier";
import type { SyncResult } from "@/lib/marketplace/order-sync";

const LABEL: Record<string, string> = { coupang: "쿠팡", smartstore: "스마트스토어" };

/** 수집 결과 디스코드 알림 — 새 주문·취소요청이 있거나 오류가 있을 때만 보낸다 */
export async function notifySyncResults(results: SyncResult[], trigger: "manual" | "scheduler") {
  const newTotal = results.reduce((n, r) => n + r.newOrders.length, 0);
  const cancelReq = results.flatMap((r) => r.claims.filter((c) => c.to === "취소요청"));
  const otherClaims = results.flatMap((r) => r.claims.filter((c) => c.to !== "취소요청"));
  const errors = results.flatMap((r) => [...r.errors, ...r.confirmErrors]);
  if (newTotal === 0 && cancelReq.length === 0 && otherClaims.length === 0 && errors.length === 0) return;

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${LABEL[r.platform]}: 조회 ${r.remoteCount} · 신규 ${r.newOrders.length} · 발주확인 ${r.confirmed}${r.confirmFailed ? ` (실패 ${r.confirmFailed})` : ""}${r.dryRun ? " [DRY]" : ""}`);
  }
  if (cancelReq.length > 0) {
    lines.push("", `⚠️ 취소요청 ${cancelReq.length}건 — 사이트에서 승인 필요`);
    for (const c of cancelReq.slice(0, 10)) lines.push(`• ${c.recipientName ?? "-"} · ${c.productName ?? "-"}${c.reason ? ` (${c.reason})` : ""}`);
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
