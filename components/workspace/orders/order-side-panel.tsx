"use client";

import { useState, useRef, useEffect } from "react";
import { X, Send, Clock } from "lucide-react";
import { DELIVERY_STATUSES, DELIVERY_STATUS_COLORS } from "@/lib/constants";
import { sanitizeText } from "@/lib/sanitize";
import type { Order, OrderUpdate, ConsultationLog } from "@/types/database";

interface OrderSidePanelProps {
  order: Order;
  onUpdate: (id: string, updates: OrderUpdate) => void;
  onClose: () => void;
}

export default function OrderSidePanel({ order, onUpdate, onClose }: OrderSidePanelProps) {
  const [logInput, setLogInput] = useState("");
  const logsEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number | null>(null);

  const logs: ConsultationLog[] = Array.isArray(order.consultation_logs) ? order.consultation_logs : [];

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  const handleAddLog = () => {
    const content = sanitizeText(logInput.trim());
    if (!content) return;

    const newLog: ConsultationLog = {
      date: new Date().toISOString(),
      author: "나",
      content,
    };

    const updatedLogs = [...logs, newLog];
    onUpdate(order.id, { consultation_logs: updatedLogs });
    setLogInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAddLog();
    }
  };

  const statusColor = DELIVERY_STATUS_COLORS[order.delivery_status] || "bg-gray-500/20 text-gray-400";

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (dx > 80) onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 z-50 h-full w-full md:w-[420px] md:max-w-[90vw] bg-[var(--bg-card)] border-l border-[var(--border)] shadow-2xl flex flex-col animate-slide-in"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${statusColor}`}>
                {order.delivery_status || "결제전"}
              </span>
              <span className="text-xs text-[var(--text-muted)] truncate">{order.recipient_name || "-"}</span>
            </div>
            <h2 className="text-sm font-medium text-[var(--text-primary)] truncate" title={order.product_name || ""}>{order.product_name || "상품명 없음"}</h2>
          </div>
          <button onClick={onClose} className="p-2.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0 ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* 배송상태 */}
          <div className="px-5 py-3 border-b border-[var(--border)]">
            <label className="text-xs text-[var(--text-tertiary)] mb-1.5 block">배송상태 변경</label>
            <select
              value={order.delivery_status || "결제전"}
              onChange={(e) => onUpdate(order.id, { delivery_status: e.target.value })}
              className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50"
            >
              {DELIVERY_STATUSES.map((s) => (
                <option key={s} value={s} className="bg-[var(--bg-elevated)] text-[var(--text-primary)]">{s}</option>
              ))}
            </select>
          </div>

          {/* 상담내역 타임라인 */}
          <div className="px-5 py-3">
            <h3 className="text-xs font-medium text-[var(--text-tertiary)] mb-3">상담내역</h3>
            {logs.length === 0 ? (
              <p className="text-xs text-[var(--text-disabled)] text-center py-4">상담내역이 없습니다</p>
            ) : (
              <div className="space-y-3">
                {logs.map((log, i) => (
                  <div key={i} className="relative pl-5 border-l-2 border-[var(--border)]">
                    <div className="absolute left-[-5px] top-1 w-2 h-2 rounded-full bg-blue-500" />
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium text-[var(--text-secondary)]">{log.author}</span>
                      <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(log.date).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-tertiary)] whitespace-pre-wrap">{log.content}</p>
                  </div>
                ))}
              </div>
            )}
            <div ref={logsEndRef} />
          </div>
        </div>

        {/* 상담내역 입력 */}
        <div className="px-5 py-3 border-t border-[var(--border)] shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              value={logInput}
              onChange={(e) => setLogInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="상담내역을 입력하세요..."
              rows={2}
              className="flex-1 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-blue-500/50 resize-none"
            />
            <button
              onClick={handleAddLog}
              disabled={!logInput.trim()}
              className="p-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 text-[var(--text-primary)] rounded-lg transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in {
          animation: slideIn 0.2s ease-out;
        }
      `}</style>
    </>
  );
}
