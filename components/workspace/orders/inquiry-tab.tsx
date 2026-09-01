"use client";

// 마켓 문의 탭 — 쿠팡/스마트스토어 고객문의 목록·AI 초안·답변 전송
import { useState, useCallback } from "react";
import { Search, X, ChevronDown, ChevronRight, Loader2, MessageSquare, RefreshCw, Sparkles, Send, Bot, Store } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { useInquiries, type InquiryWithOrder } from "@/hooks/use-inquiries";
import { formatLogDate, formatLogTime } from "@/lib/log-format";
import { INQUIRY_TYPE_LABEL, INQUIRY_REPLY_LIMITS, type MarketplaceInquiryType } from "@/types/database";

const TYPE_BADGE: Record<MarketplaceInquiryType, string> = {
  coupang_product: "bg-rose-500/10 text-rose-400",
  coupang_cs: "bg-orange-500/10 text-orange-400",
  naver_qna: "bg-emerald-500/10 text-emerald-400",
  naver_inquiry: "bg-teal-500/10 text-teal-400",
};

export default function InquiryTab() {
  const { session } = useAuth();
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"unanswered" | "answered" | null>("unanswered");
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const { showToast } = useToast();

  const { groupedByDay, counts, loading, refetch } = useInquiries({
    status: statusFilter,
    platform: platformFilter,
    search: activeSearch || undefined,
  });

  const headers = useCallback(() => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${session?.access_token ?? ""}`,
  }), [session?.access_token]);

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/marketplace-api/inquiries/sync", { method: "POST", headers: headers(), body: JSON.stringify({}) });
      const json = await res.json().catch(() => ({})) as { results?: Array<{ newInquiries: unknown[]; autoReplied: unknown[]; errors: string[] }>; error?: string };
      if (!res.ok) throw new Error(json.error ?? `동기화 실패 (${res.status})`);
      const newCount = (json.results ?? []).reduce((n, r) => n + r.newInquiries.length, 0);
      const autoCount = (json.results ?? []).reduce((n, r) => n + r.autoReplied.length, 0);
      showToast(`동기화 완료 — 새 문의 ${newCount}건${autoCount ? `, AI 자동답변 ${autoCount}건` : ""}`, "success");
      await refetch();
    } catch (e) {
      console.error("[inquiry-tab] 동기화 실패:", e instanceof Error ? e.message : String(e));
      showToast(`동기화 실패: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSyncing(false);
    }
  }, [syncing, headers, refetch, showToast]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const chip = (label: string, value: "unanswered" | "answered" | null, count?: number) => (
    <button
      onClick={() => setStatusFilter(value)}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
        statusFilter === value
          ? "bg-blue-600 text-white"
          : "bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:bg-[var(--bg-active)]"
      }`}
    >
      {label}{count !== undefined ? ` ${count}` : ""}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-2">
        {chip("전체", null)}
        {chip("미답변", "unanswered", counts.unanswered)}
        {chip("답변완료", "answered", counts.answered)}

        <select
          value={platformFilter || ""}
          onChange={(e) => setPlatformFilter(e.target.value || null)}
          className="px-2 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] outline-none focus:border-blue-500/50"
        >
          <option value="">전체 마켓</option>
          <option value="coupang">쿠팡</option>
          <option value="smartstore">스마트스토어</option>
        </select>

        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setActiveSearch(search); }}
            placeholder="상품명, 문의 내용 검색 (Enter)"
            className="w-full pl-9 pr-8 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50"
          />
          {search && (
            <button onClick={() => { setSearch(""); setActiveSearch(""); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-active)] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "동기화 중..." : "동기화"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-[var(--text-muted)]">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">로드 중...</span>
        </div>
      )}

      {!loading && groupedByDay.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-[var(--text-muted)]">
          <MessageSquare className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">{statusFilter === "unanswered" ? "미답변 문의가 없습니다." : "문의가 없습니다."}</p>
          <p className="text-xs mt-1 opacity-60">매시 정각 자동 동기화되며, 우측 동기화 버튼으로 즉시 가져올 수 있습니다.</p>
        </div>
      )}

      {!loading && groupedByDay.map((day) => (
        <div key={day.date} className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-[var(--border)]" />
            <span className="text-xs font-medium text-[var(--text-muted)] shrink-0">{formatLogDate(day.date)}</span>
            <div className="h-px flex-1 bg-[var(--border)]" />
          </div>
          {day.inquiries.map((inq) => (
            <InquiryRow
              key={inq.id}
              inquiry={inq}
              expanded={expanded.has(inq.id)}
              onToggle={() => toggle(inq.id)}
              headers={headers}
              onChanged={refetch}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ inquiry }: { inquiry: InquiryWithOrder }) {
  if (inquiry.status === "unanswered") {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 shrink-0">미답변</span>;
  }
  const label = inquiry.answer_source === "auto" ? "AI 자동 답변" : inquiry.answer_source === "sync" ? "마켓에서 답변" : "답변완료";
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 shrink-0 flex items-center gap-1">
      {inquiry.answer_source === "auto" && <Bot className="w-3 h-3" />}
      {label}
    </span>
  );
}

function InquiryRow({ inquiry, expanded, onToggle, headers, onChanged }: {
  inquiry: InquiryWithOrder;
  expanded: boolean;
  onToggle: () => void;
  headers: () => Record<string, string>;
  onChanged: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [answer, setAnswer] = useState(inquiry.ai_draft ?? "");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [autoDraftTried, setAutoDraftTried] = useState(false);

  const generateDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const res = await fetch("/api/marketplace-api/inquiries/draft", { method: "POST", headers: headers(), body: JSON.stringify({ id: inquiry.id }) });
      const json = await res.json().catch(() => ({})) as { draft?: string; error?: string };
      if (!res.ok || !json.draft) throw new Error(json.error ?? "초안 생성 실패");
      setAnswer(json.draft);
    } catch (e) {
      console.error("[inquiry-tab] 초안 생성 실패:", e instanceof Error ? e.message : String(e));
      showToast(`AI 초안 생성 실패: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setDrafting(false);
    }
  }, [drafting, headers, inquiry.id, showToast]);

  // 미답변 문의 펼칠 때 초안이 없으면 자동 생성 (1회)
  const handleToggle = useCallback(() => {
    onToggle();
    if (!expanded && inquiry.status === "unanswered" && !answer && !autoDraftTried) {
      setAutoDraftTried(true);
      void generateDraft();
    }
  }, [onToggle, expanded, inquiry.status, answer, autoDraftTried, generateDraft]);

  const handleSend = useCallback(async () => {
    if (sending || !answer.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/marketplace-api/inquiries/reply", { method: "POST", headers: headers(), body: JSON.stringify({ id: inquiry.id, content: answer.trim() }) });
      const json = await res.json().catch(() => ({})) as { ok?: boolean; dryRun?: boolean; alreadyAnswered?: boolean; message?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `전송 실패 (${res.status})`);
      showToast(json.alreadyAnswered ? (json.message ?? "이미 답변된 문의였습니다.") : `답변 전송 완료${json.dryRun ? " (DRY RUN — 실제 전송 없음)" : ""}`, "success");
      await onChanged();
    } catch (e) {
      console.error("[inquiry-tab] 답변 전송 실패:", e instanceof Error ? e.message : String(e));
      showToast(`답변 전송 실패: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSending(false);
    }
  }, [sending, answer, headers, inquiry.id, onChanged, showToast]);

  const order = inquiry.order;
  const limits = INQUIRY_REPLY_LIMITS[inquiry.inquiry_type]; // 마켓 API 글자수 제약 (쿠팡 고객센터 2~1000자)
  const overLimits = !!limits && (answer.length > limits.max || answer.trim().length < limits.min);

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-[var(--bg-hover)] hover:bg-[var(--bg-active)] transition-colors text-left"
      >
        {expanded
          ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          : <ChevronRight className="w-4 h-4 text-[var(--text-muted)] shrink-0" />}
        <span className="text-xs font-medium text-[var(--text-secondary)] w-11 shrink-0">
          {inquiry.inquiry_at ? formatLogTime(inquiry.inquiry_at) : "-"}
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${TYPE_BADGE[inquiry.inquiry_type]}`}>
          {INQUIRY_TYPE_LABEL[inquiry.inquiry_type]}
        </span>
        <span className="text-xs text-[var(--text-tertiary)] max-w-40 truncate shrink-0" title={inquiry.product_name ?? ""}>
          {inquiry.product_name ?? "-"}
        </span>
        <span className="text-xs text-[var(--text-secondary)] flex-1 truncate" title={inquiry.content}>
          {inquiry.content.replace(/\s+/g, " ")}
        </span>
        <StatusBadge inquiry={inquiry} />
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] p-3 space-y-3">
          {/* 문의 전문 */}
          <div className="text-sm text-[var(--text-primary)] whitespace-pre-wrap bg-[var(--bg-tertiary)] rounded-lg px-3 py-2.5">
            {inquiry.content || "(내용 없음)"}
          </div>

          {/* 연결 주문 */}
          {order ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] rounded-lg px-3 py-2.5">
              <span className="flex items-center gap-1 text-[var(--text-muted)]"><Store className="w-3.5 h-3.5" />연결 주문</span>
              <span>{order.recipient_name ?? "-"} · {order.product_name ?? "-"} × {order.quantity ?? 1}</span>
              <span>상태: <span className="text-[var(--text-primary)]">{order.delivery_status ?? "-"}</span></span>
              <span>운송장: {order.tracking_no ? `${order.courier ?? ""} ${order.tracking_no}` : "없음"}</span>
              {order.ship_by_date && <span>발송기한: {order.ship_by_date}</span>}
            </div>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">매칭된 발주서 주문 없음</p>
          )}

          {/* 답변 영역 */}
          {inquiry.status === "answered" ? (
            <div className="space-y-1">
              <p className="text-xs text-[var(--text-muted)]">
                답변 내용 {inquiry.answered_at ? `(${formatLogTime(inquiry.answered_at)})` : ""}
              </p>
              <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-2.5">
                {inquiry.answer_content ?? "(마켓에서 답변됨 — 내용은 셀러센터 참고)"}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={4}
                  placeholder={drafting ? "AI 초안 생성 중..." : "답변을 입력하거나 AI 초안을 생성하세요"}
                  className="w-full px-3 py-2.5 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50 resize-y"
                />
                {drafting && (
                  <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-hover)]/60 rounded-lg">
                    <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={generateDraft}
                  disabled={drafting}
                  className="flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-active)] transition-colors disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {answer ? "AI 초안 재생성" : "AI 초안 생성"}
                </button>
                {limits && (
                  <span className={`text-xs ${answer.trim().length > 0 && overLimits ? "text-red-400" : "text-[var(--text-muted)]"}`}>
                    {answer.length}/{limits.max}자 ({limits.min}자 이상)
                  </span>
                )}
                <button
                  onClick={handleSend}
                  disabled={sending || !answer.trim() || overLimits}
                  className="ml-auto flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50"
                >
                  {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {sending ? "전송 중..." : "답변 전송"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
