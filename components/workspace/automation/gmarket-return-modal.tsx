"use client";

// 지마켓 반품 자동화 실행 모달 — 미리보기(대상·사유 매핑) → 드라이런/실행 → 진행 로그·결과
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";

interface PreviewTarget {
  orderId: string;
  recipientName: string | null;
  productName: string | null;
  quantity: number | null;
  deliveryStatus: string;
  claimReason: string | null;
  mappedReason: string;
  detailText: string;
  needRepurchase: boolean;
  claimQuantity?: number | null;   // 마켓 반품 요청 수량 (부분 반품)
  orderNos?: string[];              // 이번에 신청할 구매처 주문번호들 (수량 N개 자동구매 = N건)
  entryCount?: number;
  bundleQuantities?: number[];      // 묶음구매 엔트리(수량 2 이상)
  alreadyRequested?: number;        // 앞선 실행에서 이미 신청된 주문 수
}

interface RunResultRow {
  orderId: string;
  recipientName: string | null;
  productName: string | null;
  ok: boolean;
  selectedReason: string;
  returnFee: string | null;
  error?: string;
  needRepurchase: boolean;
  orderNos?: string[];
  entryCount?: number;
  requestedCount?: number;
  hasContactField?: boolean;
  sms?: { status: "sent" | "skipped" | "failed"; message: string; phone?: string };
}

const API = "/api/marketplace-api/returns/gmarket";

export default function GmarketReturnModal({ open, onClose, onRefetch, orderIds }: {
  open: boolean;
  onClose: () => void;
  onRefetch: () => Promise<void>;
  /** 주면 이 주문들만 대상 (발주서에서 선택). 없으면 전체 반품준비 지마켓 건 (자동화 페이지) */
  orderIds?: string[];
}) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [targets, setTargets] = useState<PreviewTarget[]>([]);
  const [running, setRunning] = useState<"dry" | "run" | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [results, setResults] = useState<RunResultRow[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadPreview = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setResults(null);
    setLog([]);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ mode: "preview", ...(orderIds ? { orderIds } : {}) }),
      });
      const json = (await res.json()) as { targets?: PreviewTarget[]; error?: string };
      if (!res.ok) { setPreviewError(json.error ?? "대상 조회 실패"); return; }
      setPreviewError(null);
      setTargets(json.targets ?? []);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "대상 조회 실패");
    } finally { setLoading(false); }
  }, [session?.access_token, orderIds]);

  useEffect(() => { if (open) void loadPreview(); }, [open, loadPreview]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const execute = async (mode: "dry" | "run") => {
    if (!session?.access_token || running) return;
    if (mode === "run" && !confirm(`지마켓에 실제로 반품신청 ${targets.length}건을 접수합니다. 진행할까요?`)) return;
    setRunning(mode);
    setResults(null);
    setLog([mode === "dry" ? "드라이런 시작 — 신청 직전까지만 진행합니다" : "반품신청 시작"]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ mode, ...(orderIds ? { orderIds } : {}) }),
        signal: controller.signal,
      });
      if (!res.body || (res.headers.get("content-type") || "").includes("application/json")) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        showToast(json.error ?? "실행 실패", "error");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const e = JSON.parse(line.slice(6)) as { type: string; message?: string; index?: number; total?: number; results?: RunResultRow[]; successCount?: number; failCount?: number };
              if (e.type === "progress" && e.message) setLog((prev) => [...prev.slice(-100), `[${e.index}/${e.total}] ${e.message}`]);
              if (e.type === "error" && e.message) setLog((prev) => [...prev, `오류: ${e.message}`]);
              if (e.type === "done") {
                setResults(e.results ?? []);
                setLog((prev) => [...prev, `완료 — 성공 ${e.successCount ?? 0} / 실패 ${e.failCount ?? 0}${mode === "dry" ? " (드라이런)" : ""}`]);
              }
            } catch { /* 부분 청크 무시 */ }
          }
        }
      }
      if (mode === "run") setTimeout(() => { void onRefetch(); void loadPreview(); }, 1500);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        showToast(e instanceof Error ? e.message : "실행 실패", "error");
      }
    } finally {
      setRunning(null);
      abortRef.current = null;
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <h3 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <RotateCcw className="w-4 h-4" /> 지마켓 반품 자동화
          </h3>
          <button onClick={() => { abortRef.current?.abort(); onClose(); }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-3 text-sm">
          {loading ? (
            <div className="flex items-center gap-2 text-[var(--text-muted)] py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> 대상 조회 중...
            </div>
          ) : previewError ? (
            <p className="text-red-400 py-6 text-center whitespace-pre-wrap">{previewError}</p>
          ) : targets.length === 0 ? (
            <p className="text-[var(--text-muted)] py-6 text-center">
              {orderIds ? "선택한 주문 중 지마켓 반품 대상이 없습니다." : "반품신청 대상이 없습니다."}
              <br /><span className="text-xs">(반품준비·교환준비 + 지마켓 구매건 + 아직 반품신청 안 한 건만)</span>
            </p>
          ) : (
            <div className="border border-[var(--border)] rounded-lg overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="text-left p-2">수취인 / 상품</th>
                    <th className="text-left p-2">상태</th>
                    <th className="text-left p-2">고객 사유 → 지마켓 사유</th>
                  </tr>
                </thead>
                <tbody>
                  {targets.map((t) => (
                    <tr key={t.orderId} className="border-b border-[var(--border)] last:border-0">
                      <td className="p-2 text-[var(--text-primary)]">
                        {t.recipientName ?? "?"} · {t.productName ?? "?"} ×{t.quantity ?? 1}
                        {t.claimQuantity != null && t.claimQuantity < (t.quantity ?? 1) && <span className="ml-1 text-sky-400">(요청 {t.claimQuantity}개)</span>}
                        {(t.entryCount ?? 1) > 1 && <span className="ml-1 text-[var(--text-secondary)]">주문 {t.entryCount}건</span>}
                        {(t.bundleQuantities?.length ?? 0) > 0 && <span className="ml-1 text-amber-400">(묶음 {t.bundleQuantities!.join("/")}개 — 수량 선택 확인)</span>}
                        {(t.alreadyRequested ?? 0) > 0 && <span className="ml-1 text-[var(--text-secondary)]">(이미 {t.alreadyRequested}건 신청됨)</span>}
                        {t.needRepurchase && <span className="ml-1 text-amber-400">(교환 — 재구매 필요)</span>}
                        {t.orderNos && t.orderNos.length > 0 && <div className="font-mono text-[10px] text-[var(--text-secondary)]">{t.orderNos.join(", ")}</div>}
                      </td>
                      <td className="p-2 text-[var(--text-secondary)]">{t.deliveryStatus}</td>
                      <td className="p-2 text-[var(--text-secondary)]">
                        {t.claimReason ? `"${t.claimReason}"` : "(사유 없음)"} → <b className="text-[var(--text-primary)]">{t.mappedReason}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {log.length > 0 && (
            <pre className="bg-[var(--bg-tertiary)] rounded-lg p-3 text-xs text-[var(--text-secondary)] whitespace-pre-wrap max-h-48 overflow-y-auto">
              {log.join("\n")}
            </pre>
          )}

          {results && results.length > 0 && (
            <div className="space-y-1">
              {results.map((r) => (
                <p key={r.orderId} className={`text-xs ${r.ok ? "text-emerald-400" : "text-red-400"}`}>
                  {r.ok ? "✓" : "✗"} {r.recipientName ?? "?"} · {r.productName ?? "?"}{(r.entryCount ?? 1) > 1 ? ` [주문 ${r.entryCount}건]` : ""} — {r.ok ? `${r.selectedReason}${r.returnFee ? ` (반품비 ${r.returnFee} 환불차감)` : ""}` : `${r.error}${(r.requestedCount ?? 0) > 0 ? ` (${r.requestedCount}/${r.entryCount}건 신청됨)` : ""}`}
                  {r.ok && r.needRepurchase && <span className="text-amber-400"> · 재구매 필요</span>}
                  {r.hasContactField && <span className="text-sky-400"> · 수거지 연락처 입력칸 있음</span>}
                  {r.sms?.status === "sent" && <span className="text-emerald-400"> · 안내 문자 발송{r.sms.phone ? ` (${r.sms.phone})` : ""}</span>}
                  {r.sms?.status === "failed" && <span className="text-amber-400"> · 안내 문자 실패: {r.sms.message}</span>}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-[var(--border)]">
          <button onClick={() => void execute("dry")} disabled={loading || running !== null || targets.length === 0}
            className="px-3 py-2 text-sm rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-40">
            {running === "dry" ? <Loader2 className="w-4 h-4 animate-spin" /> : "드라이런 (신청 직전까지)"}
          </button>
          <button onClick={() => void execute("run")} disabled={loading || running !== null || targets.length === 0}
            className="px-3 py-2 text-sm rounded-lg bg-green-600 text-white disabled:opacity-40">
            {running === "run" ? <Loader2 className="w-4 h-4 animate-spin" /> : `${targets.length}건 반품신청 실행`}
          </button>
        </div>
      </div>
    </div>
  );
}
