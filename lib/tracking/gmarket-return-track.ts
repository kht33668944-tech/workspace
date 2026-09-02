// 지마켓 반품 진행상태 추적 — 운송장 크론(tracking-and-ship)에 통합.
// 반품접수/반품준비(이미 지마켓 신청함) 주문의 basic 상세페이지를 읽어
//   "반품완료" → 발주서 반품완료 (rank 전진), "반품요청/처리중" → 반품접수 로 반영한다.
// 지마켓 구매자용 API 가 없어 스크래핑이 유일 (readGmarketReturnStatus, 2026-09-02 실측).

import type { SupabaseClient } from "@supabase/supabase-js";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { launchPatchedBrowser, createPatchedGmarketContext } from "@/lib/scrapers/browser";
import { ensureLogin } from "@/lib/scrapers/gmarket-session";
import { readGmarketReturnStatus } from "@/lib/scrapers/gmarket-return";
import { returnRank } from "@/lib/constants";
import { notifyAutomationResult } from "@/lib/discord-notifier";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

interface TrackRow {
  id: string;
  recipient_name: string | null;
  product_name: string | null;
  delivery_status: string;
  purchase_detail_url: string;
}

export interface ReturnTrackResult {
  checked: number;
  toReceived: number;   // → 반품접수
  toCompleted: number;  // → 반품완료
  unchanged: number;
  dryRun: boolean;
  changes: Array<{ recipientName: string | null; productName: string | null; from: string; to: string }>;
  errors: string[];
}

export async function trackGmarketReturns(
  supabase: AnySupabase,
  userId: string,
  opts: { dryRun?: boolean; signal?: AbortSignal; log?: (m: string) => void } = {},
): Promise<ReturnTrackResult> {
  const log = opts.log ?? ((m: string) => console.log(`[return-track] ${m}`));
  const dryRun = opts.dryRun ?? false;
  const result: ReturnTrackResult = { checked: 0, toReceived: 0, toCompleted: 0, unchanged: 0, dryRun, changes: [], errors: [] };

  // 지마켓에 반품신청한 진행중 건 (반품접수 + 혹시 반품준비로 남은 것). 반품완료/교환은 제외.
  const { data: rows, error } = await supabase
    .from("orders")
    .select("id, recipient_name, product_name, delivery_status, purchase_detail_url")
    .eq("user_id", userId)
    .in("delivery_status", ["반품접수", "반품준비"])
    .ilike("purchase_detail_url", "%gmarket%")
    .not("purchase_return_requested_at", "is", null);
  if (error) throw new Error(`반품추적 대상 조회 실패: ${error.message}`);

  const targets = (rows ?? []) as TrackRow[];
  if (targets.length === 0) { log("반품추적 대상 없음"); return result; }
  log(`반품추적 대상 ${targets.length}건`);

  await browserPool.acquire();
  let browser: Awaited<ReturnType<typeof launchPatchedBrowser>> | null = null;
  try {
    browser = await launchPatchedBrowser();
    const ctx = await createPatchedGmarketContext(browser);
    await ensureLogin(ctx, userId);

    for (const t of targets) {
      if (opts.signal?.aborted) break;
      result.checked++;
      let status: "접수" | "완료" | "기타";
      try {
        status = await readGmarketReturnStatus(ctx, t.purchase_detail_url);
      } catch (e) {
        result.errors.push(`${t.recipient_name ?? "?"} · ${t.product_name ?? "?"}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // rank 전진만 반영 (역행·동일 무시)
      const target = status === "완료" ? "반품완료" : status === "접수" ? "반품접수" : null;
      if (!target || returnRank(target) <= returnRank(t.delivery_status)) { result.unchanged++; continue; }

      if (target === "반품완료") result.toCompleted++; else result.toReceived++;
      result.changes.push({ recipientName: t.recipient_name, productName: t.product_name, from: t.delivery_status, to: target });
      log(`${t.recipient_name ?? "?"} · ${t.product_name ?? "?"}: ${t.delivery_status} → ${target}${dryRun ? " [DRY]" : ""}`);

      if (!dryRun) {
        const patch: Record<string, unknown> = { delivery_status: target };
        if (target === "반품완료") patch.returned_at = new Date().toISOString();
        const { error: upErr } = await supabase.from("orders").update(patch).eq("id", t.id).eq("user_id", userId).eq("delivery_status", t.delivery_status);
        if (upErr) result.errors.push(`반영 실패(${t.id}): ${upErr.message}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    browserPool.release();
  }

  // 변화가 있을 때만 디스코드 보고 (조용한 시간대는 알림 없음)
  if (result.changes.length > 0 || result.errors.length > 0) {
    const status = result.errors.length > 0 ? (result.changes.length > 0 ? "partial" : "failed") : "success";
    await notifyAutomationResult({
      title: "지마켓 반품추적",
      status,
      channel: "orders",
      summary: [
        `확인 ${result.checked}건 — 반품접수 ${result.toReceived} / 반품완료 ${result.toCompleted}${dryRun ? " [드라이런]" : ""}`,
        ...(result.changes.length > 0 ? ["", ...result.changes.map((c) => `- ${c.recipientName ?? "?"} · ${c.productName ?? "?"}: ${c.from} → ${c.to}`)] : []),
        ...(result.errors.length > 0 ? ["", "오류:", ...result.errors.slice(0, 10).map((e) => `- ${e}`)] : []),
      ].join("\n"),
      fields: [
        { name: "반품접수", value: result.toReceived },
        { name: "반품완료", value: result.toCompleted },
        { name: "변화없음", value: result.unchanged },
      ],
    }).catch((e) => log(`디스코드 알림 실패: ${e instanceof Error ? e.message : String(e)}`));
  }

  return result;
}
