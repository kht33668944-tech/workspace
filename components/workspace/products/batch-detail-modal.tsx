"use client";

import { X, CheckCircle, XCircle, Loader2, Clock } from "lucide-react";
import type { BatchItem } from "@/context/AiTaskContext";

interface Props {
  items: BatchItem[];
  onClose: () => void;  // 숨기기 (처리는 계속)
  onClear: () => void;  // 완전 초기화
}

const STATUS_LABEL: Record<BatchItem["status"], string> = {
  pending: "대기 중",
  running: "생성 중...",
  done: "완료",
  error: "실패",
};

export default function BatchDetailModal({ items, onClose, onClear }: Props) {
  const done = items.filter((i) => i.status === "done").length;
  const errors = items.filter((i) => i.status === "error").length;
  const total = items.length;
  const allFinished = items.every((i) => i.status === "done" || i.status === "error");
  const progressPct = total > 0 ? Math.round(((done + errors) / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none">
      <div className="pointer-events-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[70vh]">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              상세페이지 일괄 생성
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {allFinished
                ? `완료 ${done}건 / 실패 ${errors}건`
                : `진행 중 — ${done + errors} / ${total}건`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            title="최소화 (처리는 계속됩니다)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 진행 바 */}
        <div className="h-1.5 bg-[var(--bg-main)] shrink-0">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              allFinished && errors === 0
                ? "bg-emerald-500"
                : allFinished
                ? "bg-amber-500"
                : "bg-blue-500"
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {/* 목록 */}
        <div className="flex-1 overflow-y-auto py-2">
          {items.map((item) => (
            <div
              key={item.productId}
              className="flex items-start gap-3 px-5 py-2.5 hover:bg-[var(--bg-main)] transition-colors"
            >
              {/* 상태 아이콘 */}
              <div className="shrink-0 mt-0.5">
                {item.status === "done" && (
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                )}
                {item.status === "error" && (
                  <XCircle className="w-4 h-4 text-red-400" />
                )}
                {item.status === "running" && (
                  <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                )}
                {item.status === "pending" && (
                  <Clock className="w-4 h-4 text-[var(--text-disabled)]" />
                )}
              </div>

              {/* 상품명 + 상태 */}
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[var(--text-primary)] truncate">
                  {item.productName}
                </p>
                <p
                  className={`text-[10px] mt-0.5 ${
                    item.status === "done"
                      ? "text-emerald-400"
                      : item.status === "error"
                      ? "text-red-400"
                      : item.status === "running"
                      ? "text-blue-400"
                      : "text-[var(--text-disabled)]"
                  }`}
                >
                  {item.status === "error" && item.errorMsg
                    ? item.errorMsg
                    : STATUS_LABEL[item.status]}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* 푸터 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--border)] shrink-0">
          <p className="text-[10px] text-[var(--text-muted)]">
            {allFinished
              ? "모두 완료되었습니다."
              : "다른 메뉴로 이동해도 처리가 계속됩니다."}
          </p>
          {allFinished ? (
            <button
              onClick={onClear}
              className="px-3 py-1.5 text-xs bg-[var(--bg-main)] hover:bg-[var(--border)] text-[var(--text-muted)] rounded-lg transition-colors"
            >
              닫기
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              최소화
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
