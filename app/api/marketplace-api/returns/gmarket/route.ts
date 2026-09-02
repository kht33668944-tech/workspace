// 지마켓 구매처 반품신청 자동화 API
// mode:
//  - "preview": 브라우저 없이 대상 목록 + 사유 매핑만 JSON 반환 (자동화 페이지 확인 모달용)
//  - "dry":     브라우저로 신청 직전까지 진행 후 중단 (SSE) — 실검증용
//  - "run":     실제 반품신청 (SSE)
// 대상: 반품준비·교환준비 + 지마켓 구매건(purchase_detail_url) + 아직 신청 안 한 건
// 성공 시 orders.purchase_return_requested_at 기록 (중복 신청 방지), 발주서 상태는 바꾸지 않는다

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { launchPatchedBrowser, createPatchedGmarketContext } from "@/lib/scrapers/browser";
import { ensureLogin } from "@/lib/scrapers/gmarket-session";
import { requestGmarketReturn, mapClaimReason, buildDetailText } from "@/lib/scrapers/gmarket-return";
import { startSyncRun, finishSyncRun } from "@/lib/marketplace/sync-run";
import { notifyAutomationResult } from "@/lib/discord-notifier";

export const maxDuration = 300;

interface TargetOrder {
  id: string;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number | null;
  delivery_status: string;
  claim_reason: string | null;
  purchase_detail_url: string;
}

interface SSEEvent {
  type: "progress" | "done" | "error";
  orderId?: string;
  message?: string;
  index?: number;
  total?: number;
  results?: Array<{
    orderId: string; recipientName: string | null; productName: string | null; deliveryStatus: string;
    ok: boolean; selectedReason: string; returnFee: string | null; error?: string; needRepurchase: boolean;
  }>;
  successCount?: number;
  failCount?: number;
}

// orderIds 가 있으면 그 주문만 (발주서에서 선택한 건), 없으면 전체 (자동화 페이지 버튼)
async function fetchTargets(userId: string, orderIds?: string[]): Promise<TargetOrder[]> {
  const sb = getServiceSupabaseClient();
  let query = sb
    .from("orders")
    .select("id, recipient_name, product_name, quantity, delivery_status, claim_reason, purchase_detail_url")
    .eq("user_id", userId)
    .in("delivery_status", ["반품준비", "교환준비"])
    .ilike("purchase_detail_url", "%gmarket%")
    .is("purchase_return_requested_at", null);
  if (orderIds && orderIds.length > 0) query = query.in("id", orderIds);
  const { data, error } = await query;
  if (error) throw new Error(`대상 조회 실패: ${error.message}`);
  return (data ?? []) as TargetOrder[];
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const userSb = getSupabaseClient(token);
  const { data: { user } } = await userSb.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  const userId = user.id;

  const body = (await request.json().catch(() => ({}))) as { mode?: "preview" | "dry" | "run"; orderIds?: string[] };
  const mode = body.mode ?? "preview";
  const orderIds = Array.isArray(body.orderIds) ? body.orderIds.filter((x) => typeof x === "string") : undefined;

  let targets: TargetOrder[];
  try {
    targets = await fetchTargets(userId, orderIds);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  // ── preview: 브라우저 없이 대상·사유 매핑만 ──
  if (mode === "preview") {
    return NextResponse.json({
      targets: targets.map((t) => ({
        orderId: t.id,
        recipientName: t.recipient_name,
        productName: t.product_name,
        quantity: t.quantity,
        deliveryStatus: t.delivery_status,
        claimReason: t.claim_reason,
        mappedReason: mapClaimReason(t.claim_reason),
        detailText: buildDetailText(t.claim_reason),
        needRepurchase: t.delivery_status === "교환준비",
      })),
    });
  }

  if (targets.length === 0) {
    return NextResponse.json({ error: "반품신청 대상이 없습니다." }, { status: 400 });
  }

  const dryRun = mode === "dry";
  const serviceSb = getServiceSupabaseClient();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: SSEEvent) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { /* 연결 끊김 */ }
      };

      const runId = await startSyncRun(serviceSb, { userId, platform: "gmarket", kind: "gmarket-return", trigger: "manual", dryRun });
      const results: NonNullable<SSEEvent["results"]> = [];
      let success = 0;
      let fail = 0;

      await browserPool.acquire();
      let browser: Awaited<ReturnType<typeof launchPatchedBrowser>> | null = null;
      try {
        browser = await launchPatchedBrowser();
        const ctx = await createPatchedGmarketContext(browser);
        await ensureLogin(ctx, userId);

        for (let i = 0; i < targets.length; i++) {
          if (request.signal.aborted) break;
          const t = targets[i];
          send({ type: "progress", orderId: t.id, index: i + 1, total: targets.length, message: `${t.recipient_name ?? "?"} · ${t.product_name ?? "?"} 처리 중` });

          const r = await requestGmarketReturn(ctx, { detailUrl: t.purchase_detail_url, claimReason: t.claim_reason, dryRun });
          const row = {
            orderId: t.id, recipientName: t.recipient_name, productName: t.product_name, deliveryStatus: t.delivery_status,
            ok: r.ok, selectedReason: r.selectedReason, returnFee: r.returnFeeText, error: r.error,
            needRepurchase: t.delivery_status === "교환준비",
          };
          results.push(row);

          if (r.ok && !dryRun) {
            const memoLine = `구매처 반품신청(${r.selectedReason}${r.returnFeeText ? `, 반품비 ${r.returnFeeText} 환불차감` : ""})`;
            const { data: cur } = await serviceSb.from("orders").select("delivery_memo").eq("id", t.id).eq("user_id", userId).maybeSingle();
            const memo = cur?.delivery_memo ? `${cur.delivery_memo} | ${memoLine}` : memoLine;
            const { error } = await serviceSb.from("orders")
              .update({ purchase_return_requested_at: new Date().toISOString(), delivery_memo: memo })
              .eq("id", t.id).eq("user_id", userId);
            if (error) console.error(`[gmarket-return] 신청 기록 실패(${t.id}): ${error.message}`);
          }
          if (r.ok) success++; else fail++;
          send({ type: "progress", orderId: t.id, index: i + 1, total: targets.length, message: r.ok ? `완료 (${r.selectedReason})` : `실패: ${r.error}` });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[gmarket-return] 실행 오류: ${msg}`);
        send({ type: "error", message: msg });
        fail += targets.length - results.length;
      } finally {
        if (browser) await browser.close().catch(() => {});
        browserPool.release();
      }

      const status = fail > 0 ? (success > 0 ? "partial" : "failed") : "success";
      await finishSyncRun(serviceSb, runId, { status, remote_count: targets.length, confirmed: success, detail: { dryRun, results: results.slice(0, 50) } });

      // 디스코드 보고 — 건별 수취인·상품·반품사유. 교환건은 "재구매 필요" 강조
      const reasonOf = (orderId: string) => targets.find((t) => t.id === orderId)?.claim_reason;
      const line = (r: (typeof results)[number]) => {
        const reason = reasonOf(r.orderId);
        const reasonPart = `${reason ? `"${reason}" → ` : ""}${r.selectedReason}`;
        return `- ${r.recipientName ?? "?"} · ${r.productName ?? "?"} (${reasonPart})${r.needRepurchase ? " ⚠교환·재구매필요" : ""}`;
      };
      const succeeded = results.filter((r) => r.ok);
      const repurchase = results.filter((r) => r.ok && r.needRepurchase);
      const failures = results.filter((r) => !r.ok);
      try {
        await notifyAutomationResult({
          title: "지마켓 반품신청",
          status,
          channel: "orders",
          summary: [
            `대상 ${targets.length}건 — 성공 ${success} / 실패 ${fail}${dryRun ? " [드라이런]" : ""}`,
            ...(succeeded.length > 0 ? ["", `${dryRun ? "신청 예정" : "반품신청 완료"}:`, ...succeeded.map(line)] : []),
            ...(failures.length > 0 ? ["", "실패:", ...failures.slice(0, 10).map((r) => `${line(r)} — ${r.error}`)] : []),
          ].join("\n"),
          fields: [
            { name: "성공", value: success },
            { name: "실패", value: fail },
            { name: "재구매 필요(교환)", value: repurchase.length },
          ],
        });
      } catch (e) {
        console.warn(`[gmarket-return] 디스코드 알림 실패: ${e instanceof Error ? e.message : String(e)}`);
      }

      send({ type: "done", results, successCount: success, failCount: fail });
      try { controller.close(); } catch { /* 이미 닫힘 */ }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
