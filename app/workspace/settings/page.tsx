"use client";

import CredentialManager from "@/components/workspace/settings/credential-manager";
import CourierCodeManager from "@/components/workspace/settings/courier-code-manager";
import GeminiUsageDashboard from "@/components/workspace/settings/gemini-usage-dashboard";
import MarketplaceApiManager from "@/components/workspace/settings/marketplace-api-manager";
import MarketplaceApiLogs from "@/components/workspace/settings/marketplace-api-logs";
import DiscordNotificationTester from "@/components/workspace/settings/discord-notification-tester";

export default function SettingsPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[var(--text-primary)]">설정</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">구매처 계정 관리 및 환경 설정</p>
      </div>

      {/* 자동화 동작 설정(취소 자동승인·AI 자동답변)은 자동화 페이지로 이동 */}
      <DiscordNotificationTester />
      <MarketplaceApiManager />
      <MarketplaceApiLogs />
      <CredentialManager />
      <CourierCodeManager />
      <GeminiUsageDashboard />
    </div>
  );
}
