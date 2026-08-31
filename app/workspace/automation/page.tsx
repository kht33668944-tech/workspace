"use client";

// 자동화 현황 — 타임라인·진행중·상태 카드·오류 센터·설정
import { useAutomationRuns } from "@/hooks/use-automation-runs";
import RunningNowCard from "@/components/workspace/automation/running-now-card";
import AutomationStatusCards from "@/components/workspace/automation/automation-status-cards";
import TodayTimeline from "@/components/workspace/automation/today-timeline";
import ErrorCenter from "@/components/workspace/automation/error-center";
import AutoApproveSetting from "@/components/workspace/settings/auto-approve-setting";
import AutoReplyInquirySetting from "@/components/workspace/automation/auto-reply-inquiry-setting";
import { Loader2 } from "lucide-react";

export default function AutomationPage() {
  const { loading, refetch, todayTimeline, runningRuns, staleRuns, errorRuns, weekStats, nextRun } = useAutomationRuns();

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[var(--text-primary)]">자동화</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          주문수집·문의·운송장·최저가 자동화의 스케줄과 실행 결과를 한눈에 봅니다. PC가 켜져 있어야 정시에 실행됩니다.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">로드 중...</span>
        </div>
      ) : (
        <>
          <RunningNowCard runningRuns={runningRuns} staleRuns={staleRuns} nextRun={nextRun} onRefetch={refetch} />
          <AutomationStatusCards weekStats={weekStats} onRefetch={refetch} />
          <TodayTimeline slots={todayTimeline} />
          <ErrorCenter errorRuns={errorRuns} onRefetch={refetch} />
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">자동화 설정</h2>
            <AutoApproveSetting />
            <AutoReplyInquirySetting />
          </div>
        </>
      )}
    </div>
  );
}
