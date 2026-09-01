"use client";

import { ShieldCheck } from "lucide-react";
import AppSettingToggle from "./app-setting-toggle";

export default function AutoApproveSetting() {
  return (
    <AppSettingToggle
      settingKey="auto_approve_cancel"
      icon={<ShieldCheck className="w-4 h-4 text-[var(--text-muted)]" />}
      title="취소요청 자동 승인"
      description={
        <>
          주문 수집(1시간마다) 때 새로 들어온 구매자 취소요청 중 <b>운송장이 없고 아직 구매하지 않은 건</b>만 자동으로 승인합니다.
          운송장이 있거나 이미 구매한 건은 디스코드로 알리고 사람이 승인/거절합니다.
        </>
      }
      confirmText="운송장이 없고 아직 구매(발주)하지 않은 취소요청은 사람 확인 없이 자동 승인됩니다. 켤까요?"
      onMessage="자동 승인이 켜졌습니다. 다음 주문 수집부터 적용됩니다."
      offMessage="자동 승인을 껐습니다."
    />
  );
}
