"use client";

// 실행 1건의 kind별 상세 요약 (타임라인 펼침·오류 센터 공용)
import type { MarketplaceSyncRun } from "@/types/database";
import type { PriceRound } from "@/lib/automation-schedule";
import { formatLogTime } from "@/lib/log-format";

const PLATFORM_LABEL: Record<string, string> = { coupang: "쿠팡", smartstore: "스토어", all: "전체" };

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[var(--text-muted)] w-24 shrink-0">{label}</span>
      <span className="text-[var(--text-secondary)]">{value}</span>
    </div>
  );
}

interface MarketCounts { price?: number; stop?: number; resume?: number; failed?: number; blocked?: number }

function summarize(run: MarketplaceSyncRun): Array<[string, string | number]> {
  const d = (run.detail ?? {}) as Record<string, unknown>;
  const kind = run.kind ?? "orders";
  const out: Array<[string, string | number]> = [];

  if (kind === "orders") {
    out.push(["수집", `${run.remote_count ?? 0}건 (신규 ${run.new_orders ?? 0})`]);
    out.push(["발주확인", `${run.confirmed ?? 0}건${run.confirm_failed ? ` / 실패 ${run.confirm_failed}` : ""}`]);
    const claims = Array.isArray(d.claims) ? d.claims.length : (Array.isArray(run.claims) ? run.claims.length : 0);
    if (claims) out.push(["클레임", `${claims}건`]);
  } else if (kind === "inquiries") {
    out.push(["문의", `${run.remote_count ?? 0}건 조회`]);
    out.push(["새 문의", `${Number(d.new ?? 0)}건 (자동답변 ${Number(d.autoReplied ?? 0)} · 대기 ${Number(d.held ?? 0)})`]);
    if (Number(d.updatedAnswered ?? 0)) out.push(["마켓 답변 반영", `${Number(d.updatedAnswered)}건`]);
  } else if (kind === "shipping") {
    out.push(["송장 전송", `대상 ${run.remote_count ?? 0} · 전송 ${run.confirmed ?? 0} · 실패 ${run.confirm_failed ?? 0}`]);
  } else if (kind === "tracking-collect") {
    out.push(["운송장 수집", `미수집 ${Number(d.pending ?? run.remote_count ?? 0)} → 반영 ${Number(d.applied ?? run.confirmed ?? 0)}건`]);
    if (Number(d.unmatched ?? 0)) out.push(["계정 미매칭", `${Number(d.unmatched)}건`]);
  } else if (kind === "esm-export") {
    out.push(["ESM 엑셀", Number(d.count ?? 0) > 0 ? `${Number(d.count)}건 저장` : "새 건 없음"]);
    if (typeof d.file === "string" && d.file) out.push(["파일", d.file]);
  } else if (kind === "settlement") {
    out.push(["정산", `매칭 ${Number(d.matched ?? 0)} · 반영 ${run.confirmed ?? 0} · 미매칭 ${Number(d.unmatched ?? 0)}`]);
  } else if (kind === "daily-summary") {
    out.push(["하루 요약", "디스코드 발송됨"]);
  } else if (kind === "price") {
    const scrape = d.scrape as { rounds?: PriceRound[]; remaining?: number } | undefined;
    const rounds = scrape?.rounds ?? [];
    const last = rounds[rounds.length - 1];
    if (last) out.push(["수집", `${last.collected}건 · 품절 ${last.soldOut} (재시도 ${rounds.length - 1}회)`]);
    const apply = d.apply as { changed?: number; applied?: number; unchanged?: number } | undefined;
    if (apply) out.push(["가격 적용", `변동 ${apply.applied ?? 0}건 · 변동없음 ${apply.unchanged ?? 0}건`]);
    const market = d.market as { coupang?: MarketCounts | null; smartstore?: MarketCounts | null } | undefined;
    for (const [p, label] of [["coupang", "쿠팡 반영"], ["smartstore", "스토어 반영"]] as const) {
      const m = market?.[p];
      if (m) out.push([label, `가격 ${m.price ?? 0} · 중지 ${m.stop ?? 0} · 재개 ${m.resume ?? 0}${m.failed ? ` · 실패 ${m.failed}` : ""}`]);
    }
  }
  return out;
}

export default function RunDetail({ runs }: { runs: MarketplaceSyncRun[] }) {
  return (
    <div className="space-y-3 px-3 py-2.5 bg-[var(--bg-tertiary)] rounded-lg">
      {runs.map((run) => (
        <div key={run.id} className="space-y-1">
          <p className="text-xs font-medium text-[var(--text-primary)]">
            {PLATFORM_LABEL[run.platform] ?? run.platform} · {formatLogTime(run.started_at)} 시작
            {run.finished_at && ` → ${formatLogTime(run.finished_at)} 종료`}
            {run.dry_run && <span className="text-amber-400 ml-1">[DRY]</span>}
            {run.trigger === "manual" && <span className="text-blue-400 ml-1">수동</span>}
          </p>
          {summarize(run).map(([label, value]) => <Row key={label} label={label} value={value} />)}
          {run.error && <p className="text-xs text-red-400 break-all">오류: {run.error.slice(0, 300)}</p>}
        </div>
      ))}
    </div>
  );
}
