"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

interface MobileSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** 높이 상한. 기본 85vh */
  maxHeight?: string;
  /** 하단에서 올라오는 애니메이션 비활성화 (중앙 모달로 쓰고 싶을 때) */
  disableSlide?: boolean;
}

export default function MobileSheet({
  open,
  onClose,
  title,
  children,
  maxHeight = "85vh",
  disableSlide = false,
}: MobileSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleTouchStart = (e: React.TouchEvent) => {
    if (disableSlide) return;
    // 헤더 영역 드래그로만 시작 (내용 스크롤과 충돌 방지)
    const target = e.target as HTMLElement;
    if (!target.closest("[data-sheet-handle]")) return;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 0) setDragOffset(dy);
  };

  const handleTouchEnd = () => {
    if (touchStartY.current === null) return;
    if (dragOffset > 100) onClose();
    touchStartY.current = null;
    setDragOffset(0);
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-[60]"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className={`fixed inset-x-0 bottom-0 z-[61] bg-[var(--bg-card)] border-t border-[var(--border)] rounded-t-2xl shadow-2xl flex flex-col ${
          disableSlide ? "" : "animate-sheet-up"
        }`}
        style={{
          maxHeight,
          transform: dragOffset ? `translateY(${dragOffset}px)` : undefined,
          transition: dragOffset ? "none" : "transform 200ms ease-out",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          data-sheet-handle
          className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-[var(--border)] cursor-grab active:cursor-grabbing shrink-0"
        >
          <div className="flex-1 flex flex-col items-center gap-2">
            <div className="w-10 h-1 rounded-full bg-[var(--border)]" />
            {title && (
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                {title}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="absolute right-3 top-3 flex items-center justify-center min-w-[36px] min-h-[36px] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>
    </>
  );
}
