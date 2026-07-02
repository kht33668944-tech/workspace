"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle, Loader2, PlugZap, RefreshCw, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { MarketplaceApiAction, MarketplaceApiCredential } from "@/types/database";

interface CoupangPreviewItem {
  productId: string;
  productName: string;
  vendorItemId: string;
  optionId: string | null;
  optionName: string | null;
  previousValue: string | null;
  newValue: string | null;
  action: MarketplaceApiAction;
}

interface CoupangBlockedItem {
  productId: string | null;
  productName: string;
  reason: string;
}

interface ApplyResult {
  productId: string;
  productName: string;
  vendorItemId: string;
  status: "success" | "failed";
  message: string;
  previousValue: string | null;
  newValue: string | null;
}

interface Props {
  productIds: string[];
  onClose: () => void;
}

const ACTION_LABELS: Record<MarketplaceApiAction, string> = {
  test: "연결확인",
  price: "가격 반영",
  stock: "재고 반영",
  stop: "판매중지",
  resume: "판매재개",
};

const ACTIONS: MarketplaceApiAction[] = ["price", "stock", "stop", "resume"];

export default function CoupangApiModal({ productIds, onClose }: Props) {
  const { session } = useAuth();
  const [credentials, setCredentials] = useState<MarketplaceApiCredential[]>([]);
  const [credentialId, setCredentialId] = useState("");
  const [action, setAction] = useState<MarketplaceApiAction>("price");
  const [stockQuantity, setStockQuantity] = useState<string>("");
  const [loadingCredentials, setLoadingCredentials] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [items, setItems] = useState<CoupangPreviewItem[]>([]);
  const [blocked, setBlocked] = useState<CoupangBlockedItem[]>([]);
  const [results, setResults] = useState<ApplyResult[]>([]);
  const [error, setError] = useState("");

  const successCount = useMemo(() => results.filter((r) => r.status === "success").length, [results]);
  const failCount = results.length - successCount;

  const fetchCredentials = useCallback(async () => {
    if (!session?.access_token) return;
    setLoadingCredentials(true);
    try {
      const res = await fetch("/api/marketplace-api/credentials", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json() as MarketplaceApiCredential[];
      const coupang = Array.isArray(data) ? data.filter((c) => c.platform === "coupang") : [];
      setCredentials(coupang);
      if (coupang[0]) setCredentialId(coupang[0].id);
    } catch {
      setError("쿠팡 API 계정 목록을 불러오지 못했습니다.");
    } finally {
      setLoadingCredentials(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const buildBody = () => ({
    productIds,
    action,
    stockQuantity: action === "stock" && stockQuantity.trim() !== "" ? Number(stockQuantity) : null,
  });

  const handlePreview = async () => {
    setPreviewing(true);
    setError("");
    setResults([]);
    try {
      const res = await fetch("/api/marketplace-api/coupang/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json() as { items?: CoupangPreviewItem[]; blocked?: CoupangBlockedItem[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? "미리보기 생성 실패");
        return;
      }
      setItems(data.items ?? []);
      setBlocked(data.blocked ?? []);
    } catch {
      setError("미리보기 생성 중 오류가 발생했습니다.");
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (!credentialId) {
      setError("쿠팡 API 계정을 선택하세요.");
      return;
    }
    if (items.length === 0) {
      setError("반영할 항목이 없습니다. 먼저 미리보기를 실행하세요.");
      return;
    }
    const ok = confirm(`쿠팡윙에 ${items.length}개 항목을 실제 반영하시겠습니까?`);
    if (!ok) return;

    setApplying(true);
    setError("");
    setResults([]);
    try {
      const res = await fetch("/api/marketplace-api/coupang/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ credentialId, ...buildBody() }),
      });
      const data = await res.json() as { results?: ApplyResult[]; blocked?: CoupangBlockedItem[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? "쿠팡 API 반영 실패");
        return;
      }
      setResults(data.results ?? []);
      if (data.blocked) setBlocked(data.blocked);
    } catch {
      setError("쿠팡 API 반영 중 오류가 발생했습니다.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={() => !applying && onClose()} />
      <div className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <PlugZap className="w-4 h-4 text-red-400" />
              쿠팡 API 반영
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-1">선택 상품 {productIds.length}개를 미리 확인한 뒤 쿠팡윙에 직접 반영합니다.</p>
          </div>
          <button onClick={onClose} disabled={applying} className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">쿠팡 API 계정</label>
              <select
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
                disabled={loadingCredentials}
                className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none"
              >
                {credentials.length === 0 ? (
                  <option value="">설정에서 API 계정 등록 필요</option>
                ) : credentials.map((c) => (
                  <option key={c.id} value={c.id}>{c.label || c.account_id}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">작업</label>
              <div className="grid grid-cols-4 gap-1 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg p-1 min-h-[44px]">
                {ACTIONS.map((a) => (
                  <button
                    key={a}
                    onClick={() => { setAction(a); setItems([]); setResults([]); }}
                    className={`text-xs rounded-md transition-colors ${action === a ? "bg-red-600 text-white" : "text-[var(--text-secondary)] hover:bg-[var(--bg-card)]"}`}
                  >
                    {ACTION_LABELS[a]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm text-[var(--text-tertiary)] mb-1.5 block">재고 수량</label>
              <input
                type="number"
                min={0}
                value={stockQuantity}
                onChange={(e) => setStockQuantity(e.target.value)}
                disabled={action !== "stock"}
                placeholder="비우면 기존 캐시 재고 사용"
                className="w-full bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg px-3 min-h-[44px] text-sm outline-none disabled:opacity-50"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={handlePreview} disabled={previewing || applying} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg disabled:opacity-50">
              {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              미리보기
            </button>
            <button onClick={handleApply} disabled={applying || previewing || !credentialId || items.length === 0} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-50">
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
              실제 반영
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="bg-[var(--bg-hover)] rounded-lg p-3">반영 가능 <strong className="text-green-400">{items.length}</strong>건</div>
            <div className="bg-[var(--bg-hover)] rounded-lg p-3">제외 <strong className="text-orange-400">{blocked.length}</strong>건</div>
            <div className="bg-[var(--bg-hover)] rounded-lg p-3">성공 <strong className="text-green-400">{successCount}</strong>건</div>
            <div className="bg-[var(--bg-hover)] rounded-lg p-3">실패 <strong className="text-red-400">{failCount}</strong>건</div>
          </div>

          {items.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">미리보기</h3>
              <div className="max-h-72 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                {items.map((item) => (
                  <div key={`${item.vendorItemId}-${item.action}`} className="grid grid-cols-1 md:grid-cols-[1fr_130px_120px_120px] gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="text-[var(--text-primary)] truncate">{item.productName}</p>
                      <p className="text-xs text-[var(--text-muted)] truncate">옵션 {item.optionName || "-"} · {item.vendorItemId}</p>
                    </div>
                    <span className="text-[var(--text-secondary)]">{ACTION_LABELS[item.action]}</span>
                    <span className="text-[var(--text-muted)]">{item.previousValue ?? "-"}</span>
                    <span className="text-red-400 font-medium">{item.newValue ?? "-"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {blocked.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-orange-400 mb-2">제외된 항목</h3>
              <div className="max-h-44 overflow-y-auto border border-orange-500/20 rounded-lg divide-y divide-orange-500/10">
                {blocked.map((item, i) => (
                  <div key={`${item.productId ?? "none"}-${i}`} className="px-3 py-2 text-sm">
                    <span className="text-[var(--text-primary)]">{item.productName}</span>
                    <span className="text-[var(--text-muted)]"> · {item.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {results.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">반영 결과</h3>
              <div className="max-h-64 overflow-y-auto border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
                {results.map((item) => (
                  <div key={`${item.vendorItemId}-${item.status}`} className="flex items-start gap-2 px-3 py-2 text-sm">
                    {item.status === "success" ? <CheckCircle className="w-4 h-4 text-green-400 mt-0.5" /> : <AlertCircle className="w-4 h-4 text-red-400 mt-0.5" />}
                    <div className="min-w-0">
                      <p className="text-[var(--text-primary)] truncate">{item.productName}</p>
                      <p className="text-xs text-[var(--text-muted)]">{item.previousValue ?? "-"} → {item.newValue ?? "-"} · {item.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
