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
  /** 이 배치에 포함된 발주서 주문 id — 활동 로그 클릭 시 해당 주문만 필터 */
  orderIds: string[];
}

export function groupIntoBatches(
  rows: Array<{ batch_id: string; platform: string; status: string; created_at: string; order_id?: string | null }>,
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
        orderIds: [],
      };
      map.set(r.batch_id, batch);
    }
    if (r.created_at < batch.startedAt) batch.startedAt = r.created_at;
    if (r.order_id && !batch.orderIds.includes(r.order_id)) batch.orderIds.push(r.order_id);
    if (r.status === "success") batch.successCount++;
    else if (r.status === "failed") batch.failedCount++;
    else if (r.status === "cancelled") batch.cancelledCount++;
  }
  return Array.from(map.values());
}

// ───────── 마켓 API 활동 (marketplace_api_logs) ─────────

export const MARKETPLACE_ACTIVITY_LABELS: Record<string, string> = {
  "sync-orders": "주문수집",
  "auto-approve-cancel": "취소 자동승인",
  "approve-cancel": "취소승인",
  "reject-cancel": "취소거절",
  cancel: "마켓취소",
  claim: "클레임반영",
  ship: "송장전송",
};

export interface MarketplaceLogEntry {
  type: "marketplace";
  batchId: string;
  action: string;
  label: string;
  platform: string;
  successCount: number;
  failedCount: number;
  startedAt: string;
  /** 마켓 상품주문번호 목록 — 발주서 marketplace_product_order_no 필터로 사용 */
  targetNos: string[];
  /** sync-orders 처럼 건별 대상이 없는 실행형 로그의 요약 텍스트 */
  detail: string | null;
}

/** 같은 작업(action)이 5분 안에 남긴 행들을 한 활동으로 묶는다 (실행 단위 근사) */
export function groupMarketplaceLogs(
  rows: Array<{ action: string; status: string; platform: string; target_id: string | null; new_value: string | null; created_at: string; response_payload?: unknown }>
): MarketplaceLogEntry[] {
  const map = new Map<string, MarketplaceLogEntry>();
  for (const r of rows) {
    const label = MARKETPLACE_ACTIVITY_LABELS[r.action];
    if (!label) continue; // 관심 액션 외(dry 포함)는 제외
    // 주문수집은 매시 돌아서 신규 0건 실행은 소음 — 신규가 있을 때만 표시
    let syncDetail: string | null = null;
    if (r.action === "sync-orders") {
      const m = r.new_value?.match(/new=(\d+)/);
      if (!m || m[1] === "0") continue;
      syncDetail = `신규 ${m[1]}건 등록`;
    }
    const bucket = Math.floor(new Date(r.created_at).getTime() / 300000);
    const key = `${r.action}|${bucket}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { type: "marketplace", batchId: key, action: r.action, label, platform: r.platform, successCount: 0, failedCount: 0, startedAt: r.created_at, targetNos: [], detail: null };
      map.set(key, entry);
    }
    if (r.created_at < entry.startedAt) entry.startedAt = r.created_at;
    if (entry.platform !== r.platform) entry.platform = "all";
    if (r.target_id && !entry.targetNos.includes(r.target_id)) entry.targetNos.push(r.target_id);
    // 주문수집은 실행형 로그라 target_id 가 없다 — payload 의 수집 주문번호 목록으로 필터 대상을 채운다
    const payloadNos = (r.response_payload as { newProductOrderNos?: unknown } | null)?.newProductOrderNos;
    if (Array.isArray(payloadNos)) {
      for (const no of payloadNos) if (typeof no === "string" && no && !entry.targetNos.includes(no)) entry.targetNos.push(no);
    }
    if (syncDetail) entry.detail = entry.detail ? `${entry.detail} · ${syncDetail}` : syncDetail;
    if (r.status === "success") entry.successCount++;
    else entry.failedCount++;
  }
  return Array.from(map.values());
}
