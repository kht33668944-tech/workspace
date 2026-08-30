"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Ban, CheckCircle, FlaskConical, Loader2, RefreshCw, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { MarketplaceApiCredential } from "@/types/database";

type Platform = "coupang" | "smartstore";

interface OrderRow {
  id: string;
  bundle_no: string | null;
  order_date: string | null;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number;
}
interface RemoteOrder {
  orderId: string;
  productOrderId: string;
  status: string;
  recipientName: string;
  productName: string;
  quantity: number;
  orderedAt: string;
}
interface Match { order: OrderRow; remote: RemoteOrder }
interface Skip { order: OrderRow; reason: string }
interface ResultRow {
  orderId: string;
  bundleNo: string | null;
  recipientName: string | null;
  productName: string | null;
  remoteOrderId: string;
  status: "success" | "failed" | "dry";
  message: string;
}

interface Props {
  onClose: () => void;
  onDone: () => void;
}

const PLATFORM_LABEL: Record<Platform, string> = { coupang: "쿠팡", smartstore: "스마트스토어" };
const STATUS_LABEL: Record<string, string> = {
  ACCEPT: "결제완료",
  INSTRUCT: "상품준비중",
  PAYED: "결제완료",
  DELIVERING: "배송중",
};

export default function MarketplaceCancelModal({ onClose, onDone }: Props) {
  const { session } = useAuth();
  const [platform, setPlatform] = useState<Platform>("coupang");
  const [credentials, setCredentials] = useState<MarketplaceApiCredential[]>([]);
  const [credentialId, setCredentialId] = useState("");
  const [wingUserId, setWingUserId] = useState("");
  const [detailedReason, setDetailedReason] = useState("배송 장기 지연으로 판매자 취소 처리합니다. 불편을 드려 죄송합니다.");
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [matched, setMatched] = useState<Match[]>([]);
  const [skipped, setSkipped] = useState<Skip[]>([]);
  const [remoteCount, setRemoteCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ResultRow[]>([]);
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState("");

  const headers = useCallback(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` }),
    [session?.access_token],
  );

  useEffect(() => {
    if (!session?.access_token) return;
    (async () => {
      try {
        const res = await fetch("/api/marketplace-api/credentials", { headers: { Authorization: `Bearer ${session.access_token}` } });
        const data = (await res.json()) as MarketplaceApiCredential[];
        setCredentials(Array.isArray(data) ? data : []);
      } catch {
        setError("API 계정 목록을 불러오지 못했습니다.");
      }
    })();
  }, [session?.access_token]);

  const platformCredentials = useMemo(() => credentials.filter((c) => c.platform === platform), [credentials, platform]);
  useEffect(() => {
    setCredentialId(platformCredentials[0]?.id ?? "");
    setMatched([]);
    setSkipped([]);
    setResults([]);
    setSelected(new Set());
    setRemoteCount(null);
    setError("");
    if (platform === "coupang") {
      try {
        setWingUserId(localStorage.getItem("wing_user_id") ?? "");
      } catch { /* ignore */ }
    }
  }, [platform, platformCredentials]);

  const handlePreview = async () => {
    if (!credentialId) return setError(`${PLATFORM_LABEL[platform]} API 계정을 설정에서 먼저 등록하세요.`);
    setPreviewing(true);
    setError("");
    setResults([]);
    try {
      const res = await fetch("/api/marketplace-api/orders/cancel/preview", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ platform, credentialId }),
      });
      const data = (await res.json()) as { matched?: Match[]; skipped?: Skip[]; remoteCount?: number; dryRun?: boolean; error?: string };
      if (!res.ok) return setError(data.error ?? "미리보기 실패");
      setMatched(data.matched ?? []);
      setSkipped(data.skipped ?? []);
      setRemoteCount(data.remoteCount ?? 0);
      setDryRun(!!data.dryRun);
      setSelected(new Set((data.matched ?? []).map((m) => m.order.id)));
    } catch {
      setError("미리보기 중 오류가 발생했습니다.");
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (selected.size === 0) return setError("실행할 주문을 선택하세요.");
    if (platform === "coupang" && !wingUserId.trim()) return setError("쿠팡윙 로그인 ID를 입력하세요.");
    const warn = platform === "coupang"
      ? "쿠팡 판매자 취소는 되돌릴 수 없고 판매자 귀책(배송준수율)으로 기록됩니다."
      : "스마트스토어 판매자 취소는 되돌릴 수 없고 즉시 환불이 진행되며 페널티가 부과될 수 있습니다.";
    if (!confirm(`${PLATFORM_LABEL[platform]} 주문 ${selected.size}건을 실제로 취소합니다.\n${warn}\n계속하시겠습니까?`)) return;

    setApplying(true);
    setError("");
    try {
      if (platform === "coupang") {
        try { localStorage.setItem("wing_user_id", wingUserId.trim()); } catch { /* ignore */ }
      }
      const res = await fetch("/api/marketplace-api/orders/cancel/apply", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ platform, credentialId, orderIds: [...selected], wingUserId: wingUserId.trim(), detailedReason }),
      });
      const data = (await res.json()) as { results?: ResultRow[]; dryRun?: boolean; error?: string };
      if (!res.ok) return setError(data.error ?? "취소 실행 실패");
      setResults(data.results ?? []);
      setDryRun(!!data.dryRun);
      onDone();
    } catch {
      setError("취소 실행 중 오류가 발생했습니다.");
    } finally {
      setApplying(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const successCount = results.filter((r) => r.status !== "failed").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={() => !applying && onClose()} />
      <div className="relative w-full max-w-5xl max-h-[92vh] overflow-hidden bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Ban className="w-4 h-4 text-red-400" />
              마켓 주문 취소 (API)
              {dryRun && <span className="px-2 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400 flex items-center gap-1"><FlaskConical className="w-3 h-3" />DRY RUN</span>}
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-1">발주서의 &quot;취소준비&quot; 건을 마켓 주문과 대조한 뒤, 확인한 건만 판매자 취소합니다. 성공 건은 취소완료로 바뀝니다.</p>
          </div>
          <button onClick={onClose} disabled={applying} className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">판매처</label>
              <div className="grid grid-cols-2 gap-1 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg p-1 min-h-[44px]">
                {(["coupang", "smartstore"] as Platform[]).map((p) => (
                  <button key={p} onClick={() => setPlatform(p)} disabled={applying || previewing} className={`text-sm rounded-md ${platform === p ? "bg-red-600 text-white" : "text-[var(--text-secondary)] hover:bg-[var(--bg-card)]"}`}>
                    {PLATFORM_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">API 계정</label>
              <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)} className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none">
                {platformCredentials.length === 0 ? <option value="">설정에서 등록 필요</option> : platformCredentials.map((c) => <option key={c.id} value={c.id}>{c.label || c.account_id}</option>)}
              </select>
            </div>
            {platform === "coupang" ? (
              <div>
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">쿠팡윙 로그인 ID</label>
                <input value={wingUserId} onChange={(e) => setWingUserId(e.target.value)} placeholder="취소 API 필수값" className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none" />
              </div>
            ) : (
              <div>
                <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">취소 상세사유 (구매자에게 노출)</label>
                <input value={detailedReason} onChange={(e) => setDetailedReason(e.target.value)} className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none" />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handlePreview} disabled={previewing || applying} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg disabled:opacity-50">
              {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {previewing ? "마켓 주문 대조 중..." : "대조 (미리보기)"}
            </button>
            <button onClick={handleApply} disabled={applying || previewing || selected.size === 0} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50">
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
              선택 {selected.size}건 취소 실행
            </button>
            {remoteCount != null && <span className="text-xs text-[var(--text-muted)]">마켓 최근 주문 {remoteCount}건 조회 · 매칭 {matched.length} · 제외 {skipped.length}</span>}
          </div>

          {matched.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">매칭된 주문 (체크한 건만 실행)</h3>
              <div className="max-h-72 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                {matched.map(({ order, remote }) => (
                  <label key={order.id} className="grid grid-cols-[28px_1fr_1fr_90px] gap-2 px-3 py-2 text-sm items-center cursor-pointer hover:bg-[var(--bg-hover)]">
                    <input type="checkbox" checked={selected.has(order.id)} onChange={() => toggle(order.id)} disabled={applying} />
                    <div className="min-w-0">
                      <p className="text-[var(--text-primary)] truncate">{order.recipient_name} · {order.product_name}</p>
                      <p className="text-xs text-[var(--text-muted)]">발주서 {order.bundle_no ?? "-"} · 수량 {order.quantity}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[var(--text-secondary)] truncate">{remote.recipientName} · {remote.productName}</p>
                      <p className="text-xs text-[var(--text-muted)]">마켓 {remote.orderId} · {remote.orderedAt?.slice(0, 10)}</p>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-hover)] text-center">{STATUS_LABEL[remote.status] ?? remote.status}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {skipped.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-orange-400 mb-2">제외된 발주서 (수동 처리 필요)</h3>
              <div className="max-h-44 overflow-y-auto border border-orange-500/20 rounded-lg divide-y divide-orange-500/10">
                {skipped.map(({ order, reason }) => (
                  <div key={order.id} className="px-3 py-2 text-sm">
                    <span className="text-[var(--text-primary)]">{order.recipient_name} · {order.product_name}</span>
                    <span className="text-[var(--text-muted)]"> · {reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {results.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">실행 결과 — 성공 {successCount} / 실패 {results.length - successCount}</h3>
              <div className="max-h-64 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                {results.map((r) => (
                  <div key={r.orderId} className="flex items-start gap-2 px-3 py-2 text-sm">
                    {r.status === "failed" ? <AlertCircle className="w-4 h-4 text-red-400 mt-0.5" /> : r.status === "dry" ? <FlaskConical className="w-4 h-4 text-amber-400 mt-0.5" /> : <CheckCircle className="w-4 h-4 text-green-400 mt-0.5" />}
                    <div className="min-w-0">
                      <p className="text-[var(--text-primary)] truncate">{r.recipientName} · {r.productName}</p>
                      <p className="text-xs text-[var(--text-muted)]">마켓 {r.remoteOrderId} · {r.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {remoteCount === 0 && matched.length === 0 && skipped.length === 0 && !previewing && (
            <p className="text-sm text-[var(--text-muted)]">&quot;취소준비&quot; 상태의 {PLATFORM_LABEL[platform]} 주문이 없습니다.</p>
          )}
        </div>
      </div>
    </div>
  );
}
