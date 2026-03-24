"use client";

import { ChevronLeft, ChevronRight, Calendar, Copy, Plus, Trash2 } from "lucide-react";

interface FinanceDateNavProps {
  selectedDate: string;
  onDateChange: (date: string) => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
  onCreateSnapshot: (copyFromPrevious: boolean) => void;
  onDeleteSnapshot: () => void;
  hasSnapshot: boolean;
  isToday: boolean;
  saveStatus: "idle" | "saving" | "saved" | "error";
}

export default function FinanceDateNav({
  selectedDate,
  onDateChange,
  onPrevDay,
  onNextDay,
  onToday,
  onCreateSnapshot,
  onDeleteSnapshot,
  hasSnapshot,
  isToday,
  saveStatus,
}: FinanceDateNavProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 날짜 네비게이션 */}
      <div className="flex items-center gap-1">
        <button
          onClick={onPrevDay}
          className="p-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors text-[var(--text-muted)]"
          title="전일"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="relative">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => onDateChange(e.target.value)}
            className="px-3 py-1.5 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] outline-none focus:border-blue-400 [color-scheme:dark]"
          />
        </div>

        <button
          onClick={onNextDay}
          className="p-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors text-[var(--text-muted)]"
          title="다음날"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        {!isToday && (
          <button
            onClick={onToday}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors flex items-center gap-1"
          >
            <Calendar className="w-3 h-3" />
            오늘
          </button>
        )}
      </div>

      {/* 액션 버튼 */}
      <div className="flex items-center gap-2 ml-auto">
        {/* 저장 상태 */}
        {hasSnapshot && (
          <span
            className={`text-xs ${
              saveStatus === "saving"
                ? "text-yellow-400"
                : saveStatus === "saved"
                  ? "text-green-400"
                  : saveStatus === "error"
                    ? "text-red-400"
                    : "text-transparent"
            } transition-colors`}
          >
            {saveStatus === "saving"
              ? "저장 중..."
              : saveStatus === "saved"
                ? "저장됨 ✓"
                : saveStatus === "error"
                  ? "저장 실패"
                  : "·"}
          </span>
        )}

        {!hasSnapshot ? (
          <>
            <button
              onClick={() => onCreateSnapshot(true)}
              className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center gap-1"
            >
              <Copy className="w-3 h-3" />
              전날 복사로 생성
            </button>
            <button
              onClick={() => onCreateSnapshot(false)}
              className="px-3 py-1.5 text-xs rounded-lg bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              빈 스냅샷
            </button>
          </>
        ) : (
          <button
            onClick={onDeleteSnapshot}
            className="px-3 py-1.5 text-xs rounded-lg text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            삭제
          </button>
        )}
      </div>
    </div>
  );
}
