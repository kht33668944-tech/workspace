"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Clock, Download, FlaskConical, Loader2, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { MarketplaceSyncRun } from "@/types/database";

interface NewOrder { id?: string; bundleNo: string | null; recipientName: string | null; productName: string | null; quantity: number; revenue: number; marketplaceStatus: string | null }
interface Claim { orderId: string; recipientName: string | null; productName: string | null; from: string; to: string; claimStatus: string; reason?: string }
interface SyncResult {
  platform: "coupang" | "smartstore";
  dryRun: boolean;
  remoteCount: number;
  newOrders: NewOrder[];
  skippedExisting: number;
  confirmed: number;
  confirmFailed: number;
  confirmErrors: string[];
  claims: Claim[];
  errors: string[];
}
interface ApproveRow { orderId: string; recipientName: string | null; productName: string | null; status: "success" | "failed" | "dry"; message: string }

interface Props {
  onClose: () => void;
  onDone: () => void;
  /** 취소요청 상태인 주문 (승인 대상) */
  cancelRequests: Array<{ id: string; marketplace: string | null; recipient_name: string | null; product_name: string | null; quantity: number; claim_status?: string | null }>;
}

const LABEL = { coupang: "쿠팡", smartstore: "스마트스토어" } as const;

function fmt(iso: string | null) {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function OrderSyncModal({ onClose, onDone, cancelRequests }: Props) {
  const { session } = useAuth();
  const [days, setDays] = useState(3);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SyncResult[]>([]);
  const [runs, setRuns] = useState<MarketplaceSyncRun[]>([]);
  const [error, setError] = useState("");
  const [approving, setApproving] = useState(false);
  const [approveResults, setApproveResults] = useState<ApproveRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const headers = useCallback(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` }), [session?.access_token]);

  const loadRuns = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/marketplace-api/orders/sync?limit=6", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = (await res.json()) as MarketplaceSyncRun[];
      setRuns(Array.isArray(data) ? data : []);
    } catch { /* 표시만 */ }
  }, [session?.access_token]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const handleSync = async () => {
    setRunning(true);
    setError("");
    setResults([]);
    try {
      const res = await fetch("/api/marketplace-api/orders/sync", { method: "POST", headers: headers(), body: JSON.stringify({ platform: "all", days }) });
      const data = (await res.json()) as { results?: SyncResult[]; error?: string };
      if (!res.ok) return setError(data.error ?? "주문 수집 실패");
      setResults(data.results ?? []);
      onDone();
      loadRuns();
    } catch {
      setError("주문 수집 중 오류가 발생했습니다.");
    } finally {
      setRunning(false);
    }
  };

  const handleApprove = async () => {
    if (selected.size === 0) return;
    if (!confirm(`취소요청 ${selected.size}건을 승인합니다. 마켓에서 환불이 진행되며 되돌릴 수 없습니다. 계속할까요?`)) return;
    setApproving(true);
    setError("");
    try {
      const res = await fetch("/api/marketplace-api/orders/claims/approve", { method: "POST", headers: headers(), body: JSON.stringify({ orderIds: [...selected] }) });
      const data = (await res.json()) as { results?: ApproveRow[]; error?: string };
      if (!res.ok) return setError(data.error ?? "승인 실패");
      setApproveResults(data.results ?? []);
      setSelected(new Set());
      onDone();
    } catch {
      setError("승인 중 오류가 발생했습니다.");
    } finally {
      setApproving(false);
    }
  };

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const dry = results.some((r) => r.dryRun);
  const totalNew = results.reduce((n, r) => n + r.newOrders.length, 0);
  const totalClaims = results.reduce((n, r) => n + r.claims.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={() => !running && !approving && onClose()} />
      <div className="relative w-full max-w-5xl max-h-[92vh] overflow-hidden bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Download className="w-4 h-4 text-blue-400" />
              마켓 주문 수집 (API)
              {dry && <span className="px-2 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400 flex items-center gap-1"><FlaskConical className="w-3 h-3" />DRY RUN</span>}
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-1">쿠팡·스마트스토어의 새 주문을 발주서에 등록하고 발주확인합니다. 구매자 취소요청·반품·교환도 발주서에 반영됩니다. (ESM은 플레이오토/엑셀)</p>
          </div>
          <button onClick={onClose} disabled={running || approving} className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg disabled:opacity-50"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5">
          {error && <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm"><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}

          {/* 수집 */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-[var(--text-tertiary)]">최근</label>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[40px] text-sm">
                {[1, 3, 7, 14].map((d) => <option key={d} value={d}>{d}일</option>)}
              </select>
              <button onClick={handleSync} disabled={running} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">
                {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {running ? "마켓 조회 중... (1~2분)" : "지금 수집"}
              </button>
              {runs[0] && (
                <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                  <Clock className="w-3 h-3" /> 마지막 {runs[0].trigger === "scheduler" ? "자동" : "수동"} 수집 {fmt(runs[0].started_at)} · {LABEL[runs[0].platform as keyof typeof LABEL] ?? runs[0].platform} 신규 {runs[0].new_orders} · {runs[0].status}
                </span>
              )}
            </div>

            {results.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {results.map((r) => (
                  <div key={r.platform} className="border border-[var(--border)] rounded-lg p-3 text-sm space-y-1">
                    <div className="font-medium text-[var(--text-primary)]">{LABEL[r.platform]} — 마켓 {r.remoteCount}건 조회</div>
                    <div className="text-[var(--text-secondary)]">신규 <strong className="text-green-400">{r.newOrders.length}</strong> · 이미 있음 {r.skippedExisting} · 발주확인 {r.confirmed}{r.confirmFailed ? <span className="text-red-400"> (실패 {r.confirmFailed})</span> : null} · 클레임 {r.claims.length}</div>
                    {[...r.errors, ...r.confirmErrors].map((e, i) => <div key={i} className="text-xs text-red-400">{e}</div>)}
                  </div>
                ))}
              </div>
            )}

            {totalNew > 0 && (
              <div>
                <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">신규 등록 {totalNew}건</h3>
                <div className="max-h-56 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                  {results.flatMap((r) => r.newOrders.map((o) => (
                    <div key={`${r.platform}-${o.bundleNo}-${o.productName}`} className="px-3 py-1.5 text-sm flex justify-between gap-3">
                      <span className="truncate"><span className="text-[var(--text-muted)] mr-2">{LABEL[r.platform]}</span>{o.recipientName} · {o.productName} ×{o.quantity}</span>
                      <span className="text-[var(--text-muted)] shrink-0">₩{o.revenue.toLocaleString()}</span>
                    </div>
                  )))}
                </div>
              </div>
            )}

            {totalClaims > 0 && (
              <div>
                <h3 className="text-sm font-medium text-amber-400 mb-2">클레임 반영 {totalClaims}건</h3>
                <div className="max-h-44 overflow-y-auto border border-amber-500/20 rounded-lg divide-y divide-amber-500/10">
                  {results.flatMap((r) => r.claims.map((c) => (
                    <div key={c.orderId} className="px-3 py-1.5 text-sm"><span className="text-[var(--text-primary)]">{c.recipientName} · {c.productName}</span><span className="text-[var(--text-muted)]"> · {c.from} → {c.to}{c.reason ? ` (${c.reason})` : ""}</span></div>
                  )))}
                </div>
              </div>
            )}
          </section>

          {/* 취소요청 승인 */}
          <section className="space-y-3 border-t border-[var(--border)] pt-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-[var(--text-primary)]">구매자 취소요청 — 승인 대기 {cancelRequests.length}건</h3>
              <button onClick={handleApprove} disabled={approving || selected.size === 0} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50">
                {approving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                선택 {selected.size}건 취소 승인
              </button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">승인하면 마켓에서 환불이 진행됩니다. 거절(발송 강행)은 송장을 등록하면 자동 처리되며 다음 단계에서 버튼으로 제공됩니다. 이미 구매(발주)한 건은 소싱처 취소도 함께 확인하세요.</p>
            {cancelRequests.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">승인 대기 중인 취소요청이 없습니다.</p>
            ) : (
              <div className="max-h-56 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                {cancelRequests.map((o) => (
                  <label key={o.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-[var(--bg-hover)]">
                    <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(o.id)} disabled={approving} />
                    <span className="text-[var(--text-muted)] w-20 shrink-0">{o.marketplace}</span>
                    <span className="truncate">{o.recipient_name} · {o.product_name} ×{o.quantity}</span>
                    {o.claim_status && <span className="text-xs text-[var(--text-muted)] ml-auto shrink-0">{o.claim_status}</span>}
                  </label>
                ))}
              </div>
            )}
            {approveResults.length > 0 && (
              <div className="max-h-40 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                {approveResults.map((r) => (
                  <div key={r.orderId} className="flex items-start gap-2 px-3 py-1.5 text-sm">
                    {r.status === "failed" ? <AlertCircle className="w-4 h-4 text-red-400 mt-0.5" /> : r.status === "dry" ? <FlaskConical className="w-4 h-4 text-amber-400 mt-0.5" /> : <CheckCircle className="w-4 h-4 text-green-400 mt-0.5" />}
                    <span>{r.recipientName} · {r.productName} — {r.message}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {runs.length > 1 && (
            <section className="border-t border-[var(--border)] pt-4">
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">최근 실행</h3>
              <div className="text-xs text-[var(--text-muted)] space-y-0.5">
                {runs.map((r) => <div key={r.id}>{fmt(r.started_at)} · {r.trigger === "scheduler" ? "자동" : "수동"} · {LABEL[r.platform as keyof typeof LABEL] ?? r.platform} · 조회 {r.remote_count} · 신규 {r.new_orders} · 확인 {r.confirmed} · {r.status}{r.dry_run ? " [DRY]" : ""}{r.error ? ` · ${r.error.slice(0, 80)}` : ""}</div>)}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
