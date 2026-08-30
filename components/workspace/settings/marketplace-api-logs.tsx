"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, History, Loader2, RefreshCw } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface LogRow {
  id: string;
  platform: string;
  action: string;
  status: "success" | "failed";
  product_name: string | null;
  vendor_item_id: string | null;
  target_id: string | null;
  previous_value: string | null;
  new_value: string | null;
  error_message: string | null;
  created_at: string;
}

const PLATFORM_LABEL: Record<string, string> = { coupang: "쿠팡", smartstore: "스마트스토어", esm: "ESM" };
const ACTION_LABEL: Record<string, string> = {
  test: "연결확인",
  sync: "상품동기화",
  price: "가격",
  stock: "재고",
  stop: "판매중지",
  resume: "판매재개",
  cancel: "주문취소",
  "sync-orders": "주문수집",
  confirm: "발주확인",
  claim: "클레임반영",
  "approve-cancel": "취소승인",
  "reject-cancel": "취소거절(발송)",
  "auto-approve-cancel": "취소 자동승인",
  ship: "송장전송",
  "ship-fix": "송장수정",
  "return-approve": "반품승인",
  "return-receive": "반품입고확인",
  "return-complete": "반품완료(환불)",
  "return-reject": "반품거절",
  "exchange-collect": "교환수거확인",
  "exchange-ship": "교환재배송",
  "exchange-reject": "교환거절",
  settlement: "정산반영",
};

function fmt(iso: string) {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function MarketplaceApiLogs() {
  const { session } = useAuth();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/marketplace-api/logs?limit=200", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = (await res.json()) as LogRow[];
      setLogs(Array.isArray(data) ? data : []);
    } catch {
      /* 표시만 실패 */
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setOpen((v) => !v)} className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <History className="w-4 h-4 text-[var(--text-muted)]" />
          마켓 API 실행 로그 {open ? "▲" : "▼"}
        </button>
        {open && (
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-[var(--bg-hover)] rounded-lg disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            새로고침
          </button>
        )}
      </div>
      {open && (
        <div className="mt-4 max-h-96 overflow-auto border border-[var(--border)] rounded-lg">
          {logs.length === 0 ? (
            <p className="p-4 text-sm text-[var(--text-muted)]">{loading ? "불러오는 중..." : "로그가 없습니다."}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--bg-hover)] text-[var(--text-tertiary)] sticky top-0">
                <tr>
                  <th className="text-left px-2 py-2">시각</th>
                  <th className="text-left px-2 py-2">판매처</th>
                  <th className="text-left px-2 py-2">작업</th>
                  <th className="text-left px-2 py-2">대상</th>
                  <th className="text-left px-2 py-2">변경</th>
                  <th className="text-left px-2 py-2">결과</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {logs.map((l) => {
                  const dry = l.action.endsWith(":dry");
                  const base = l.action.replace(":dry", "");
                  return (
                    <tr key={l.id}>
                      <td className="px-2 py-1.5 whitespace-nowrap text-[var(--text-muted)]">{fmt(l.created_at)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{PLATFORM_LABEL[l.platform] ?? l.platform}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {ACTION_LABEL[base] ?? base}
                        {dry && <FlaskConical className="inline w-3 h-3 ml-1 text-amber-400" />}
                      </td>
                      <td className="px-2 py-1.5 max-w-[240px] truncate" title={l.product_name ?? ""}>{l.product_name ?? l.target_id ?? l.vendor_item_id ?? "-"}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-[var(--text-muted)]">{l.previous_value ?? "-"} → {l.new_value ?? "-"}</td>
                      <td className={`px-2 py-1.5 ${l.status === "success" ? "text-green-400" : "text-red-400"}`} title={l.error_message ?? ""}>
                        {l.status === "success" ? "성공" : `실패 ${l.error_message ? `· ${l.error_message.slice(0, 60)}` : ""}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
