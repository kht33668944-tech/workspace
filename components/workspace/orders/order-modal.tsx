"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { COURIERS, PAYMENT_METHODS } from "@/lib/constants";
import type { OrderInsert } from "@/types/database";

interface OrderModalProps {
  onSave: (order: OrderInsert) => Promise<{ error: string | null }>;
  onClose: () => void;
}

const FIELDS: { key: string; label: string; type?: string; placeholder?: string }[] = [
  { key: "bundle_no", label: "묶음번호" },
  { key: "order_date", label: "주문일시", type: "date" },
  { key: "marketplace", label: "판매처", placeholder: "예: 쿠팡, 스마트스토어" },
  { key: "recipient_name", label: "수취인명" },
  { key: "product_name", label: "상품명" },
  { key: "quantity", label: "수량", type: "number" },
  { key: "recipient_phone", label: "수령자번호" },
  { key: "orderer_phone", label: "주문자번호" },
  { key: "postal_code", label: "우편번호" },
  { key: "address", label: "주소" },
  { key: "delivery_memo", label: "배송메모" },
  { key: "revenue", label: "매출", type: "number" },
  { key: "settlement", label: "정산예정", type: "number" },
  { key: "cost", label: "원가", type: "number" },
  { key: "payment_method", label: "결제방식", type: "select" },
  { key: "purchase_id", label: "구매 아이디" },
  { key: "purchase_source", label: "구매처", placeholder: "예: 지마켓, 옥션" },
  { key: "purchase_order_no", label: "주문번호" },
  { key: "courier", label: "택배사", type: "select" },
  { key: "tracking_no", label: "운송장번호" },
  { key: "memo", label: "메모" },
];

export default function OrderModal({ onSave, onClose }: OrderModalProps) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);

    const order: OrderInsert = {
      user_id: "",
      bundle_no: form.bundle_no || null,
      order_date: form.order_date ? new Date(form.order_date).toISOString() : null,
      marketplace: form.marketplace || null,
      recipient_name: form.recipient_name || null,
      product_name: form.product_name || null,
      quantity: parseInt(form.quantity) || 1,
      recipient_phone: form.recipient_phone || null,
      orderer_phone: form.orderer_phone || null,
      postal_code: form.postal_code || null,
      address: form.address || null,
      delivery_memo: form.delivery_memo || null,
      revenue: parseInt(form.revenue) || 0,
      settlement: parseInt(form.settlement) || 0,
      cost: parseInt(form.cost) || 0,
      payment_method: form.payment_method || null,
      purchase_id: form.purchase_id || null,
      purchase_source: form.purchase_source || null,
      purchase_order_no: form.purchase_order_no || null,
      courier: form.courier || null,
      tracking_no: form.tracking_no || null,
      memo: form.memo || null,
    };

    const { error } = await onSave(order);
    if (error) {
      setError(error);
      setSaving(false);
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 bg-[#1e1e2e] border border-white/10 rounded-2xl shadow-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <h2 className="text-lg font-semibold text-white">주문 수동 추가</h2>
          <button onClick={onClose} className="p-1 text-white/40 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <div className="p-6 overflow-y-auto space-y-3">
          {FIELDS.map((field) => (
            <div key={field.key} className="flex items-center gap-3">
              <label className="w-24 text-xs text-white/50 shrink-0 text-right">{field.label}</label>
              {field.type === "select" ? (
                <select
                  value={form[field.key] || ""}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500/50"
                >
                  <option value="">선택</option>
                  {(field.key === "courier" ? COURIERS : PAYMENT_METHODS).map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type || "text"}
                  value={form[field.key] || ""}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500/50 placeholder:text-white/20"
                />
              )}
            </div>
          ))}
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/10 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-white/60 hover:text-white">
            취소
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
          >
            {saving ? "저장 중..." : "추가"}
          </button>
        </div>
      </div>
    </div>
  );
}
