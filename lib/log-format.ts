import { PLATFORM_LABELS } from "@/types/database";
import type { PurchasePlatform } from "@/types/database";

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

export function formatLogDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dayName = DAY_NAMES[d.getDay()];
  return `${y}년 ${m}월 ${day}일 (${dayName})`;
}

export function formatLogTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function getPlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as PurchasePlatform] || platform;
}

export function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금 전";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  const days = Math.floor(hrs / 24);
  return `${days}일 전`;
}

export interface BatchLogEntry {
  batchId: string;
  type: "purchase" | "tracking";
  platform: string;
  successCount: number;
  failedCount: number;
  cancelledCount: number;
  startedAt: string;
}

export function groupIntoBatches(
  rows: Array<{ batch_id: string; platform: string; status: string; created_at: string }>,
  type: "purchase" | "tracking"
): BatchLogEntry[] {
  const map = new Map<string, BatchLogEntry>();
  for (const r of rows) {
    let batch = map.get(r.batch_id);
    if (!batch) {
      batch = {
        batchId: r.batch_id,
        type,
        platform: r.platform,
        successCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        startedAt: r.created_at,
      };
      map.set(r.batch_id, batch);
    }
    if (r.created_at < batch.startedAt) batch.startedAt = r.created_at;
    if (r.status === "success") batch.successCount++;
    else if (r.status === "failed") batch.failedCount++;
    else if (r.status === "cancelled") batch.cancelledCount++;
  }
  return Array.from(map.values());
}
