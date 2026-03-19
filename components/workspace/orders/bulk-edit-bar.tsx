"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown, X } from "lucide-react";
import { DELIVERY_STATUSES } from "@/lib/constants";

interface BulkEditBarProps {
  count: number;
  onChangeStatus: (status: string) => void;
  onClearSelection: () => void;
}

export default function BulkEditBar({ count, onChangeStatus, onClearSelection }: BulkEditBarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2.5 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl">
      <span className="text-sm font-medium text-[var(--text-primary)] shrink-0">
        {count}개 선택됨
      </span>

      <div className="w-px h-4 bg-[var(--border)]" />

      {/* 배송 상태 변경 드롭다운 */}
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-[var(--text-primary)] bg-[var(--bg-hover)] hover:bg-[var(--bg-active)] transition-colors"
        >
          배송 상태 변경
          <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        </button>

        {open && (
          <div className="absolute bottom-full mb-2 left-0 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl py-1 min-w-[130px] z-50">
            {DELIVERY_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => { onChangeStatus(s); setOpen(false); }}
                className="w-full px-3 py-1.5 text-left text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onClearSelection}
        className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        title="선택 해제"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
