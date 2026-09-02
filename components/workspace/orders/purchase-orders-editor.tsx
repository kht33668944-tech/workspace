"use client";

// 발주서 사이드패널 "구매 주문" 섹션 — 구매 주문 목록(purchase_orders) 조회·추가·삭제
//  수량 N개 자동구매는 주문 N건, 수동 묶음구매는 주문 1건에 수량 N. 대표 컬럼은 첫 엔트리와 항상 맞춘다 (representativePatch)

import { useState } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { sanitizeText } from "@/lib/sanitize";
import { purchaseDetailUrl } from "@/lib/scrapers/types";
import { getPurchaseOrders, parsePurchaseOrders, representativePatch, totalQuantity, upsertEntry } from "@/lib/purchase-orders";
import type { Order, OrderUpdate, PurchaseOrderEntry } from "@/types/database";

/** 구매처명 → purchaseDetailUrl 플랫폼 키 (상세링크는 지마켓·오늘의집만 만들 수 있다) */
function platformKey(source: string | null): string {
  const s = source ?? "";
  if (s.includes("지마켓")) return "gmarket";
  if (s.includes("오늘의집")) return "ohouse";
  return "";
}

export default function PurchaseOrdersEditor({ order, onUpdate }: { order: Order; onUpdate: (id: string, updates: OrderUpdate) => void }) {
  const [orderNo, setOrderNo] = useState("");
  const [payNo, setPayNo] = useState("");
  const [qty, setQty] = useState("1");

  const entries = getPurchaseOrders(order);
  const stored = parsePurchaseOrders(order.purchase_orders);

  const save = (next: PurchaseOrderEntry[]) => {
    onUpdate(order.id, { purchase_orders: next, ...representativePatch(next) });
  };

  const handleAdd = () => {
    const no = sanitizeText(orderNo.trim());
    if (!no) return;
    const pay = sanitizeText(payNo.trim()) || null;
    const n = Math.max(parseInt(qty, 10) || 1, 1);
    const entry: PurchaseOrderEntry = {
      order_no: no,
      pay_no: pay,
      detail_url: purchaseDetailUrl(platformKey(order.purchase_source), no, pay ?? undefined),
      quantity: n,
      purchased_at: new Date().toISOString(),
      source: "manual",
    };
    save(upsertEntry(entries, entry));
    setOrderNo(""); setPayNo(""); setQty("1");
  };

  const handleRemove = (no: string) => {
    save(entries.filter((e) => e.order_no !== no));
  };

  const total = totalQuantity(entries);
  const mismatch = entries.length > 0 && order.quantity != null && total !== order.quantity;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-[var(--text-muted)] leading-none">
          구매 주문 {entries.length > 0 ? `${entries.length}건 · ${total}개` : ""}
          {stored.length === 0 && entries.length > 0 && <span className="ml-1 text-[var(--text-disabled)]">(대표값)</span>}
        </span>
        {mismatch && <span className="text-[10px] text-amber-400">주문 수량 {order.quantity}개와 다름</span>}
      </div>
      {entries.length > 0 && (
        <ul className="space-y-1 mb-2">
          {entries.map((e) => (
            <li key={e.order_no} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-[var(--text-secondary)] break-all">{e.order_no}</span>
              <span className="text-[var(--text-muted)] shrink-0">×{e.quantity}</span>
              {e.tracking_no && <span className="text-[var(--text-muted)] shrink-0 truncate" title={`${e.courier ?? ""} ${e.tracking_no}`}>{e.courier ?? ""} {e.tracking_no}</span>}
              {e.return_status === "완료" ? (
                <span className="px-1 rounded bg-emerald-500/20 text-emerald-400 shrink-0">반품완료</span>
              ) : e.return_status === "접수" || e.return_requested_at ? (
                <span className="px-1 rounded bg-sky-500/20 text-sky-400 shrink-0">반품신청</span>
              ) : null}
              {e.detail_url && (
                <a href={e.detail_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline shrink-0" title={e.detail_url} onClick={(ev) => ev.stopPropagation()}>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <button onClick={() => handleRemove(e.order_no)} className="ml-auto p-0.5 text-[var(--text-disabled)] hover:text-red-400 shrink-0" title="목록에서 삭제">
                <Trash2 className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1">
        <input
          value={orderNo}
          onChange={(e) => setOrderNo(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
          placeholder="주문번호"
          className="flex-1 min-w-0 bg-[var(--bg-hover)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-blue-500/50"
        />
        <input
          value={payNo}
          onChange={(e) => setPayNo(e.target.value)}
          placeholder="결제번호"
          title="지마켓 결제번호 — 주문상세링크를 만들 때 필요"
          className="w-24 bg-[var(--bg-hover)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-blue-500/50"
        />
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          type="number"
          min={1}
          title="이 주문에 담긴 수량 (묶음구매면 2 이상)"
          className="w-12 bg-[var(--bg-hover)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)] outline-none focus:border-blue-500/50"
        />
        <button onClick={handleAdd} disabled={!orderNo.trim()} className="p-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 text-white rounded" title="구매 주문 추가">
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
