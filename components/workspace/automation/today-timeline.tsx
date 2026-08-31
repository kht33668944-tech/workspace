"use client";

// 오늘의 자동화 타임라인 — 예정/진행중/성공/일부실패/실패/미실행
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { RUN_STATUS_LABEL, type TimelineSlot, type SlotStatus } from "@/lib/automation-schedule";
import { formatLogTime } from "@/lib/log-format";
import RunDetail from "./run-detail";

// 라벨은 RUN_STATUS_LABEL(공용)에서, 여기는 색상만
const STATUS_META: Record<SlotStatus, { dot: string; text: string }> = {
  upcoming: { dot: "bg-[var(--border)]", text: "text-[var(--text-muted)]" },
  running: { dot: "bg-blue-400 animate-pulse", text: "text-blue-400" },
  success: { dot: "bg-emerald-400", text: "text-emerald-400" },
  partial: { dot: "bg-amber-400", text: "text-amber-400" },
  failed: { dot: "bg-red-400", text: "text-red-400" },
  stale: { dot: "bg-red-400", text: "text-red-400" },
  missed: { dot: "bg-red-400", text: "text-red-400" },
  manual: { dot: "bg-blue-400", text: "text-blue-400" },
  unknown: { dot: "bg-[var(--border)]", text: "text-[var(--text-muted)]" },
};

export default function TodayTimeline({ slots }: { slots: TimelineSlot[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const nowRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);

  // 첫 로드 시 현재 시각 근처(다가오는 첫 슬롯)로 스크롤 — 1회만
  const firstUpcomingIdx = slots.findIndex((s) => s.status === "upcoming" || s.status === "running");
  useEffect(() => {
    if (scrolledRef.current || !nowRef.current) return;
    scrolledRef.current = true;
    nowRef.current.scrollIntoView({ block: "center" });
  });

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <h2 className="text-base font-semibold text-[var(--text-primary)] mb-4">오늘의 타임라인</h2>
      <div className="relative space-y-0.5 max-h-[28rem] overflow-y-auto pr-1">
        {slots.map((slot, idx) => {
          const id = `${slot.key}-${slot.scheduledAt}`;
          const meta = STATUS_META[slot.status];
          const clickable = slot.runs.length > 0;
          const isOpen = expanded === id;
          return (
            <div key={id} ref={idx === firstUpcomingIdx ? nowRef : null}>
              <button
                onClick={() => clickable && setExpanded(isOpen ? null : id)}
                className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-lg text-left ${clickable ? "hover:bg-[var(--bg-hover)] cursor-pointer" : "cursor-default"}`}
              >
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${meta.dot}`} />
                <span className="text-xs text-[var(--text-muted)] w-11 shrink-0 tabular-nums">{formatLogTime(slot.scheduledAt)}</span>
                <span className="text-xs font-medium text-[var(--text-secondary)] w-24 shrink-0">{slot.label}</span>
                <span className={`text-xs ${meta.text} flex items-center gap-1`}>
                  {slot.status === "missed" && <AlertTriangle className="w-3 h-3" />}
                  {RUN_STATUS_LABEL[slot.status]}
                </span>
                {clickable && (
                  <span className="ml-auto text-[var(--text-muted)]">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </span>
                )}
              </button>
              {isOpen && <div className="ml-7 my-1"><RunDetail runs={slot.runs} /></div>}
            </div>
          );
        })}
        {slots.length === 0 && <p className="text-sm text-[var(--text-muted)] py-4 text-center">오늘 예정된 자동화가 없습니다.</p>}
      </div>
    </section>
  );
}
