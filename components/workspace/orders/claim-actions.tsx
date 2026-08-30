"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle, FlaskConical, Loader2, RotateCcw } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { COURIERS } from "@/lib/constants";
import type { Order } from "@/types/database";

type ClaimAction = "return-receive" | "return-complete" | "return-reject" | "exchange-collect" | "exchange-ship" | "exchange-reject";

interface Props {
  order: Order;
  /** 처리 후 목록 새로고침 */
  onDone?: () => void;
}

const CLAIM_STATUS_LABEL: Record<string, string> = {
  // 쿠팡 반품 receiptStatus
  RELEASE_STOP_UNCHECKED: "출고중지요청",
  RETURNS_UNCHECKED: "반품 접수 (입고 전)",
  VENDOR_WAREHOUSE_CONFIRM: "입고 확인됨 (환불 대기)",
  REQUEST_COUPANG_CHECK: "쿠팡 확인 요청",
  RETURNS_COMPLETED: "반품 완료",
  // 쿠팡 교환
  RECEIPT: "교환 접수",
  PROGRESS: "교환 진행 중",
  SUCCESS: "교환 완료",
  // 스토어
  CANCEL_REQUEST: "취소 요청",
  CANCEL_DONE: "취소 완료",
  RETURN_REQUEST: "반품 요청",
  COLLECTING: "수거 중",
  COLLECT_DONE: "수거 완료",
  RETURN_DONE: "반품 완료",
  EXCHANGE_REQUEST: "교환 요청",
  EXCHANGE_REDELIVERING: "교환 재배송 중",
  EXCHANGE_DONE: "교환 완료",
  // 우리 쪽
  RETURN_RECEIVED: "입고 확인함",
  RETURN_REJECTED: "반품 거절함",
  EXCHANGE_COLLECTED: "수거 확인함",
  EXCHANGE_REJECTED: "교환 거절함",
  REJECTED: "취소 거절(발송)",
  APPROVED: "취소 승인",
};

function labelOf(cs: string | null | undefined) {
  if (!cs) return "-";
  const key = cs.split("/")[0];
  return CLAIM_STATUS_LABEL[key] ?? cs;
}

export default function ClaimActions({ order, onDone }: Props) {
  const { session } = useAuth();
  const [busy, setBusy] = useState<ClaimAction | null>(null);
  const [result, setResult] = useState<{ status: "success" | "failed" | "dry"; message: string } | null>(null);
  const [reason, setReason] = useState("");
  const [courier, setCourier] = useState(order.courier ?? COURIERS[0]);
  const [trackingNo, setTrackingNo] = useState("");
  const [rejectCode, setRejectCode] = useState<"SOLDOUT" | "WITHDRAW">("WITHDRAW");

  const status = order.delivery_status;
  const isReturn = status === "반품준비";
  const isExchange = status === "교환준비";
  const isMarket = !!order.marketplace_product_order_no && ((order.marketplace ?? "").includes("쿠팡") || (order.marketplace ?? "").includes("스마트스토어"));
  if (!isMarket || (!isReturn && !isExchange)) return null;
  const isCoupang = (order.marketplace ?? "").includes("쿠팡");

  const run = async (action: ClaimAction, label: string) => {
    if (!session?.access_token) return;
    if (!confirm(`${label} 처리합니다. 마켓에 반영되며 되돌리기 어렵습니다. 계속할까요?`)) return;
    setBusy(action);
    setResult(null);
    try {
      const res = await fetch("/api/marketplace-api/orders/claims/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action, orderIds: [order.id], payload: { reason, courier, trackingNo, rejectCode } }),
      });
      const data = (await res.json()) as { results?: Array<{ status: "success" | "failed" | "dry"; message: string }>; error?: string };
      if (!res.ok) return setResult({ status: "failed", message: data.error ?? "실패" });
      const r = data.results?.[0];
      setResult(r ?? { status: "failed", message: "결과 없음" });
      if (r && r.status !== "failed") onDone?.();
    } catch {
      setResult({ status: "failed", message: "요청 중 오류" });
    } finally {
      setBusy(null);
    }
  };

  const Btn = ({ action, label, danger }: { action: ClaimAction; label: string; danger?: boolean }) => (
    <button
      onClick={() => run(action, label)}
      disabled={busy !== null}
      className={`px-2.5 py-1.5 text-xs rounded-lg disabled:opacity-50 ${danger ? "bg-red-600/20 text-red-400 hover:bg-red-600/30" : "bg-blue-600/20 text-blue-400 hover:bg-blue-600/30"}`}
    >
      {busy === action ? <Loader2 className="w-3 h-3 animate-spin inline" /> : label}
    </button>
  );

  return (
    <div className="px-5 py-3 border-b border-[var(--border)] shrink-0 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-[var(--text-tertiary)] flex items-center gap-1.5"><RotateCcw className="w-3.5 h-3.5" /> {isReturn ? "반품" : "교환"} 처리 (마켓 API)</h3>
        <span className="text-[10px] text-amber-400">{labelOf(order.claim_status)}</span>
      </div>

      {isReturn && (
        <div className="flex flex-wrap gap-1.5">
          {isCoupang && <Btn action="return-receive" label="입고 확인" />}
          <Btn action="return-complete" label="반품 완료(환불)" />
          {!isCoupang && <Btn action="return-reject" label="반품 거절" danger />}
        </div>
      )}
      {isExchange && (
        <div className="flex flex-wrap gap-1.5">
          <Btn action="exchange-collect" label="수거 완료" />
          <Btn action="exchange-ship" label="재배송 송장 등록" />
          <Btn action="exchange-reject" label="교환 거절" danger />
        </div>
      )}

      {isExchange && (
        <div className="flex gap-1.5">
          <select value={courier} onChange={(e) => setCourier(e.target.value)} className="text-xs bg-[var(--bg-input)] border border-[var(--border)] rounded px-1.5 py-1">
            {COURIERS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} placeholder="재배송 운송장" className="flex-1 text-xs bg-[var(--bg-input)] border border-[var(--border)] rounded px-2 py-1" />
        </div>
      )}
      {!isCoupang && (
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="거절 사유 (거절 시 필수)" className="w-full text-xs bg-[var(--bg-input)] border border-[var(--border)] rounded px-2 py-1" />
      )}
      {isCoupang && isExchange && (
        <select value={rejectCode} onChange={(e) => setRejectCode(e.target.value as "SOLDOUT" | "WITHDRAW")} className="text-xs bg-[var(--bg-input)] border border-[var(--border)] rounded px-1.5 py-1">
          <option value="WITHDRAW">거절 사유: 고객 철회</option>
          <option value="SOLDOUT">거절 사유: 품절</option>
        </select>
      )}
      <p className="text-[10px] text-[var(--text-muted)]">
        {isCoupang
          ? isReturn ? "쿠팡: 입고 확인 → 반품 완료(환불) 순서. 거절은 윙에서만 가능." : "쿠팡: 수거 완료 → 재배송 송장 등록. 거절은 사유 코드 선택."
          : isReturn ? "스토어: 수거는 택배 연동으로 자동. 반품 완료(환불) 또는 거절." : "스토어: 수거 완료 → 재배송 송장 등록. 거절은 사유 입력."}
      </p>
      {result && (
        <div className={`flex items-start gap-1.5 text-xs ${result.status === "failed" ? "text-red-400" : "text-green-400"}`}>
          {result.status === "failed" ? <AlertCircle className="w-3.5 h-3.5 mt-0.5" /> : result.status === "dry" ? <FlaskConical className="w-3.5 h-3.5 mt-0.5 text-amber-400" /> : <CheckCircle className="w-3.5 h-3.5 mt-0.5" />}
          <span>{result.message}</span>
        </div>
      )}
    </div>
  );
}
