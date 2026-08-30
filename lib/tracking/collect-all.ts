// 운송장 미수집 주문을 구매 계정별로 묶어 스크래퍼로 수집 (스케줄러 스크립트용, 브라우저 필요)
//  tracking-collect-modal.tsx 의 autoCollectGroups 규칙과 동일: purchase_source(지마켓/옥션/오늘의집) + purchase_id == credential.login_id

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { decrypt } from "@/lib/crypto";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { collectGmarketTracking } from "@/lib/scrapers/gmarket";
import { collectAuctionTracking } from "@/lib/scrapers/auction";
import { collectOhouseTracking } from "@/lib/scrapers/ohouse";
import type { ScrapeResult } from "@/lib/scrapers/types";
import { applyTrackingToOrders, saveTrackingLogs } from "@/lib/tracking/apply";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

type Platform = "gmarket" | "auction" | "ohouse";
const PLATFORM_NAME: Record<Platform, string> = { gmarket: "지마켓", auction: "옥션", ohouse: "오늘의집" };
const normalizeLoginId = (v: string | null | undefined) => v?.trim().toLowerCase() ?? "";

export interface CollectGroupResult {
  platform: Platform;
  loginId: string;
  targets: number;
  success: number;
  failed: number;
  notFound: number;
  applied: number;
  error?: string;
}

export interface CollectAllResult {
  pending: number;
  unmatched: number;
  groups: CollectGroupResult[];
  appliedOrderIds: string[];
}

export async function collectTrackingForUser(supabase: AnySupabase, userId: string, opts: { days?: number; signal?: AbortSignal; log?: (m: string) => void } = {}): Promise<CollectAllResult> {
  const log = opts.log ?? ((m: string) => console.log(`[collect-all] ${m}`));
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400000).toISOString();
  const { data: pendingRows, error } = await supabase
    .from("orders")
    .select("id,purchase_source,purchase_id,purchase_order_no,tracking_no,delivery_status")
    .eq("user_id", userId)
    .not("purchase_order_no", "is", null)
    .neq("purchase_order_no", "")
    .or("tracking_no.is.null,tracking_no.eq.")
    .gte("order_date", since)
    .limit(2000);
  if (error) throw new Error(`발주서 조회 실패: ${error.message}`);
  type Row = { id: string; purchase_source: string | null; purchase_id: string | null; purchase_order_no: string; delivery_status: string };
  const pending = ((pendingRows ?? []) as Row[]).filter((o) => !["취소완료", "재고부족", "반품완료", "교환완료"].includes(o.delivery_status));

  const { data: creds } = await supabase.from("purchase_credentials").select("id,platform,login_id,login_pw_encrypted").eq("user_id", userId).in("platform", ["gmarket", "auction", "ohouse"]);
  const result: CollectAllResult = { pending: pending.length, unmatched: 0, groups: [], appliedOrderIds: [] };
  const matched = new Set<string>();
  const batchId = randomUUID();

  for (const cred of (creds ?? []) as Array<{ id: string; platform: Platform; login_id: string; login_pw_encrypted: string }>) {
    const name = PLATFORM_NAME[cred.platform];
    const loginId = normalizeLoginId(cred.login_id);
    const targets = pending.filter((o) => o.purchase_source === name && normalizeLoginId(o.purchase_id) === loginId);
    if (targets.length === 0) continue;
    for (const t of targets) matched.add(t.id);
    const orderNos = [...new Set(targets.map((t) => t.purchase_order_no))];
    const g: CollectGroupResult = { platform: cred.platform, loginId: cred.login_id, targets: orderNos.length, success: 0, failed: 0, notFound: 0, applied: 0 };
    result.groups.push(g);
    log(`${name} ${cred.login_id}: ${orderNos.length}건 수집 시작`);
    let pw: string;
    try { pw = decrypt(cred.login_pw_encrypted); } catch (e) { g.error = `비밀번호 복호화 실패: ${e instanceof Error ? e.message : String(e)}`; continue; }
    await browserPool.acquire();
    try {
      let r: ScrapeResult;
      if (cred.platform === "gmarket") r = await collectGmarketTracking(cred.login_id, pw, orderNos, opts.signal);
      else if (cred.platform === "auction") r = await collectAuctionTracking(cred.login_id, pw, orderNos, opts.signal);
      else r = await collectOhouseTracking(cred.login_id, pw, orderNos, supabase, opts.signal);
      g.success = r.success.length; g.failed = r.failed.length; g.notFound = r.notFound.length;
      if (r.success.length > 0) {
        const applied = await applyTrackingToOrders(supabase, r.success.map((s) => ({ purchase_order_no: s.orderNo, courier: s.courier, tracking_no: s.trackingNo })), userId);
        g.applied = applied.successCount;
        result.appliedOrderIds.push(...applied.orderIds);
        for (const e of applied.errors.slice(0, 5)) log(`  반영 실패: ${e}`);
      }
      await saveTrackingLogs(supabase, userId, r, cred.platform, cred.login_id, orderNos, batchId);
      log(`${name} ${cred.login_id}: 성공 ${g.success} 실패 ${g.failed} 미발견 ${g.notFound} 반영 ${g.applied}`);
    } catch (e) {
      g.error = e instanceof Error ? e.message : String(e);
      log(`${name} ${cred.login_id}: 예외 — ${g.error}`);
    } finally {
      browserPool.release();
    }
  }
  result.unmatched = pending.filter((o) => !matched.has(o.id) && ["지마켓", "옥션", "오늘의집"].includes(o.purchase_source ?? "")).length;
  return result;
}
