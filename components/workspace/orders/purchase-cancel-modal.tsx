"use client";

import { useState } from "react";
import { X } from "lucide-react";
import {
  PURCHASE_CANCEL_MODES,
  PURCHASE_CANCEL_REASONS,
  type PurchaseCancelMode,
  type PurchaseCancelReason,
} from "@/lib/purchase-cancellation";

interface PurchaseCancelModalProps {
  count: number;
  onClose: () => void;
  onSubmit: (mode: PurchaseCancelMode, reason: PurchaseCancelReason) => Promise<void>;
}

const MODE_OPTIONS: Array<{ value: PurchaseCancelMode; label: string; description: string }> = [
  {
    value: "not_purchased",
    label: "구매 전 실패/품절",
    description: "실제 구매가 완료되지 않은 주문입니다.",
  },
  {
    value: "purchased_cancelled",
    label: "구매 후 취소/환불",
    description: "구매처 주문이 생성된 뒤 취소 또는 환불된 주문입니다.",
  },
];

export default function PurchaseCancelModal({ count, onClose, onSubmit }: PurchaseCancelModalProps) {
  const [mode, setMode] = useState<PurchaseCancelMode>(PURCHASE_CANCEL_MODES[0]);
  const [reason, setReason] = useState<PurchaseCancelReason>(PURCHASE_CANCEL_REASONS[0]);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmit(mode, reason);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">구매취소/정리</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">선택한 {count}건의 구매정보를 한 번에 정리합니다.</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block mb-2 text-xs text-[var(--text-tertiary)]">구매 상태</label>
            <div className="space-y-2">
              {MODE_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-start gap-3 p-3 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)] cursor-pointer">
                  <input
                    type="radio"
                    name="purchase-cancel-mode"
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() => setMode(option.value)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <span>
                    <span className="block text-sm text-[var(--text-primary)]">{option.label}</span>
                    <span className="block mt-0.5 text-xs text-[var(--text-muted)]">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="purchase-cancel-reason" className="block mb-2 text-xs text-[var(--text-tertiary)]">정리 사유</label>
            <select
              id="purchase-cancel-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value as PurchaseCancelReason)}
              className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50"
            >
              {PURCHASE_CANCEL_REASONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>

          <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
            구매로그는 삭제하지 않고 취소 기록으로 보관합니다. 이후 중복구매 검사와 카드 집계에서는 제외됩니다.
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--border)]">
          <button type="button" onClick={onClose} disabled={submitting} className="px-4 py-2 text-sm text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-40">
            닫기
          </button>
          <button type="button" onClick={handleSubmit} disabled={submitting} className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg">
            {submitting ? "처리 중..." : "구매취소 처리"}
          </button>
        </div>
      </div>
    </div>
  );
}
