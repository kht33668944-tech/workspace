"use client";

import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from "lucide-react";
import type { Toast, ToastType } from "@/context/ToastContext";

const icons: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />,
  error: <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />,
  info: <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />,
  warning: <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />,
};

const borderColors: Record<ToastType, string> = {
  success: "border-green-500/40",
  error: "border-red-500/40",
  info: "border-blue-500/40",
  warning: "border-orange-500/40",
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      className={`toast-in flex items-start gap-3 px-4 py-3 rounded-xl border shadow-xl bg-[var(--bg-card)] min-w-[220px] max-w-[360px] ${borderColors[toast.type]}`}
    >
      {icons[toast.type]}
      <p className="flex-1 text-sm text-[var(--text-primary)] leading-snug">
        {toast.message}
      </p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}
