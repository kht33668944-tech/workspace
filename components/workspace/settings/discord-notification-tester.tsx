"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";

export default function DiscordNotificationTester() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [sending, setSending] = useState(false);

  const sendTest = async () => {
    if (!session?.access_token || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/notifications/discord-test", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        showToast(body.error ?? "디스코드 테스트 알림 전송 실패", "error");
        return;
      }
      showToast("디스코드 테스트 알림을 보냈습니다.", "success");
    } catch (error) {
      console.error("[discord-notification-tester]", error instanceof Error ? error.message : String(error));
      showToast("디스코드 테스트 알림 전송 중 오류가 났습니다.", "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl px-6 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Send className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">디스코드 알림 테스트</h2>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Railway에 DISCORD_WEBHOOK_URL을 넣은 뒤 이 버튼으로 휴대폰 알림을 확인합니다.
          </p>
        </div>
        <button
          type="button"
          onClick={sendTest}
          disabled={!session?.access_token || sending}
          className="inline-flex items-center justify-center gap-2 px-4 min-h-[44px] rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          테스트 알림 보내기
        </button>
      </div>
    </div>
  );
}
