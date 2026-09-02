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
import { getPurchaseOrders, upsertEntry } from "@/lib/purchase-orders";
import { notifyAutomationResult } from "@/lib/discord-notifier";
import type { PurchaseOrderEntry } from "@/types/database";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

interface TrackRow {
  id: string;
  recipient_name: string | null;
  product_name: string | null;
  delivery_status: string;
  quantity: number;
  purchase_order_no: string | null;
  purchase_detail_url: string | null;
  courier: string | null;
  tracking_no: string | null;
  purchased_at: string | null;
  purchase_orders: PurchaseOrderEntry[] | null;
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
  // 지마켓 구매 여부(상세링크)는 대표 컬럼 또는 구매 주문 목록 엔트리로 코드에서 거른다
  const { data: rows, error } = await supabase
    .from("orders")
    .select("id, recipient_name, product_name, delivery_status, quantity, purchase_order_no, purchase_detail_url, courier, tracking_no, purchased_at, purchase_orders")
    .eq("user_id", userId)
    .in("delivery_status", ["반품접수", "반품준비"])
    .not("purchase_return_requested_at", "is", null);
  if (error) throw new Error(`반품추적 대상 조회 실패: ${error.message}`);

  // 행마다 추적할 엔트리: 지마켓 상세링크가 있고 반품신청한 것. 목록이 없는 행은 대표 상세링크 1건
  const targets = ((rows ?? []) as TrackRow[])
    .map((t) => {
      const entries = getPurchaseOrders(t).filter((e) => /gmarket/i.test(e.detail_url ?? ""));
      const requested = entries.filter((e) => !!e.return_requested_at);
      // 구목록(엔트리 단위 기록 없음)은 전부 신청한 것으로 본다
      return { ...t, entries, track: requested.length > 0 ? requested : entries };
    })
    .filter((t) => t.track.length > 0);
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
      // 엔트리마다 상세페이지를 읽어 진행상태를 모은다
      const statuses: Array<"접수" | "완료" | "기타"> = [];
      let entries = t.entries;
      let entryChanged = false;
      let readError: string | null = null;
      for (const e of t.track) {
        try {
          const s = await readGmarketReturnStatus(ctx, e.detail_url!);
          statuses.push(s);
          const es = s === "기타" ? null : s;
          if (es && e.return_status !== es) { entries = upsertEntry(entries, { order_no: e.order_no, return_status: es }); entryChanged = true; }
        } catch (err) {
          readError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      if (readError) {
        result.errors.push(`${t.recipient_name ?? "?"} · ${t.product_name ?? "?"}: ${readError}`);
        continue;
      }
      // 엔트리 상태 저장 (목록이 있는 행만 — 없는 행은 대표 1건 체계 유지)
      if (entryChanged && !dryRun && Array.isArray(t.purchase_orders) && t.purchase_orders.length > 0) {
        const { error: entryErr } = await supabase.from("orders").update({ purchase_orders: entries }).eq("id", t.id).eq("user_id", userId);
        if (entryErr) result.errors.push(`엔트리 상태 저장 실패(${t.id}): ${entryErr.message}`);
      }

      // 행 상태: 신청한 주문이 모두 완료 → 반품완료, 하나라도 접수 이상 → 반품접수. rank 전진만 반영 (역행·동일 무시)
      const allDone = statuses.length > 0 && statuses.every((s) => s === "완료");
      const anyProgress = statuses.some((s) => s === "접수" || s === "완료");
      const target = allDone ? "반품완료" : anyProgress ? "반품접수" : null;
      if (!target || returnRank(target) <= returnRank(t.delivery_status)) { result.unchanged++; continue; }

      if (target === "반품완료") result.toCompleted++; else result.toReceived++;
      result.changes.push({ recipientName: t.recipient_name, productName: t.product_name, from: t.delivery_status, to: target });
      log(`${t.recipient_name ?? "?"} · ${t.product_name ?? "?"}${t.track.length > 1 ? ` (주문 ${t.track.length}건)` : ""}: ${t.delivery_status} → ${target}${dryRun ? " [DRY]" : ""}`);

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
