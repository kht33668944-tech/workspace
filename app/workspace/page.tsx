"use client";

import { useDashboard } from "@/hooks/use-dashboard";
import KpiCards from "@/components/workspace/dashboard/kpi-cards";
import TodoFlow from "@/components/workspace/dashboard/todo-flow";
import AutomationStatus from "@/components/workspace/dashboard/automation-status";
import QuickActions from "@/components/workspace/dashboard/quick-actions";
import RecentOrders from "@/components/workspace/dashboard/recent-orders";

export default function WorkspacePage() {
  const { data, loading } = useDashboard();

  return (
    <div className="space-y-6">
      {/* KPI 카드 */}
      <KpiCards
        currentMonthCount={data.currentMonthCount}
        lastMonthCount={data.lastMonthCount}
        currentMonthRevenue={data.currentMonthRevenue}
        lastMonthRevenue={data.lastMonthRevenue}
        currentMonthMargin={data.currentMonthMargin}
        lastMonthMargin={data.lastMonthMargin}
        unpaidCount={data.unpaidCount}
        loading={loading}
      />

      {/* 오늘 할일 플로우 + 빠른 액션 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <TodoFlow
            unpurchasedCount={data.unpurchasedCount}
            noTrackingCount={data.noTrackingCount}
            deliveredCount={data.deliveredCount}
            csCount={data.csCount}
            loading={loading}
          />
        </div>
        <div className="lg:col-span-1">
          <QuickActions />
        </div>
      </div>

      {/* 자동화 현황 */}
      <AutomationStatus
        unpurchasedCount={data.unpurchasedCount}
        noTrackingCount={data.noTrackingCount}
        failedLogs={data.failedLogs}
        loading={loading}
      />

      {/* 최근 주문 */}
      <RecentOrders orders={data.recentOrders} loading={loading} />
    </div>
  );
}
