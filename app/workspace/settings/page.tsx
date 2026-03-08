"use client";

import CredentialManager from "@/components/workspace/settings/credential-manager";

export default function SettingsPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">설정</h1>
        <p className="text-sm text-white/40 mt-1">구매처 계정 관리 및 환경 설정</p>
      </div>

      <CredentialManager />
    </div>
  );
}
