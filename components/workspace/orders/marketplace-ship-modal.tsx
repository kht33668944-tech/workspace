"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, FlaskConical, Loader2, Send, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface Candidate {
  id: string;
  bundle_no: string | null;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number;
  courier: string | null;
  tracking_no: string | null;
  delivery_status: string;
  shipped_to_marketplace_at: string | null;
  ship_error: string | null;
}
interface Skipped extends Candidate { reason: string }
interface PlatformPreview { hasCredential: boolean; ready: Candidate[]; skipped: Skipped[] }
interface Preview { dryRun: boolean; coupang?: PlatformPreview; smartstore?: PlatformPreview }
interface ShipRow { orderId: string; recipientName: string | null; productName: string | null; courier: string | null; trackingNo: string | null; status: "success" | "already" | "failed" | "dry"; message: string }
interface ShipResult { platform: "coupang" | "smartstore"; dryRun: boolean; candidates: number; sent: number; alreadySent: number; failed: number; skipped: Skipped[]; rows: ShipRow[]; errors: string[] }

interface Props {
  /** 선택한 주문 (없으면 미전송 전체) */
  selectedIds: string[];
  onClose: () => void;
  onDone: () => void;
}

const LABEL = { coupang: "쿠팡", smartstore: "스마트스토어" } as const;
const PLATFORMS = ["coupang", "smartstore"] as const;

export default function MarketplaceShipModal({ selectedIds, onClose, onDone }: Props) {
  const { session } = useAuth();
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [results, setResults] = useState<ShipResult[] | null>(null);
  const [error, setError] = useState("");

  const headers = useCallback(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` }), [session?.access_token]);

  const loadPreview = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/marketplace-api/orders/ship/preview", { method: "POST", headers: headers(), body: JSON.stringify({ orderIds: selectedIds, force }) });
      const data = (await res.json()) as Preview & { error?: string };
      if (!res.ok) return setError(data.error ?? "미리보기 실패");
      setPreview(data);
    } catch {
      setError("미리보기 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, [session?.access_token, headers, selectedIds, force]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  const handleApply = async () => {
    setRunning(true);
    setError("");
    try {
      const res = await fetch("/api/marketplace-api/orders/ship/apply", { method: "POST", headers: headers(), body: JSON.stringify({ orderIds: selectedIds, force }) });
      const data = (await res.json()) as { results?: ShipResult[]; error?: string };
      if (!res.ok) return setError(data.error ?? "송장 전송 실패");
      setResults(data.results ?? []);
      onDone();
    } catch {
      setError("송장 전송 중 오류가 발생했습니다.");
    } finally {
      setRunning(false);
    }
  };

  const readyTotal = PLATFORMS.reduce((n, p) => n + (preview?.[p]?.ready.length ?? 0), 0);
  const skippedTotal = PLATFORMS.reduce((n, p) => n + (preview?.[p]?.skipped.length ?? 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2"><Send className="w-5 h-5 text-blue-400" /> 송장 전송 (API)</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {selectedIds.length > 0 ? `선택한 ${selectedIds.length}건 중` : "미전송 전체 중"} 쿠팡·스마트스토어 판매분의 운송장을 마켓에 발송처리합니다. ESM(지마켓·옥션·11번가)은 3시간마다 바탕화면 ESM운송장 폴더에 엑셀로 저장됩니다.
              {preview?.dryRun && <span className="ml-2 text-amber-400 inline-flex items-center gap-1"><FlaskConical className="w-3 h-3" />DRY RUN — 실제 전송 안 함</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && <div className="flex items-center gap-2 text-sm text-red-400"><AlertCircle className="w-4 h-4" />{error}</div>}

          {!results && (
            <>
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={loading || running} />
                  이미 전송한 건도 다시 보내기 (송장 수정)
                </label>
                <button onClick={handleApply} disabled={loading || running || readyTotal === 0} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50">
                  {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {readyTotal}건 전송
                </button>
              </div>

              {loading ? (
                <p className="text-sm text-[var(--text-muted)] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> 대상을 확인하는 중...</p>
              ) : preview && (
                <>
                  {PLATFORMS.map((p) => {
                    const pv = preview[p];
                    if (!pv) return null;
                    return (
                      <section key={p} className="space-y-2">
                        <h3 className="text-sm font-medium text-[var(--text-primary)]">
                          {LABEL[p]} — 전송 대상 {pv.ready.length}건
                          {!pv.hasCredential && <span className="ml-2 text-xs text-red-400">API 계정 없음 (설정에서 등록)</span>}
                        </h3>
                        {pv.ready.length > 0 && (
                          <div className="max-h-48 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                            {pv.ready.map((o) => (
                              <div key={o.id} className="px-3 py-1.5 text-sm flex justify-between gap-3">
                                <span className="truncate">{o.recipient_name} · {o.product_name} ×{o.quantity}</span>
                                <span className="text-[var(--text-muted)] shrink-0 font-mono text-xs">{o.courier} {o.tracking_no}{o.shipped_to_marketplace_at ? " (재전송)" : ""}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {pv.skipped.length > 0 && (
                          <details className="text-xs">
                            <summary className="cursor-pointer text-[var(--text-muted)]">제외 {pv.skipped.length}건 (사유 보기)</summary>
                            <div className="mt-1 max-h-40 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                              {pv.skipped.map((o) => (
                                <div key={o.id} className="px-3 py-1.5 flex justify-between gap-3">
                                  <span className="truncate">{o.recipient_name} · {o.product_name}</span>
                                  <span className="text-amber-400 shrink-0">{o.reason}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </section>
                    );
                  })}
                  {readyTotal === 0 && skippedTotal === 0 && <p className="text-sm text-[var(--text-muted)]">전송할 운송장이 없습니다. (운송장이 있고 아직 마켓에 보내지 않은 쿠팡·스마트스토어 주문이 대상)</p>}
                </>
              )}
            </>
          )}

          {results && (
            <section className="space-y-3">
              {results.map((r) => (
                <div key={r.platform} className="space-y-2">
                  <h3 className="text-sm font-medium text-[var(--text-primary)]">
                    {LABEL[r.platform]} — 전송 {r.sent}{r.alreadySent ? ` · 이미 전송 ${r.alreadySent}` : ""} · 실패 {r.failed}{r.dryRun ? " [DRY]" : ""}
                  </h3>
                  {r.rows.length > 0 && (
                    <div className="max-h-56 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                      {r.rows.map((row) => (
                        <div key={row.orderId} className="flex items-start gap-2 px-3 py-1.5 text-sm">
                          {row.status === "failed" ? <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" /> : row.status === "dry" ? <FlaskConical className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" /> : <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />}
                          <span className="truncate">{row.recipientName} · {row.productName} <span className="text-[var(--text-muted)]">— {row.message}</span></span>
                        </div>
                      ))}
                    </div>
                  )}
                  {r.errors.map((e, i) => <p key={i} className="text-xs text-red-400">{e}</p>)}
                </div>
              ))}
              <div className="flex justify-end">
                <button onClick={onClose} className="px-4 py-2 text-sm bg-[var(--bg-hover)] rounded-lg">닫기</button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
