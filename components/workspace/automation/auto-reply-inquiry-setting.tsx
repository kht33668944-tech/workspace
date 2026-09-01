"use client";

import { Bot } from "lucide-react";
import AppSettingToggle from "@/components/workspace/settings/app-setting-toggle";

export default function AutoReplyInquirySetting() {
  return (
    <AppSettingToggle
      settingKey="auto_reply_inquiry"
      icon={<Bot className="w-4 h-4 text-[var(--text-muted)]" />}
      title="AI 문의 자동답변"
      description={
        <>
          문의 수집(1시간마다) 때 <b>배송 진행·운송장 확인처럼 주문 데이터로 확답 가능한 단순 문의만</b> AI가 자동으로 답변합니다.
          취소·반품·상품 스펙 등 판단이 필요한 문의는 항상 초안만 준비하고 대기합니다. 꺼져 있으면 모든 문의가 대기(초안만)입니다.
        </>
      }
      confirmText="배송 확인처럼 주문 데이터로 확답 가능한 단순 문의는 AI가 사람 확인 없이 자동으로 답변을 전송합니다 (회당 최대 5건). 켤까요?"
      onMessage="AI 자동답변이 켜졌습니다. 다음 문의 수집부터 적용됩니다."
      offMessage="AI 자동답변을 껐습니다. AI는 초안만 준비합니다."
    />
  );
}
