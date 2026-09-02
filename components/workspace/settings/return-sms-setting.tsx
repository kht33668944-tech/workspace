"use client";

import { MessageSquare } from "lucide-react";
import AppSettingToggle from "./app-setting-toggle";

export default function ReturnSmsSetting() {
  return (
    <AppSettingToggle
      settingKey="return_sms"
      icon={<MessageSquare className="w-4 h-4 text-[var(--text-muted)]" />}
      title="반품신청 후 고객 안내 문자"
      description={
        <>
          지마켓 반품신청 자동화가 한 주문의 반품 신청을 모두 마치면, 단체문자의 <b>&quot;반품 신청&quot; 템플릿</b>을 주문자번호(없으면 수령자번호)로 휴대폰 경로 1통 보냅니다.
          마켓이 반품 접수 때 새로 발급한 안심번호가 반영된 뒤 보내며, 같은 주문에 두 번 보내지 않습니다. 교환 건은 보내지 않습니다.
          KT 일일 한도는 단체문자와 같이 적용되고, 문자 실패는 반품 신청 결과에 영향을 주지 않습니다.
        </>
      }
      confirmText="반품신청 자동화가 끝날 때마다 고객에게 문자가 자동으로 나갑니다. 단체문자 화면에 '반품 신청' 템플릿이 있어야 합니다. 켤까요?"
      onMessage="자동 문자가 켜졌습니다. 다음 반품신청 자동화부터 적용됩니다."
      offMessage="자동 문자를 껐습니다."
    />
  );
}
