"use client";

import CredentialManager from "@/components/workspace/settings/credential-manager";
import CourierCodeManager from "@/components/workspace/settings/courier-code-manager";
import GeminiUsageDashboard from "@/components/workspace/settings/gemini-usage-dashboard";

export default function SettingsPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[var(--text-primary)]">설정</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">구매처 계정 관리 및 환경 설정</p>
      </div>

      <CredentialManager />
      <CourierCodeManager />
      <GeminiUsageDashboard />
    </div>
  );
}
