// 자동화 스케줄 정의 + 타임라인/헬스체크 계산 (자동화 페이지·크론 공용, React/supabase 의존 없음)
// ⚠ schedule 값은 Windows 작업 스케줄러 등록(scripts/register-*-task.ps1)과 일치해야 한다.
//   실측 앵커(2026-08-31): OnliveOrderSync 매시 :00 / OnliveTrackingShip 02:30 기점 3시간 / OnliveAutoPrice 00:15 기점 4시간

import type { MarketplaceSyncRun } from "@/types/database";

export type AutomationKey = "order-sync" | "inquiries" | "tracking-ship" | "price" | "settlement" | "daily-summary";
export type RunKind =
  | "orders" | "inquiries" | "shipping" | "tracking-collect" | "esm-export"
  | "settlement" | "daily-summary" | "price" | "health-alert";

export interface AutomationDef {
  key: AutomationKey;
  label: string;
  description: string;
  taskName: "OnliveOrderSync" | "OnliveTrackingShip" | "OnliveAutoPrice" | null;
  /** 즉시 실행 방법 — api: 기존 라우트 호출, schtasks: 로컬 작업 스케줄러 트리거, null: 버튼 없음 */
  runVia: "api" | "schtasks" | null;
  apiPath?: string;
  /** 이 자동화가 marketplace_sync_runs 에 남기는 kind 전부 */
  kinds: RunKind[];
  /** 슬롯 매칭·헬스체크 기준 kind */
  primaryKind: RunKind;
  schedule:
    | { type: "interval"; anchorHour: number; minute: number; intervalHours: number }
    | { type: "daily-latch"; afterHourKst: number };
  /** 정상 실행 최대 소요(분) — 초과 running 은 좀비로 판정 */
  maxRuntimeMin: number;
  toleranceMin: number;
}

export const AUTOMATIONS: AutomationDef[] = [
  {
    key: "order-sync", label: "주문수집", description: "마켓 주문 수집·발주확인·클레임·취소 자동승인",
    taskName: "OnliveOrderSync", runVia: "api", apiPath: "/api/marketplace-api/orders/sync",
    kinds: ["orders"], primaryKind: "orders",
    schedule: { type: "interval", anchorHour: 0, minute: 0, intervalHours: 1 },
    maxRuntimeMin: 20, toleranceMin: 10,
  },
  {
    key: "inquiries", label: "문의 수집", description: "마켓 고객문의 수집·AI 초안 준비",
    taskName: "OnliveOrderSync", runVia: "api", apiPath: "/api/marketplace-api/inquiries/sync",
    kinds: ["inquiries"], primaryKind: "inquiries",
    schedule: { type: "interval", anchorHour: 0, minute: 0, intervalHours: 1 },
    maxRuntimeMin: 20, toleranceMin: 10,
  },
  {
    key: "tracking-ship", label: "운송장·송장", description: "구매처 운송장 수집 → 마켓 송장 전송 → ESM 엑셀",
    taskName: "OnliveTrackingShip", runVia: "schtasks",
    kinds: ["tracking-collect", "shipping", "esm-export"], primaryKind: "tracking-collect",
    schedule: { type: "interval", anchorHour: 2, minute: 30, intervalHours: 3 },
    maxRuntimeMin: 40, toleranceMin: 10,
  },
  {
    key: "price", label: "최저가 갱신", description: "전체 상품 최저가 수집 → 가격 적용 → 마켓 API 반영 → 엑셀",
    taskName: "OnliveAutoPrice", runVia: "schtasks",
    kinds: ["price"], primaryKind: "price",
    schedule: { type: "interval", anchorHour: 0, minute: 15, intervalHours: 4 },
    maxRuntimeMin: 120, toleranceMin: 10,
  },
  {
    key: "settlement", label: "정산 동기화", description: "마켓 정산 금액 반영 (하루 1회, 0시 이후 첫 주문수집 때)",
    taskName: "OnliveOrderSync", runVia: "api", apiPath: "/api/marketplace-api/orders/settlement",
    kinds: ["settlement"], primaryKind: "settlement",
    schedule: { type: "daily-latch", afterHourKst: 0 },
    maxRuntimeMin: 20, toleranceMin: 70,
  },
  {
    key: "daily-summary", label: "하루 요약", description: "그날 주문·수익 요약 디스코드 발송 (21시 이후 1회)",
    taskName: "OnliveOrderSync", runVia: null,
    kinds: ["daily-summary"], primaryKind: "daily-summary",
    schedule: { type: "daily-latch", afterHourKst: 21 },
    maxRuntimeMin: 20, toleranceMin: 70,
  },
];

export const KIND_TO_KEY: Record<RunKind, AutomationKey | null> = {
  orders: "order-sync",
  inquiries: "inquiries",
  shipping: "tracking-ship",
  "tracking-collect": "tracking-ship",
  "esm-export": "tracking-ship",
  settlement: "settlement",
  "daily-summary": "daily-summary",
  price: "price",
  "health-alert": null,
};

const KST_OFFSET_MS = 9 * 3600000;

/** KST 기준 YYYY-MM-DD */
export function kstDateKey(t: number | Date = Date.now()): string {
  const ms = t instanceof Date ? t.getTime() : t;
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 해당 KST 날짜의 예정 실행 시각 ISO 배열 (daily-latch 는 기준 시각 1개) */
export function slotsForKstDate(def: AutomationDef, dateKst: string): string[] {
  if (def.schedule.type === "daily-latch") {
    const hh = String(def.schedule.afterHourKst).padStart(2, "0");
    return [new Date(`${dateKst}T${hh}:00:00+09:00`).toISOString()];
  }
  const { anchorHour, minute, intervalHours } = def.schedule;
  const out: string[] = [];
  for (let h = anchorHour % intervalHours; h < 24; h += intervalHours) {
    const hh = String(h).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    out.push(new Date(`${dateKst}T${hh}:${mm}:00+09:00`).toISOString());
  }
  return out;
}

export type SlotStatus = "upcoming" | "running" | "success" | "partial" | "failed" | "missed" | "stale" | "manual";

export interface TimelineSlot {
  key: AutomationKey;
  label: string;
  scheduledAt: string; // ISO
  status: SlotStatus;
  runs: MarketplaceSyncRun[];
}

/** running 인데 최대 소요시간 + 15분을 넘긴 좀비 행 */
export function isStaleRunning(run: MarketplaceSyncRun, now: Date = new Date()): boolean {
  if (run.status !== "running") return false;
  const key = KIND_TO_KEY[(run.kind ?? "orders") as RunKind] ?? "order-sync";
  const def = AUTOMATIONS.find((d) => d.key === key);
  const limitMin = (def?.maxRuntimeMin ?? 30) + 15;
  return now.getTime() - new Date(run.started_at).getTime() > limitMin * 60000;
}

function worstOf(runs: MarketplaceSyncRun[], now: Date): SlotStatus {
  let worst: SlotStatus = "success";
  const rank: Record<string, number> = { success: 0, running: 1, partial: 2, stale: 3, failed: 4 };
  for (const r of runs) {
    const s: SlotStatus = r.status === "running" ? (isStaleRunning(r, now) ? "stale" : "running") : (r.status as SlotStatus);
    if ((rank[s] ?? 0) > (rank[worst] ?? 0)) worst = s;
  }
  return worst;
}

/** 오늘(KST) 타임라인: 예정 슬롯 + run 매칭 + 미실행 판정. 수동 실행(trigger=manual)은 별도 항목 */
export function buildTodayTimeline(runs: MarketplaceSyncRun[], now: Date = new Date()): TimelineSlot[] {
  const today = kstDateKey(now);
  const slots: TimelineSlot[] = [];
  const usedRunIds = new Set<string>();

  for (const def of AUTOMATIONS) {
    for (const slotIso of slotsForKstDate(def, today)) {
      const slotMs = new Date(slotIso).getTime();
      const tolMs = def.toleranceMin * 60000;
      const matched = runs.filter((r) => {
        if (r.trigger !== "scheduler" || !def.kinds.includes((r.kind ?? "orders") as RunKind)) return false;
        const t = new Date(r.started_at).getTime();
        return t >= slotMs - tolMs && t <= slotMs + tolMs;
      });
      for (const r of matched) usedRunIds.add(r.id);
      let status: SlotStatus;
      if (matched.length > 0) status = worstOf(matched, now);
      else if (slotMs + tolMs < now.getTime()) status = "missed";
      else status = "upcoming";
      slots.push({ key: def.key, label: def.label, scheduledAt: slotIso, status, runs: matched });
    }
  }

  // 수동 실행 + 슬롯에 매칭 안 된 스케줄 실행(catch-up 등)은 실제 시각으로 별도 표시
  const todayStartMs = new Date(`${today}T00:00:00+09:00`).getTime();
  for (const r of runs) {
    if (usedRunIds.has(r.id)) continue;
    const kind = (r.kind ?? "orders") as RunKind;
    const key = KIND_TO_KEY[kind];
    if (!key) continue;
    const t = new Date(r.started_at).getTime();
    if (t < todayStartMs) continue;
    const def = AUTOMATIONS.find((d) => d.key === key)!;
    slots.push({
      key,
      label: def.label,
      scheduledAt: r.started_at,
      status: r.trigger === "manual" ? "manual" : worstOf([r], now),
      runs: [r],
    });
  }

  return slots.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** 다음 예정 실행 (카운트다운용) — interval 스케줄만 대상 */
export function nextScheduledRun(now: Date = new Date()): { def: AutomationDef; at: string } | null {
  let best: { def: AutomationDef; at: string } | null = null;
  const days = [kstDateKey(now), kstDateKey(now.getTime() + 86400000)];
  for (const def of AUTOMATIONS) {
    if (def.schedule.type !== "interval") continue;
    for (const day of days) {
      const slot = slotsForKstDate(def, day).find((s) => new Date(s).getTime() > now.getTime());
      if (slot && (!best || slot < best.at)) best = { def, at: slot };
      if (slot) break;
    }
  }
  return best;
}

/** 헬스체크: 마지막 실행 이후 경과가 주기 + 30분을 넘으면 미실행 의심 */
export function isOverdue(def: AutomationDef, lastStartedAt: string | null, now: Date = new Date()): boolean {
  if (def.schedule.type !== "interval") return false;
  const limitMs = def.schedule.intervalHours * 3600000 + 30 * 60000;
  if (!lastStartedAt) return true;
  return now.getTime() - new Date(lastStartedAt).getTime() > limitMs;
}
