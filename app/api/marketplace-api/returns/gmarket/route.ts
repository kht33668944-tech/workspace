// 지마켓 구매처 반품신청 자동화 API
// mode:
//  - "preview": 브라우저 없이 대상 목록 + 사유 매핑만 JSON 반환 (자동화 페이지 확인 모달용)
//  - "dry":     브라우저로 신청 직전까지 진행 후 중단 (SSE) — 실검증용
//  - "run":     실제 반품신청 (SSE)
// 대상: 반품준비·교환준비 + 지마켓 구매건(purchase_detail_url 또는 purchase_orders 엔트리) + 아직 신청 안 한 건
// 수량 N개 자동구매는 지마켓 주문 N건 → 구매 주문 목록(purchase_orders)의 엔트리마다 순서대로 신청하고,
//   요청 수량(claim_quantity, 없으면 전체)에 도달할 만큼만 신청한다. 엔트리별 return_requested_at 기록,
//   신청해야 할 엔트리를 모두 마쳤을 때만 행의 purchase_return_requested_at 을 채운다 (일부 실패 시 다음 실행에서 이어서)

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { launchPatchedBrowser, createPatchedGmarketContext } from "@/lib/scrapers/browser";
import { ensureLogin } from "@/lib/scrapers/gmarket-session";
import { requestGmarketReturn, mapClaimReason, buildDetailText } from "@/lib/scrapers/gmarket-return";
import { startSyncRun, finishSyncRun } from "@/lib/marketplace/sync-run";
import { notifyAutomationResult } from "@/lib/discord-notifier";
import { getPurchaseOrders, upsertEntry } from "@/lib/purchase-orders";
import type { PurchaseOrderEntry } from "@/types/database";

export const maxDuration = 300;

interface TargetOrder {
  id: string;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number | null;
  delivery_status: string;
  claim_reason: string | null;
  claim_quantity: number | null;
  purchase_order_no: string | null;
  purchase_detail_url: string | null;
  courier: string | null;
  tracking_no: string | null;
  purchased_at: string | null;
  purchase_orders: unknown;
  /** 이번에 신청할 엔트리 (지마켓 상세링크 있음 + 아직 신청 안 함, 요청 수량만큼) */
  entries: PurchaseOrderEntry[];
  /** 이미 신청된 엔트리 수 */
  alreadyRequested: number;
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
    orderNos: string[]; entryCount: number; requestedCount: number; hasContactField?: boolean;
  }>;
  successCount?: number;
  failCount?: number;
}

const isGmarketUrl = (u: string | null | undefined) => !!u && /gmarket/i.test(u);

/** 행에서 이번에 신청할 엔트리를 고른다 — 지마켓 상세링크가 있고 아직 신청 안 한 것을 순서대로, 요청 수량(claim_quantity)만큼 */
function pickEntries(row: Omit<TargetOrder, "entries" | "alreadyRequested">): { entries: PurchaseOrderEntry[]; alreadyRequested: number } {
  const all = getPurchaseOrders({
    purchase_orders: row.purchase_orders as PurchaseOrderEntry[] | undefined,
    purchase_order_no: row.purchase_order_no,
    purchase_detail_url: row.purchase_detail_url,
    courier: row.courier,
    tracking_no: row.tracking_no,
    quantity: row.quantity ?? 1,
    purchased_at: row.purchased_at,
  }).filter((e) => isGmarketUrl(e.detail_url));
  const requested = all.filter((e) => !!e.return_requested_at);
  const need = Math.max(row.claim_quantity ?? Number.MAX_SAFE_INTEGER, 1);
  let covered = requested.reduce((s, e) => s + e.quantity, 0);
  const entries: PurchaseOrderEntry[] = [];
  for (const e of all) {
    if (e.return_requested_at) continue;
    if (covered >= need) break;
    entries.push(e);
    covered += e.quantity;
  }
  return { entries, alreadyRequested: requested.length };
}

// orderIds 가 있으면 그 주문만 (발주서에서 선택한 건), 없으면 전체 (자동화 페이지 버튼)
async function fetchTargets(userId: string, orderIds?: string[]): Promise<TargetOrder[]> {
  const sb = getServiceSupabaseClient();
  let query = sb
    .from("orders")
    .select("id, recipient_name, product_name, quantity, delivery_status, claim_reason, claim_quantity, purchase_order_no, purchase_detail_url, courier, tracking_no, purchased_at, purchase_orders")
    .eq("user_id", userId)
    .in("delivery_status", ["반품준비", "교환준비"])
    .is("purchase_return_requested_at", null);
  // 지마켓 구매 여부는 상세링크(대표 또는 목록 엔트리)로 코드에서 거른다 — 반품준비·교환준비 행은 소수라 전부 읽어도 된다
  if (orderIds && orderIds.length > 0) query = query.in("id", orderIds);
  const { data, error } = await query;
  if (error) throw new Error(`대상 조회 실패: ${error.message}`);
  const out: TargetOrder[] = [];
  for (const row of (data ?? []) as Array<Omit<TargetOrder, "entries" | "alreadyRequested">>) {
    const picked = pickEntries(row);
    if (picked.entries.length === 0) continue;
    out.push({ ...row, ...picked });
  }
  return out;
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
        claimQuantity: t.claim_quantity,
        deliveryStatus: t.delivery_status,
        claimReason: t.claim_reason,
        mappedReason: mapClaimReason(t.claim_reason),
        detailText: buildDetailText(t.claim_reason),
        needRepurchase: t.delivery_status === "교환준비",
        orderNos: t.entries.map((e) => e.order_no),
        entryCount: t.entries.length,
        bundleQuantities: t.entries.filter((e) => e.quantity > 1).map((e) => e.quantity),
        alreadyRequested: t.alreadyRequested,
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
          const label = `${t.recipient_name ?? "?"} · ${t.product_name ?? "?"}`;
          const multi = t.entries.length > 1 ? ` (주문 ${t.entries.length}건)` : "";
          send({ type: "progress", orderId: t.id, index: i + 1, total: targets.length, message: `${label}${multi} 처리 중` });

          // 엔트리마다 순서대로 신청 — 하나라도 실패하면 그 행은 실패로 보고하고, 성공한 엔트리만 기록해 다음 실행에서 이어간다
          let requestedCount = 0;
          let selectedReason = mapClaimReason(t.claim_reason) as string;
          let returnFee: string | null = null;
          let hasContactField: boolean | undefined;
          let error: string | undefined;
          let entries = getPurchaseOrders({
            purchase_orders: t.purchase_orders as PurchaseOrderEntry[] | undefined,
            purchase_order_no: t.purchase_order_no,
            purchase_detail_url: t.purchase_detail_url,
            courier: t.courier,
            tracking_no: t.tracking_no,
            quantity: t.quantity ?? 1,
            purchased_at: t.purchased_at,
          });
          for (let k = 0; k < t.entries.length; k++) {
            if (request.signal.aborted) { error = "사용자 중단"; break; }
            const e = t.entries[k];
            if (t.entries.length > 1) {
              send({ type: "progress", orderId: t.id, index: i + 1, total: targets.length, message: `${label} — 주문 ${k + 1}/${t.entries.length} (${e.order_no}) 반품신청 중` });
            }
            const r = await requestGmarketReturn(ctx, { detailUrl: e.detail_url!, claimReason: t.claim_reason, dryRun });
            selectedReason = r.selectedReason;
            if (r.returnFeeText) returnFee = returnFee ? `${returnFee}+${r.returnFeeText}` : r.returnFeeText;
            if (r.hasContactField !== undefined) hasContactField = hasContactField || r.hasContactField;
            if (!r.ok) { error = `${t.entries.length > 1 ? `주문 ${e.order_no}: ` : ""}${r.error}`; break; }
            requestedCount++;
            if (!dryRun) {
              // 엔트리 단위 신청 기록 (행 단위 플래그는 전부 끝났을 때)
              entries = upsertEntry(entries, { order_no: e.order_no, return_requested_at: new Date().toISOString() });
              const { error: entryErr } = await serviceSb.from("orders").update({ purchase_orders: entries }).eq("id", t.id).eq("user_id", userId);
              if (entryErr) console.error(`[gmarket-return] 엔트리 신청 기록 실패(${t.id} ${e.order_no}): ${entryErr.message}`);
            }
          }
          const ok = !error && requestedCount === t.entries.length;
          const row = {
            orderId: t.id, recipientName: t.recipient_name, productName: t.product_name, deliveryStatus: t.delivery_status,
            ok, selectedReason, returnFee, error, hasContactField,
            needRepurchase: t.delivery_status === "교환준비",
            orderNos: t.entries.map((e) => e.order_no), entryCount: t.entries.length, requestedCount,
          };
          results.push(row);

          if (ok && !dryRun) {
            const bundleNote = t.entries.filter((e) => e.quantity > 1).map((e) => `묶음 ${e.quantity}개`).join(", ");
            const memoLine = `구매처 반품신청(${selectedReason}${returnFee ? `, 반품비 ${returnFee} 환불차감` : ""}${t.entries.length > 1 ? `, 주문 ${t.entries.length}건` : ""}${bundleNote ? `, ${bundleNote}` : ""})`;
            const { data: cur } = await serviceSb.from("orders").select("delivery_memo").eq("id", t.id).eq("user_id", userId).maybeSingle();
            const memo = cur?.delivery_memo ? `${cur.delivery_memo} | ${memoLine}` : memoLine;
            // 반품준비 → 반품접수 로 전진 (교환준비는 상태 유지 — 교환은 재구매가 수동이라 반품 단계로 옮기지 않는다)
            const patch: Record<string, unknown> = { purchase_return_requested_at: new Date().toISOString(), delivery_memo: memo, purchase_orders: entries };
            if (t.delivery_status === "반품준비") patch.delivery_status = "반품접수";
            const { error: rowErr } = await serviceSb.from("orders")
              .update(patch)
              .eq("id", t.id).eq("user_id", userId);
            if (rowErr) console.error(`[gmarket-return] 신청 기록 실패(${t.id}): ${rowErr.message}`);
          }
          if (ok) success++; else fail++;
          const partial = !ok && requestedCount > 0 ? ` (${requestedCount}/${t.entries.length}건 신청됨)` : "";
          send({ type: "progress", orderId: t.id, index: i + 1, total: targets.length, message: ok ? `완료 (${selectedReason}${multi})` : `실패: ${error}${partial}` });
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
      const contactFieldSeen = results.some((r) => r.hasContactField === true);
      await finishSyncRun(serviceSb, runId, { status, remote_count: targets.length, confirmed: success, detail: { dryRun, contactFieldSeen, results: results.slice(0, 50) } });

      // 디스코드 보고 — 건별 수취인·상품·반품사유. 교환건은 "재구매 필요" 강조
      const reasonOf = (orderId: string) => targets.find((t) => t.id === orderId)?.claim_reason;
      const line = (r: (typeof results)[number]) => {
        const reason = reasonOf(r.orderId);
        const reasonPart = `${reason ? `"${reason}" → ` : ""}${r.selectedReason}`;
        const multi = r.entryCount > 1 ? ` [주문 ${r.entryCount}건]` : "";
        return `- ${r.recipientName ?? "?"} · ${r.productName ?? "?"}${multi} (${reasonPart})${r.needRepurchase ? " ⚠교환·재구매필요" : ""}`;
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
            ...(failures.length > 0 ? ["", "실패:", ...failures.slice(0, 10).map((r) => `${line(r)} — ${r.error}${r.requestedCount > 0 ? ` (${r.requestedCount}/${r.entryCount}건 신청됨)` : ""}`)] : []),
            ...(dryRun ? ["", `수거지 연락처 입력칸: ${contactFieldSeen ? "있음" : "없음/미확인"}`] : []),
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
