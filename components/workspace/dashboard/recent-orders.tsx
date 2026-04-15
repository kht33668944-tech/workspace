"use client";

import Link from "next/link";
import type { DashboardRecentOrder } from "@/hooks/use-dashboard";

const STATUS_COLORS: Record<string, string> = {
  결제전: "text-orange-400 bg-orange-400/10",
  배송준비: "text-yellow-400 bg-yellow-400/10",
  배송완료: "text-green-400 bg-green-400/10",
  취소준비: "text-[var(--text-muted)] bg-[var(--bg-subtle)]",
  취소완료: "text-[var(--text-muted)] bg-[var(--bg-subtle)]",
  반품준비: "text-red-400 bg-red-400/10",
  반품완료: "text-red-400 bg-red-400/10",
  교환준비: "text-blue-400 bg-blue-400/10",
  교환완료: "text-blue-400 bg-blue-400/10",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "text-[var(--text-muted)]";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${cls}`}>
      {status}
    </span>
  );
}

interface RecentOrdersProps {
  orders: DashboardRecentOrder[];
  loading: boolean;
}

export default function RecentOrders({ orders, loading }: RecentOrdersProps) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 md:p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-semibold text-[var(--text-secondary)]">
          최근 주문
        </p>
        <Link
          href="/workspace/orders"
          className="text-xs text-blue-400 hover:underline"
        >
          전체보기 →
        </Link>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--bg-elevated)]">
              <th className="text-xs text-[var(--text-muted)] font-medium text-left py-2 px-3 rounded-l">
                주문일
              </th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-left py-2 px-3">
                판매처
              </th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-left py-2 px-3">
                수취인
              </th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-left py-2 px-3">
                상품명
              </th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-left py-2 px-3">
                배송상태
              </th>
              <th className="text-xs text-[var(--text-muted)] font-medium text-left py-2 px-3 rounded-r">
                운송장번호
              </th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-t border-[var(--border-subtle)]">
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="py-3 px-3">
                        <div className="animate-pulse bg-[var(--bg-elevated)] rounded h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : orders.length === 0
                ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center text-[var(--text-muted)] py-8 text-sm"
                    >
                      주문 데이터가 없습니다.
                    </td>
                  </tr>
                )
                : orders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <td className="py-2.5 px-3 text-xs text-[var(--text-secondary)] whitespace-nowrap">
                      {order.order_date ? order.order_date.slice(0, 10) : "-"}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-[var(--text-secondary)]">
                      {order.marketplace ?? "-"}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-[var(--text-primary)]">
                      {order.recipient_name ?? "-"}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-[var(--text-primary)]">
                      <span
                        className="block max-w-[180px] truncate"
                        title={order.product_name ?? ""}
                      >
                        {order.product_name ?? "-"}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <StatusBadge status={order.delivery_status} />
                    </td>
                    <td className="py-2.5 px-3 text-xs text-[var(--text-muted)]">
                      {order.tracking_no ?? "-"}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
