"use client";

import Link from "next/link";
import { setOrdersFilter } from "@/lib/dashboard-filters";
import SkeletonBlock from "./skeleton-block";

// 오늘 할 일 — 윗줄: 정상 흐름(구매대기 → 구매 확인 → 배송준비 → 배송완료), 아랫줄: 예외 처리(발송불가·취소요청·CS·취소준비·문의).
// "✅ 전부 처리됨"은 사람이 결정할 카드(배송준비·배송완료 제외)가 전부 0일 때.
interface TodoFlowProps {
  unpurchasedCount: number;     // 구매대기
  reviewCount: number;          // 구매확인필요 + 부분구매
  outOfStockCount: number;      // 발송불가
  shipDeadlineCount: number;    // 미발송 전체 중 발송기한 임박(내일까지)
  cancelRequestCount: number;   // 취소요청
  csCount: number;              // 반품준비 + 교환준비
  cancelPendingCount: number;   // 취소준비
  noTrackingCount: number;      // 배송준비 (운송장 대기)
  deliveredCount: number;       // 이번달 배송완료
  inquiryCount: number;         // 미답변 마켓 문의
  loading: boolean;
}

interface CardProps {
  label: string;
  count: number;
  sub: string;
  accent: "orange" | "purple" | "amber" | "rose" | "red" | "blue" | "green" | "teal";
  highlight?: boolean; // false 면 건수가 있어도 강조하지 않음 (자동 진행·실적 카드)
  loading: boolean;
  filter: Record<string, string[]>;
  /** 기본은 발주서 탭 — 문의 카드처럼 다른 탭으로 보낼 때만 지정 */
  href?: string;
}

const ACCENT = {
  orange: { count: "text-orange-400", border: "border-orange-500/30 hover:border-orange-500/60" },
  purple: { count: "text-purple-400", border: "border-purple-500/30 hover:border-purple-500/60" },
  amber: { count: "text-amber-400", border: "border-amber-500/30 hover:border-amber-500/60" },
  rose: { count: "text-rose-400", border: "border-rose-500/30 hover:border-rose-500/60" },
  red: { count: "text-red-400", border: "border-red-500/30 hover:border-red-500/60" },
  blue: { count: "text-blue-400", border: "border-[var(--border)] hover:border-blue-500/50" },
  green: { count: "text-green-400", border: "border-[var(--border)] hover:border-green-500/50" },
  teal: { count: "text-teal-400", border: "border-teal-500/30 hover:border-teal-500/60" },
} as const;

function Card({ label, count, sub, accent, highlight = true, loading, filter, href = "/workspace/orders" }: CardProps) {
  const active = highlight && count > 0;
  const a = ACCENT[accent];
  return (
    <Link
      href={href}
      onClick={() => { if (Object.keys(filter).length > 0) setOrdersFilter(filter); }}
      className={`bg-[var(--bg-card)] border rounded-xl px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors cursor-pointer min-w-0 min-h-[44px] ${active ? a.border : "border-[var(--border)] hover:border-blue-500/50"}`}
    >
      <p className="text-xs text-[var(--text-muted)] mb-1.5">{label}</p>
      {loading ? (
        <SkeletonBlock className="h-7 w-14 mb-1" />
      ) : (
        <p className={`text-2xl font-bold mb-0.5 ${active || !highlight ? a.count : "text-[var(--text-primary)]"}`}>
          {count.toLocaleString("ko-KR")}
          <span className="text-sm font-normal text-[var(--text-muted)] ml-1">건</span>
        </p>
      )}
      <p className="text-xs text-[var(--text-muted)] truncate">{sub}</p>
    </Link>
  );
}

export default function TodoFlow({
  unpurchasedCount,
  reviewCount,
  outOfStockCount,
  shipDeadlineCount,
  cancelRequestCount,
  csCount,
  cancelPendingCount,
  noTrackingCount,
  deliveredCount,
  inquiryCount,
  loading,
}: TodoFlowProps) {
  const totalTodo = unpurchasedCount + reviewCount + outOfStockCount + cancelRequestCount + csCount + cancelPendingCount + inquiryCount;
  const allClear = !loading && totalTodo === 0;

  return (
    <div>
      <p className="text-sm font-semibold text-[var(--text-secondary)] mb-3">
        오늘 할 일
        {allClear && <span className="ml-2 text-green-400 font-medium">✅ 전부 처리됨</span>}
        {!loading && shipDeadlineCount > 0 && (
          <span className="ml-2 text-red-400 font-semibold">⚠️ 발송기한 임박 {shipDeadlineCount}건 (미발송)</span>
        )}
      </p>
      {/* 윗줄: 정상 흐름 4칸 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
        <Card
          label="구매대기" count={unpurchasedCount} sub="자동구매 실행" accent="orange"
          loading={loading} filter={{ delivery_status: ["구매대기"] }}
        />
        <Card
          label="구매 확인" count={reviewCount} sub="자동구매 이상·부분구매" accent="purple"
          loading={loading} filter={{ delivery_status: ["구매확인필요", "부분구매"] }}
        />
        <Card
          label="배송준비" count={noTrackingCount} sub="운송장 수집 대기 (자동)" accent="blue" highlight={false}
          loading={loading} filter={{ delivery_status: ["배송준비"] }}
        />
        <Card
          label="배송완료" count={deliveredCount} sub="이번달 완료" accent="green" highlight={false}
          loading={loading} filter={{ delivery_status: ["배송완료"] }}
        />
      </div>
      {/* 아랫줄: 예외 처리 5칸 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Card
          label="발송불가" count={outOfStockCount} sub="취소 또는 발송 결정" accent="amber"
          loading={loading} filter={{ delivery_status: ["발송불가"] }}
        />
        <Card
          label="취소요청" count={cancelRequestCount} sub="승인/거절 판단" accent="rose"
          loading={loading} filter={{ delivery_status: ["취소요청"] }}
        />
        <Card
          label="문의" count={inquiryCount} sub="미답변 마켓 문의" accent="teal"
          loading={loading} filter={{}} href="/workspace/orders?tab=inquiries"
        />
        <Card
          label="CS 처리" count={csCount} sub="반품·교환 준비" accent="red"
          loading={loading} filter={{ delivery_status: ["교환준비", "반품준비"] }}
        />
        <Card
          label="취소준비" count={cancelPendingCount} sub="마켓 취소 실행" accent="red"
          loading={loading} filter={{ delivery_status: ["취소준비"] }}
        />
      </div>
    </div>
  );
}
