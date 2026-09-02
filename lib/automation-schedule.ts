// 자동화 스케줄 정의 + 타임라인/헬스체크 계산 (자동화 페이지·크론 공용, React/supabase 의존 없음)
// ⚠ schedule 값은 Windows 작업 스케줄러 등록(scripts/register-*-task.ps1)과 일치해야 한다.
//   ps1 쪽이 이 앵커(OnliveOrderSync 매시 :00 / OnliveTrackingShip 02:30 기점 3시간 / OnliveAutoPrice 00:15 기점 4시간)로
//   고정 등록하므로, 앵커를 바꿀 때는 ps1과 여기를 같이 수정해야 한다.

import type { MarketplaceSyncRun } from "@/types/database";
import { toKstDateKey } from "@/lib/date-utils";

export type AutomationKey = "order-sync" | "inquiries" | "tracking-ship" | "price" | "settlement" | "daily-summary" | "auto-purchase" | "gmarket-return";
export type RunKind =
  | "orders" | "inquiries" | "shipping" | "tracking-collect" | "esm-export"
  | "settlement" | "daily-summary" | "price" | "health-alert"
  | "auto-purchase" | "gmarket-return" | "return-track";

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
    | { type: "daily-latch"; afterHourKst: number }
    /** 예정 슬롯 없음 — 수동 버튼 전용이거나 조건부(설정 토글)라 미실행 판정을 하지 않는 자동화 */
    | { type: "manual" };
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
    key: "tracking-ship", label: "운송장·송장", description: "구매처 운송장 수집 → 마켓 송장 전송 → ESM 엑셀 → 지마켓 반품추적",
    taskName: "OnliveTrackingShip", runVia: "schtasks",
    kinds: ["tracking-collect", "shipping", "esm-export", "return-track"], primaryKind: "tracking-collect",
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
  {
    // 설정(auto_purchase) 켜져 있을 때만 주문수집 뒤에 이어 돎 — 꺼진 동안 "미실행" 오탐을 막기 위해 예정 슬롯 없음
    key: "auto-purchase", label: "자동구매", description: "신규 발주건 원가갱신 → 계정배정 → 자동구매 (주문수집 직후, 설정 토글)",
    taskName: "OnliveOrderSync", runVia: null,
    kinds: ["auto-purchase"], primaryKind: "auto-purchase",
    schedule: { type: "manual" },
    maxRuntimeMin: 60, toleranceMin: 10,
  },
  {
    key: "gmarket-return", label: "지마켓 반품", description: "반품·교환 들어온 지마켓 구매건 반품신청 (수동 버튼, 드라이런→실행)",
    taskName: null, runVia: "api", apiPath: "/api/marketplace-api/returns/gmarket",
    kinds: ["gmarket-return"], primaryKind: "gmarket-return",
    schedule: { type: "manual" },
    maxRuntimeMin: 30, toleranceMin: 10,
  },
];

export const KIND_TO_KEY: Record<RunKind, AutomationKey | null> = {
  orders: "order-sync",
  inquiries: "inquiries",
  shipping: "tracking-ship",
  "tracking-collect": "tracking-ship",
  "esm-export": "tracking-ship",
  "return-track": "tracking-ship",
  settlement: "settlement",
  "daily-summary": "daily-summary",
  price: "price",
  "health-alert": null,
  "auto-purchase": "auto-purchase",
  "gmarket-return": "gmarket-return",
};

export const AUTOMATION_BY_KEY = Object.fromEntries(
  AUTOMATIONS.map((d) => [d.key, d]),
) as Record<AutomationKey, AutomationDef>;

/** run.kind → 사람용 라벨 (진행중 카드·오류 센터 공용) */
export function runLabelForKind(kind: string | null | undefined): string {
  const key = KIND_TO_KEY[(kind ?? "orders") as RunKind];
  return key ? AUTOMATION_BY_KEY[key].label : kind ?? "자동화";
}

/** run.status/SlotStatus → 사람용 라벨 (타임라인·상태 카드·오류 센터가 공유해 표기 통일) */
export const RUN_STATUS_LABEL: Record<SlotStatus, string> = {
  upcoming: "예정",
  running: "진행중",
  success: "성공",
  partial: "일부 실패",
  failed: "실패",
  stale: "중단됨",
  missed: "미실행",
  manual: "수동 실행",
  unknown: "기록 없음",
};

/** price run 의 detail.phase 라벨 — 최저가 자동화 전용 (다른 kind 의 phase 를 섞지 말 것) */
export const PRICE_PHASE_LABEL: Record<string, string> = {
  init: "시작 중",
  reset: "전일대비 초기화",
  scrape: "최저가 수집",
  apply: "가격 적용",
  margins: "품절/재입고 마진 처리",
  market: "마켓 API 반영",
  excel: "엑셀 저장",
};

/** price run detail.scrape.rounds 항목 (auto-price-refresh.mjs 가 기록하는 계약) */
export interface PriceRound { round: number; collected: number; soldOut: number; retry: number }

/** 해당 KST 날짜의 예정 실행 시각 ISO 배열 (daily-latch 는 기준 시각 1개) */
export function slotsForKstDate(def: AutomationDef, dateKst: string): string[] {
  if (def.schedule.type === "manual") return [];
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

export type SlotStatus = "upcoming" | "running" | "success" | "partial" | "failed" | "missed" | "stale" | "manual" | "unknown";

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
  const limitMin = AUTOMATION_BY_KEY[key].maxRuntimeMin + 15;
  return now.getTime() - new Date(run.started_at).getTime() > limitMin * 60000;
}

const STATUS_RANK: Record<SlotStatus, number> = {
  upcoming: 0, manual: 0, unknown: 0, missed: 0,
  success: 0, running: 1, partial: 2, stale: 3, failed: 4,
};

function worstOf(runs: Array<{ run: MarketplaceSyncRun; stale: boolean }>): SlotStatus {
  let worst: SlotStatus = "success";
  for (const { run, stale } of runs) {
    const s: SlotStatus = run.status === "running" ? (stale ? "stale" : "running") : (run.status as SlotStatus);
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

/** 오늘(KST) 타임라인: 예정 슬롯 + run 매칭 + 미실행 판정. 수동 실행(trigger=manual)은 별도 항목 */
export function buildTodayTimeline(runs: MarketplaceSyncRun[], now: Date = new Date()): TimelineSlot[] {
  const today = toKstDateKey(now);
  const slots: TimelineSlot[] = [];
  const usedRunIds = new Set<string>();

  // started_at 파싱·stale 판정·자동화 매핑을 1회만 계산해두고 슬롯 매칭은 자동화별 버킷만 스캔
  const rows = runs.map((r) => ({
    run: r,
    key: KIND_TO_KEY[(r.kind ?? "orders") as RunKind],
    startedMs: new Date(r.started_at).getTime(),
    stale: isStaleRunning(r, now),
  }));
  const byKey = new Map<AutomationKey, typeof rows>();
  const firstRunMs = new Map<AutomationKey, number>(); // 기록 도입 전 슬롯은 "미실행" 대신 "기록 없음" (콜드스타트 오탐 방지)
  for (const row of rows) {
    if (!row.key) continue;
    const bucket = byKey.get(row.key);
    if (bucket) bucket.push(row); else byKey.set(row.key, [row]);
    const prev = firstRunMs.get(row.key);
    if (prev === undefined || row.startedMs < prev) firstRunMs.set(row.key, row.startedMs);
  }

  for (const def of AUTOMATIONS) {
    const bucket = byKey.get(def.key) ?? [];
    for (const slotIso of slotsForKstDate(def, today)) {
      const slotMs = new Date(slotIso).getTime();
      const tolMs = def.toleranceMin * 60000;
      const matched = bucket.filter((row) =>
        row.run.trigger === "scheduler" &&
        def.kinds.includes((row.run.kind ?? "orders") as RunKind) &&
        row.startedMs >= slotMs - tolMs && row.startedMs <= slotMs + tolMs
      );
      for (const row of matched) usedRunIds.add(row.run.id);
      let status: SlotStatus;
      if (matched.length > 0) status = worstOf(matched);
      else if (slotMs + tolMs >= now.getTime()) status = "upcoming";
      else {
        const first = firstRunMs.get(def.key);
        status = first !== undefined && first <= slotMs ? "missed" : "unknown";
      }
      slots.push({ key: def.key, label: def.label, scheduledAt: slotIso, status, runs: matched.map((m) => m.run) });
    }
  }

  // 수동 실행 + 슬롯에 매칭 안 된 스케줄 실행(catch-up 등)은 실제 시각으로 별도 표시
  const todayStartMs = new Date(`${today}T00:00:00+09:00`).getTime();
  for (const row of rows) {
    if (!row.key || usedRunIds.has(row.run.id) || row.startedMs < todayStartMs) continue;
    slots.push({
      key: row.key,
      label: AUTOMATION_BY_KEY[row.key].label,
      scheduledAt: row.run.started_at,
      status: row.run.trigger === "manual" ? "manual" : worstOf([row]),
      runs: [row.run],
    });
  }

  return slots.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** 다음 예정 실행 (카운트다운용) — interval 스케줄만 대상 */
export function nextScheduledRun(now: Date = new Date()): { def: AutomationDef; at: string } | null {
  let best: { def: AutomationDef; at: string } | null = null;
  const days = [toKstDateKey(now), toKstDateKey(now.getTime() + 86400000)];
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
