"use client";

import { Suspense, useState } from "react";
import { useFinance } from "@/hooks/use-finance";
import FinanceKpiCards from "@/components/workspace/finance/finance-kpi-cards";
import FinanceDateNav from "@/components/workspace/finance/finance-date-nav";
import FinanceDetailTab from "@/components/workspace/finance/finance-detail-tab";
import FinanceTrendTab from "@/components/workspace/finance/finance-trend-tab";
import FinanceSummaryTab from "@/components/workspace/finance/finance-summary-tab";

type Tab = "detail" | "trend" | "summary";

function FinancePageInner() {
  const finance = useFinance();
  const [activeTab, setActiveTab] = useState<Tab>("detail");

  const tabs: { key: Tab; label: string }[] = [
    { key: "detail", label: "상세 입력" },
    { key: "trend", label: "추이" },
    { key: "summary", label: "요약" },
  ];

  return (
    <div className="space-y-4">
      {/* 날짜 네비게이션 */}
      <FinanceDateNav
        selectedDate={finance.selectedDate}
        onDateChange={finance.setSelectedDate}
        onPrevDay={finance.goToPrevDay}
        onNextDay={finance.goToNextDay}
        onToday={finance.goToToday}
        onCreateSnapshot={(copy) => finance.createSnapshot(finance.selectedDate, copy)}
        onDeleteSnapshot={finance.deleteSnapshot}
        hasSnapshot={!!finance.snapshot}
        isToday={finance.isToday}
        saveStatus={finance.saveStatus}
      />

      {/* KPI 카드 */}
      <FinanceKpiCards
        snapshot={finance.snapshot}
        changes={finance.changes}
        loading={finance.loading}
      />

      {/* 탭 */}
      <div className="flex gap-4 border-b border-[var(--border)] overflow-x-auto no-scrollbar">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap min-h-[44px] ${
              activeTab === tab.key
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 탭 콘텐츠 */}
      {!finance.loading && !finance.snapshot ? (
        <div className="flex flex-col items-center justify-center py-16 text-[var(--text-muted)]">
          <p className="text-lg mb-2">
            {finance.selectedDate} 스냅샷이 없습니다
          </p>
          <p className="text-sm">
            위의 &quot;전날 복사로 생성&quot; 버튼으로 시작하세요
          </p>
        </div>
      ) : (
        <>
          {activeTab === "detail" && finance.snapshot && (
            <FinanceDetailTab
              snapshot={finance.snapshot}
              changes={finance.changes}
              onSave={finance.saveSnapshot}
            />
          )}
          {activeTab === "trend" && (
            <FinanceTrendTab fetchTrendData={finance.fetchTrendData} />
          )}
          {activeTab === "summary" && (
            <FinanceSummaryTab
              snapshot={finance.snapshot}
              fetchTrendData={finance.fetchTrendData}
            />
          )}
        </>
      )}
    </div>
  );
}

export default function FinancePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[50vh] text-[var(--text-secondary)]">
          로딩 중...
        </div>
      }
    >
      <FinancePageInner />
    </Suspense>
  );
}
