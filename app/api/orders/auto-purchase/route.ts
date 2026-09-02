import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { purchaseGmarket } from "@/lib/scrapers/gmarket-purchase";
import { purchaseOhouse } from "@/lib/scrapers/ohouse-purchase";
import { decrypt } from "@/lib/crypto";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { purchaseDetailUrl, type PurchaseOrderInfo, type PurchasedUnit } from "@/lib/scrapers/types";
import { notifyAutomationResult } from "@/lib/discord-notifier";
import { buildPurchaseNotification, type PurchaseNotifyItem } from "@/lib/purchase-notification";
import { parsePurchaseOrders, upsertEntry } from "@/lib/purchase-orders";
import type { PurchaseOrderEntry } from "@/types/database";

export const maxDuration = 300;

interface AutoPurchaseRequest {
  credentialId?: string;
  loginId?: string;
  loginPw?: string;
  platform?: "gmarket" | "auction" | "ohouse";
  paymentPin?: string;
  batchId?: string;
  // 여러 계정(그룹)을 나눠 호출할 때 개별 디스코드 발송을 억제하고, 클라이언트가 마지막에 1회만 발송 (기본 true)
  notify?: boolean;
  // 회당 결제 한도 계산 시 허용 적자(원). 미전송 시 0 — 서버가 DB 정산예정금액으로 한도를 직접 계산해 주입한다
  allowedDeficit?: number;
  orders: PurchaseOrderInfo[];
}

// SSE 이벤트 타입
interface SSEEvent {
  type: "progress" | "db_updated" | "done" | "error" | "cancelled";
  orderId?: string;
  status?: string;
  message?: string;
  purchaseOrderNo?: string;
  cost?: number;
  paymentMethod?: string;
  // 수량 2개 이상 주문의 진행/부분구매 개수 (예: 3개 중 1개만 구매됨)
  purchasedCount?: number;
  totalQty?: number;
  // units = 수량 루프별 결제 내역 (카드사별 집계용) — 합산 알림을 만드는 모달·크론 스테이지가 읽는다
  success?: { orderId: string; purchaseOrderNo: string; cost?: number; paymentMethod?: string; payNo?: string; units?: PurchasedUnit[] }[];
  failed?: { orderId: string; reason: string; purchaseOrderNo?: string; cost?: number; paymentMethod?: string; payNo?: string; units?: PurchasedUnit[] }[];
  successCount?: number;
  failCount?: number;
}

/** 알림 건별 표시에 필요한 발주서 메타 (판매처·정산예정 등) — 구매 전 상태 확인 쿼리에서 채운다 */
interface OrderMeta {
  marketplace: string | null;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number | null;
  settlement: number | null;
}

export async function POST(request: NextRequest) {
  try {
    const token = getAccessToken(request);
    if (!token) {
      return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    }

    const userSupabase = getSupabaseClient(token);
    const {
      data: { user },
      error: userError,
    } = await userSupabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    }

    const userId = user.id;
    const body = (await request.json()) as AutoPurchaseRequest;

    if (!body.orders || body.orders.length === 0) {
      return NextResponse.json({ error: "구매할 주문이 없습니다." }, { status: 400 });
    }

    let platform: string;
    let loginId: string;
    let loginPw: string;

    if (body.credentialId) {
      const { data: cred, error } = await userSupabase
        .from("purchase_credentials")
        .select("platform, login_id, login_pw_encrypted")
        .eq("id", body.credentialId)
        .eq("user_id", userId)
        .single();

      if (error || !cred) {
        return NextResponse.json({ error: "등록된 계정을 찾을 수 없습니다." }, { status: 404 });
      }

      platform = cred.platform;
      loginId = cred.login_id;
      loginPw = decrypt(cred.login_pw_encrypted);
    } else {
      if (!body.platform || !body.loginId || !body.loginPw) {
        return NextResponse.json({ error: "계정 정보가 필요합니다." }, { status: 400 });
      }
      platform = body.platform;
      loginId = body.loginId;
      loginPw = body.loginPw;
    }

    if ((platform === "gmarket" || platform === "ohouse") && (!body.paymentPin || body.paymentPin.length !== 6)) {
      return NextResponse.json({ error: "결제 비밀번호 6자리가 필요합니다." }, { status: 400 });
    }
    if (platform !== "gmarket" && platform !== "ohouse") {
      return NextResponse.json({ error: `${platform}은(는) 아직 자동구매를 지원하지 않습니다.` }, { status: 400 });
    }

    // 오늘의집: 네이버페이 결제를 위한 스마트스토어(네이버) 계정 조회
    let naverLoginId: string | undefined;
    let naverLoginPw: string | undefined;
    if (platform === "ohouse") {
      // smartstore 플랫폼으로 등록된 계정 중 첫 번째 사용
      const { data: naverCred } = await userSupabase
        .from("purchase_credentials")
        .select("login_id, login_pw_encrypted")
        .eq("platform", "smartstore")
        .eq("user_id", userId)
        .limit(1)
        .single();

      if (naverCred) {
        naverLoginId = naverCred.login_id;
        naverLoginPw = decrypt(naverCred.login_pw_encrypted);
        console.log(`[auto-purchase] 네이버 계정 로드: ${naverLoginId}`);
      } else {
        console.log("[auto-purchase] 스마트스토어(네이버) 계정 미등록 — 로그인 필요 시 실패할 수 있음");
      }
    }

    // SSE 스트림 생성
    const abortController = new AbortController();
    const { signal } = abortController;

    // 클라이언트 연결 끊김 감지
    const onAbort = () => {
      console.log("[auto-purchase] 클라이언트 연결 끊김 → 작업 중단");
      abortController.abort();
    };
    request.signal.addEventListener("abort", onAbort);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function sendEvent(event: SSEEvent) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // stream already closed
          }
        }

        // service_role 클라이언트 사용 (JWT 만료와 무관하게 동작)
        const supabase = getServiceSupabaseClient();
        const batchId = body.batchId || crypto.randomUUID();
        const allSuccess: SSEEvent["success"] = [];
        const allFailed: SSEEvent["failed"] = [];
        let targetOrders = body.orders;
        const purchaseLockStatus = "구매진행중";
        const purchaseReviewStatus = "구매확인필요";
        const lockedOrderIds = new Set<string>();
        const lockReleaseStatusByOrderId = new Map<string, string>();
        const loggedFailureOrderIds = new Set<string>();
        const completedCallbackOrderIds = new Set<string>();
        const orderMetaById = new Map<string, OrderMeta>();

        // 디스코드 알림 — 수동 모달·크론 스테이지와 같은 건별 포맷 (notify:false 면 호출측이 합산 발송)
        const toNotifyItem = (e: NonNullable<SSEEvent["failed"]>[number] | NonNullable<SSEEvent["success"]>[number]): PurchaseNotifyItem => {
          const info = body.orders.find((o) => o.orderId === e.orderId);
          const meta = orderMetaById.get(e.orderId);
          return {
            marketplace: meta?.marketplace ?? null,
            recipientName: info?.recipientName || meta?.recipient_name || null,
            productName: info?.productName || meta?.product_name || null,
            quantity: info?.quantity ?? meta?.quantity ?? 1,
            settlement: meta?.settlement ?? null,
            cost: e.cost,
            paymentMethod: e.paymentMethod,
            units: e.units,
            purchaseOrderNo: e.purchaseOrderNo,
            reason: "reason" in e ? e.reason : undefined,
          };
        };
        const sendPurchaseNotify = async (opts: { cancelled?: boolean; headline?: string; errors?: string[] } = {}) => {
          if (body.notify === false) return;
          await notifyAutomationResult(buildPurchaseNotification({
            trigger: "manual",
            cancelled: opts.cancelled,
            headline: opts.headline,
            errors: opts.errors,
            success: allSuccess.map(toNotifyItem),
            failed: allFailed.map(toNotifyItem),
          }));
        };

        // 주문별 즉시 DB 업데이트 + SSE 전송 콜백
        const onProgress = (
          orderId: string,
          status: "processing" | "success" | "failed" | "waiting_payment",
          message: string,
          purchaseOrderNo?: string,
          counts?: { purchased: number; total: number }
        ) => {
          sendEvent({
            type: "progress",
            orderId,
            status,
            message,
            purchaseOrderNo,
            purchasedCount: counts?.purchased,
            totalQty: counts?.total,
          });
        };

        const loadLoggedPurchaseNos = async (orderIds: string[]) => {
          const map = new Map<string, string[]>();
          if (orderIds.length === 0) return map;

          const { data, error } = await supabase
            .from("purchase_logs")
            .select("order_id, purchase_order_no")
            .in("order_id", orderIds)
            .eq("user_id", userId)
            .eq("status", "success")
            .not("purchase_order_no", "is", null)
            .neq("purchase_order_no", "");

          if (error) {
            console.error("[auto-purchase] 구매 로그 중복 확인 실패:", error.message);
            return map;
          }

          for (const row of data || []) {
            const orderId = row.order_id as string | null;
            const purchaseNo = typeof row.purchase_order_no === "string" ? row.purchase_order_no.trim() : "";
            if (!orderId || !purchaseNo) continue;
            const current = map.get(orderId) ?? [];
            if (!current.includes(purchaseNo)) current.push(purchaseNo);
            map.set(orderId, current);
          }

          return map;
        };

        const assertOrderStillLockedForPurchase = async (orderId: string) => {
          const query = supabase
            .from("orders")
            .select("id, purchase_order_no, delivery_status, quantity")
            .eq("id", orderId)
            .eq("user_id", userId);

          const { data: order, error } = await query.maybeSingle();
          if (error) throw new Error(`구매 직전 주문 상태 확인 실패: ${error.message}`);
          if (!order) throw new Error("주문을 찾을 수 없어 자동구매를 중단했습니다.");

          const existingPurchaseNo = typeof order.purchase_order_no === "string"
            ? order.purchase_order_no.trim()
            : "";
          if (existingPurchaseNo) {
            throw new Error(`이미 구매번호(${existingPurchaseNo})가 저장된 주문이라 재구매를 중단했습니다.`);
          }
          if (order.delivery_status !== purchaseLockStatus) {
            throw new Error(`주문 상태가 '${order.delivery_status}'로 변경되어 재구매를 중단했습니다.`);
          }

          const loggedNos = (await loadLoggedPurchaseNos([orderId])).get(orderId) ?? [];
          const expectedQty = Math.max(Number(order.quantity) || 1, 1);
          if (loggedNos.length >= expectedQty) {
            throw new Error(`구매 로그에 이미 구매번호(${loggedNos.join(", ")})가 있어 재구매를 중단했습니다.`);
          }
        };

        // 단위 구매(결제 1건) → purchase_orders 엔트리
        const unitToEntry = (unit: PurchasedUnit, purchasedAt: string): PurchaseOrderEntry => ({
          order_no: unit.orderNo,
          pay_no: unit.payNo ?? null,
          detail_url: purchaseDetailUrl(platform, unit.orderNo, unit.payNo),
          quantity: 1,
          purchased_at: purchasedAt,
          source: "auto",
        });

        // 단위 구매마다 purchase_logs 에 기록한 주문번호 (완료 시 중복 기록 방지)
        const unitLoggedNos = new Map<string, Set<string>>();

        const insertPurchaseLog = async (orderId: string, unit: PurchasedUnit, status: "success" | "failed", errorMessage?: string) => {
          const orderInfo = body.orders.find(o => o.orderId === orderId);
          const { error: logErr } = await supabase.from("purchase_logs").insert({
            user_id: userId,
            batch_id: batchId,
            order_id: orderId,
            platform,
            login_id: loginId,
            status,
            purchase_order_no: unit.orderNo,
            cost: unit.cost ?? null,
            payment_method: unit.paymentMethod ?? null,
            error_message: errorMessage ?? null,
            product_name: orderInfo?.productName ?? null,
            recipient_name: orderInfo?.recipientName ?? null,
          });
          if (logErr) console.error(`[auto-purchase] 구매 로그 기록 실패 (${orderId} ${unit.orderNo}):`, logErr.message);
          else if (status === "success") {
            const set = unitLoggedNos.get(orderId) ?? new Set<string>();
            set.add(unit.orderNo);
            unitLoggedNos.set(orderId, set);
          }
        };

        // 단위 구매가 끝날 때마다 purchase_orders 에 누적 — 중간 실패(부분구매)에도 산 만큼은 남긴다.
        // 대표 컬럼(purchase_order_no 등)은 건드리지 않으므로 기존 잠금 조건(purchase_order_no 비어 있음)과 충돌하지 않는다.
        const onUnitPurchased = async (orderId: string, unit: PurchasedUnit, index: number, total: number) => {
          const { data: cur, error: readErr } = await supabase
            .from("orders")
            .select("purchase_orders, delivery_status")
            .eq("id", orderId)
            .eq("user_id", userId)
            .maybeSingle();
          if (readErr || !cur) {
            console.warn(`[auto-purchase] 단위 구매 누적 실패 — 주문 조회 불가 (${orderId} ${index}/${total}):`, readErr?.message ?? "없음");
          } else if (cur.delivery_status !== purchaseLockStatus) {
            console.warn(`[auto-purchase] 단위 구매 누적 건너뜀 — 상태 '${cur.delivery_status}' (${orderId} ${index}/${total}, ${unit.orderNo})`);
          } else {
            const entries = upsertEntry(parsePurchaseOrders(cur.purchase_orders), unitToEntry(unit, new Date().toISOString()));
            const { error: upErr } = await supabase
              .from("orders")
              .update({ purchase_orders: entries })
              .eq("id", orderId)
              .eq("user_id", userId)
              .eq("delivery_status", purchaseLockStatus);
            if (upErr) console.error(`[auto-purchase] 단위 구매 누적 실패 (${orderId} ${index}/${total}):`, upErr.message);
            else console.log(`[auto-purchase] 단위 구매 누적 (${orderId} ${index}/${total}): ${unit.orderNo}`);
          }
          await insertPurchaseLog(orderId, unit, "success");
        };

        // 성공 시 즉시 DB 업데이트하는 콜백
        const onOrderComplete = async (
          orderId: string,
          purchaseOrderNo: string,
          cost?: number,
          paymentMethod?: string,
          payNo?: string,
          units?: PurchasedUnit[]
        ) => {
          completedCallbackOrderIds.add(orderId);

          // 즉시 DB 업데이트
          const updateData: Record<string, unknown> = {
            purchase_order_no: purchaseOrderNo,
            delivery_status: "배송준비",
          };
          if (cost !== undefined) updateData.cost = cost;
          if (paymentMethod) updateData.payment_method = paymentMethod;

          const existingQuery = supabase
            .from("orders")
            .select("purchased_at, purchase_order_no, delivery_status")
            .eq("id", orderId)
            .eq("user_id", userId);
          const { data: existingOrder } = await existingQuery.maybeSingle();
          if (!existingOrder?.purchased_at) updateData.purchased_at = new Date().toISOString();

          const existingPurchaseNo = typeof existingOrder?.purchase_order_no === "string"
            ? existingOrder.purchase_order_no.trim()
            : "";
          const orderInfo = body.orders.find(o => o.orderId === orderId);

          const recordBlockedPurchase = async (reason: string) => {
            allFailed.push({ orderId, reason, purchaseOrderNo, cost, paymentMethod, payNo, units });
            loggedFailureOrderIds.add(orderId);
            sendEvent({ type: "progress", orderId, status: "failed", message: reason, purchaseOrderNo });
            sendEvent({ type: "db_updated", orderId, status: "error", message: reason, purchaseOrderNo, cost, paymentMethod });

            const reviewQuery = supabase
              .from("orders")
              .update({ delivery_status: purchaseReviewStatus })
              .eq("id", orderId)
              .eq("user_id", userId)
              .eq("delivery_status", purchaseLockStatus)
              .or("purchase_order_no.is.null,purchase_order_no.eq.");
            await reviewQuery.then(({ error: reviewErr }) => {
              if (reviewErr) console.error(`[auto-purchase] 구매확인필요 전환 실패 (${orderId}):`, reviewErr.message);
            });

            await supabase.from("purchase_logs").insert({
              user_id: userId,
              batch_id: batchId,
              order_id: orderId,
              platform,
              login_id: loginId,
              status: "failed",
              purchase_order_no: purchaseOrderNo,
              cost: cost ?? null,
              payment_method: paymentMethod ?? null,
              error_message: reason,
              product_name: orderInfo?.productName ?? null,
              recipient_name: orderInfo?.recipientName ?? null,
            }).then(({ error: logErr }) => {
              if (logErr) console.error(`[auto-purchase] 중복위험 로그 기록 실패 (${orderId}):`, logErr.message);
            });
          };

          if (existingPurchaseNo) {
            await recordBlockedPurchase(`구매는 완료됐지만 DB에 이미 다른 구매번호(${existingPurchaseNo})가 있어 새 구매번호(${purchaseOrderNo})를 자동 반영하지 않았습니다. 실제 구매내역 확인이 필요합니다.`);
            return;
          }
          if (existingOrder?.delivery_status !== purchaseLockStatus) {
            await recordBlockedPurchase(`구매는 완료됐지만 주문 상태가 '${existingOrder?.delivery_status ?? "없음"}'로 변경되어 새 구매번호(${purchaseOrderNo})를 자동 반영하지 않았습니다. 실제 구매내역 확인이 필요합니다.`);
            return;
          }

          const updateQuery = supabase
            .from("orders")
            .update(updateData)
            .eq("id", orderId)
            .eq("user_id", userId)
            .eq("delivery_status", purchaseLockStatus)
            .or("purchase_order_no.is.null,purchase_order_no.eq.")
            .select("id");
          const { data: updatedRows, error } = await updateQuery;

          if (error) {
            console.error(`[auto-purchase] DB 업데이트 실패 (${orderId}):`, error.message);
            await recordBlockedPurchase(`구매는 완료됐지만 DB 업데이트에 실패했습니다: ${error.message}. 실제 구매내역 확인이 필요합니다.`);
            return;
          }
          if (!updatedRows || updatedRows.length !== 1) {
            await recordBlockedPurchase(`구매는 완료됐지만 다른 작업이 먼저 주문을 변경해 새 구매번호(${purchaseOrderNo})를 자동 반영하지 않았습니다. 실제 구매내역 확인이 필요합니다.`);
            return;
          }

          allSuccess.push({ orderId, purchaseOrderNo, cost, paymentMethod, payNo, units });
          console.log(`[auto-purchase] DB 즉시 업데이트 성공 (${orderId}): ${JSON.stringify(updateData)}`);
          sendEvent({ type: "db_updated", orderId, status: "ok", purchaseOrderNo, cost, paymentMethod });

          // 구매 주문 목록 + 대표 상세링크 — 컬럼 미적용 환경에서도 구매번호 저장이 깨지지 않게 별도 갱신.
          // 단위 콜백이 누락됐어도 완료 시점의 units 전체로 다시 써서 보정한다.
          const purchasedAt = (updateData.purchased_at as string | undefined) ?? existingOrder?.purchased_at ?? new Date().toISOString();
          const finalUnits: PurchasedUnit[] = units && units.length > 0 ? units : [{ orderNo: purchaseOrderNo, payNo, cost, paymentMethod }];
          const entries = finalUnits.map((u) => unitToEntry(u, purchasedAt));
          const detailUrl = entries[0]?.detail_url ?? null;
          await supabase.from("orders").update({ purchase_orders: entries, purchase_detail_url: detailUrl })
            .eq("id", orderId).eq("user_id", userId)
            .then(({ error: urlErr }) => {
              if (urlErr) console.error(`[auto-purchase] 구매 주문 목록/상세링크 저장 실패 (${orderId}):`, urlErr.message);
            });

          // 구매 로그 기록 — 단위 콜백에서 이미 기록한 주문번호는 건너뛴다
          const logged = unitLoggedNos.get(orderId) ?? new Set<string>();
          for (const u of finalUnits) {
            if (logged.has(u.orderNo)) continue;
            await insertPurchaseLog(orderId, units && units.length > 0 ? u : { ...u, cost }, "success");
          }
        };

        const releasePurchaseLock = async (orderId: string) => {
          if (!lockedOrderIds.has(orderId)) return;
          const restoreStatus = lockReleaseStatusByOrderId.get(orderId) || "구매대기";

          const releaseQuery = supabase
            .from("orders")
            .update({ delivery_status: restoreStatus })
            .eq("id", orderId)
            .eq("user_id", userId)
            .eq("delivery_status", purchaseLockStatus)
            .or("purchase_order_no.is.null,purchase_order_no.eq.");

          const { error: releaseErr } = await releaseQuery;
          if (releaseErr) {
            console.error(`[auto-purchase] 구매 잠금 해제 실패 (${orderId}):`, releaseErr.message);
          } else {
            lockedOrderIds.delete(orderId);
            lockReleaseStatusByOrderId.delete(orderId);
          }
        };

        try {
          // 최종 안전장치: UI가 오래된 주문 스냅샷을 보내도, 서버에서 DB를 다시 확인해
          // 이미 구매번호가 있는 주문은 외부 결제 단계로 넘기지 않는다.
          const seenRequestOrderIds = new Set<string>();
          const duplicatedInRequest: PurchaseOrderInfo[] = [];
          targetOrders = body.orders.filter((order) => {
            if (seenRequestOrderIds.has(order.orderId)) {
              duplicatedInRequest.push(order);
              return false;
            }
            seenRequestOrderIds.add(order.orderId);
            return true;
          });

          for (const order of duplicatedInRequest) {
            const reason = "같은 자동구매 요청 안에 동일 주문이 중복 포함되어 자동구매를 차단했습니다.";
            allFailed.push({ orderId: order.orderId, reason });
            sendEvent({ type: "progress", orderId: order.orderId, status: "failed", message: reason });
            await supabase.from("purchase_logs").insert({
              user_id: userId,
              batch_id: batchId,
              order_id: order.orderId,
              platform,
              login_id: loginId,
              status: "failed",
              purchase_order_no: null,
              cost: null,
              payment_method: null,
              error_message: reason,
              product_name: order.productName ?? null,
              recipient_name: order.recipientName ?? null,
            }).then(({ error: logErr }) => {
              if (logErr) console.error(`[auto-purchase] 중복요청 차단 로그 기록 실패 (${order.orderId}):`, logErr.message);
            });
            loggedFailureOrderIds.add(order.orderId);
          }

          if (targetOrders.length > 0) {
            const orderStateQuery = supabase
              .from("orders")
              .select("id, purchase_order_no, delivery_status, quantity, settlement, marketplace, recipient_name, product_name")
              .in("id", targetOrders.map((order) => order.orderId))
              .eq("user_id", userId);
            const { data: currentOrders, error: currentOrdersErr } = await orderStateQuery;

            if (currentOrdersErr) {
              throw new Error(`구매 전 주문 상태 확인 실패: ${currentOrdersErr.message}`);
            }
            for (const row of currentOrders || []) {
              orderMetaById.set(row.id as string, {
                marketplace: (row.marketplace as string | null) ?? null,
                recipient_name: (row.recipient_name as string | null) ?? null,
                product_name: (row.product_name as string | null) ?? null,
                quantity: (row.quantity as number | null) ?? null,
                settlement: (row.settlement as number | null) ?? null,
              });
            }

            const currentOrderById = new Map((currentOrders || []).map((order) => [order.id as string, order]));
            const loggedPurchaseNosByOrderId = await loadLoggedPurchaseNos(targetOrders.map((order) => order.orderId));
            const lockableOrders = targetOrders.filter((order) => {
              const currentOrder = currentOrderById.get(order.orderId);
              const existingPurchaseNo = typeof currentOrder?.purchase_order_no === "string"
                ? currentOrder.purchase_order_no.trim()
                : "";
              const loggedPurchaseNos = loggedPurchaseNosByOrderId.get(order.orderId) ?? [];
              const expectedQty = Math.max(Number(currentOrder?.quantity) || 1, 1);
              let reason: string | null = null;

              if (!currentOrder) {
                reason = "주문을 찾을 수 없어 자동구매를 차단했습니다.";
              } else if (existingPurchaseNo) {
                reason = `이미 구매번호(${existingPurchaseNo})가 있는 주문이라 자동구매를 차단했습니다.`;
              } else if (loggedPurchaseNos.length >= expectedQty) {
                reason = `구매 로그에 이미 구매번호(${loggedPurchaseNos.join(", ")})가 있어 자동구매를 차단했습니다.`;
              } else if (currentOrder.delivery_status !== "구매대기") {
                reason = currentOrder.delivery_status === purchaseLockStatus
                  ? "이미 다른 자동구매 작업이 진행 중인 주문이라 차단했습니다."
                  : `현재 상태가 '${currentOrder.delivery_status}'인 주문이라 자동구매를 차단했습니다. 구매대기 상태만 구매할 수 있습니다.`;
              }

              if (!reason) return true;

              allFailed.push({ orderId: order.orderId, reason });
              sendEvent({ type: "progress", orderId: order.orderId, status: "failed", message: reason });
              void supabase.from("purchase_logs").insert({
                user_id: userId,
                batch_id: batchId,
                order_id: order.orderId,
                platform,
                login_id: loginId,
                status: "failed",
                purchase_order_no: null,
                cost: null,
                payment_method: null,
                error_message: reason,
                product_name: order.productName ?? null,
                recipient_name: order.recipientName ?? null,
              }).then(({ error: logErr }) => {
                if (logErr) console.error(`[auto-purchase] 사전차단 로그 기록 실패 (${order.orderId}):`, logErr.message);
              });
              loggedFailureOrderIds.add(order.orderId);
              return false;
            });

            const lockedOrders: PurchaseOrderInfo[] = [];
            for (const order of lockableOrders) {
              const lockQuery = supabase
                .from("orders")
                .update({ delivery_status: purchaseLockStatus })
                .eq("id", order.orderId)
                .eq("user_id", userId)
                .eq("delivery_status", "구매대기")
                .or("purchase_order_no.is.null,purchase_order_no.eq.")
                .select("id");

              const { data: lockedRows, error: lockErr } = await lockQuery;
              if (lockErr) {
                throw new Error(`구매 잠금 실패 (${order.recipientName}): ${lockErr.message}`);
              }

              if (lockedRows && lockedRows.length === 1) {
                lockedOrderIds.add(order.orderId);
                lockReleaseStatusByOrderId.set(order.orderId, purchaseReviewStatus);

                // 회당 결제 한도를 서버에서 직접 계산해 주입 (오래된 클라이언트 번들이
                // maxPaymentPerUnit 없이 보내도 한도 검사가 누락되지 않도록 하는 안전장치)
                const allowedDeficit = Math.max(0, Math.floor(Number(body.allowedDeficit) || 0));
                const currentOrder = currentOrderById.get(order.orderId);
                const settlement = Number(currentOrder?.settlement) || 0;
                const qty = Math.max(Number(currentOrder?.quantity) || 1, 1);
                const serverLimit = settlement > 0 ? Math.floor(settlement / qty) + allowedDeficit : undefined;
                const clientLimit = typeof order.maxPaymentPerUnit === "number" ? order.maxPaymentPerUnit : undefined;
                const maxPaymentPerUnit = serverLimit !== undefined && clientLimit !== undefined
                  ? Math.min(serverLimit, clientLimit)
                  : serverLimit ?? clientLimit;

                if (maxPaymentPerUnit !== undefined && clientLimit === undefined) {
                  console.log(`[auto-purchase] 회당 결제 한도 서버 주입 (${order.orderId}): ${maxPaymentPerUnit}원 (정산 ${settlement} ÷ ${qty} + 허용적자 ${allowedDeficit})`);
                }

                lockedOrders.push({
                  ...order,
                  ...(maxPaymentPerUnit !== undefined && { maxPaymentPerUnit }),
                });
              } else {
                const reason = "다른 작업이 먼저 주문 상태를 변경해 자동구매를 차단했습니다.";
                allFailed.push({ orderId: order.orderId, reason });
                sendEvent({ type: "progress", orderId: order.orderId, status: "failed", message: reason });
                await supabase.from("purchase_logs").insert({
                  user_id: userId,
                  batch_id: batchId,
                  order_id: order.orderId,
                  platform,
                  login_id: loginId,
                  status: "failed",
                  purchase_order_no: null,
                  cost: null,
                  payment_method: null,
                  error_message: reason,
                  product_name: order.productName ?? null,
                  recipient_name: order.recipientName ?? null,
                }).then(({ error: logErr }) => {
                  if (logErr) console.error(`[auto-purchase] 잠금경합 차단 로그 기록 실패 (${order.orderId}):`, logErr.message);
                });
                loggedFailureOrderIds.add(order.orderId);
              }
            }
            targetOrders = lockedOrders;
          }

          if (targetOrders.length === 0) {
            sendEvent({
              type: "done",
              success: allSuccess,
              failed: allFailed,
              successCount: allSuccess.length,
              failCount: allFailed.length,
              message: "구매 가능한 주문이 없습니다. 이미 구매된 주문은 자동구매에서 제외했습니다.",
            });
            await sendPurchaseNotify({ headline: "구매 가능한 주문이 없어 작업이 종료됐습니다." });
            return;
          }

          await browserPool.acquire();
          let result;
          try {
            if (platform === "gmarket") {
              result = await purchaseGmarket(loginId, loginPw, body.paymentPin!, targetOrders, onProgress, signal, onOrderComplete, (order) => assertOrderStillLockedForPurchase(order.orderId), onUnitPurchased);
            } else {
              result = await purchaseOhouse(loginId, loginPw, targetOrders, onProgress, supabase, signal, body.paymentPin, naverLoginId, naverLoginPw, onUnitPurchased);
            }
          } finally {
            browserPool.release();
          }

          // 성공한 주문 즉시 DB 업데이트 (스크래퍼에서 콜백 안 탄 경우 대비)
          for (const s of result.success) {
            if (!completedCallbackOrderIds.has(s.orderId)) {
              await onOrderComplete(s.orderId, s.purchaseOrderNo, s.cost, s.paymentMethod, s.payNo, s.units);
            }
          }

          for (const f of result.failed) {
            if (!allFailed.some(a => a.orderId === f.orderId)) {
              allFailed.push(f);
            }
          }

          // 실패/취소 건 구매 로그 기록
          for (const f of allFailed) {
            const orderInfo = body.orders.find(o => o.orderId === f.orderId);
            if (f.purchaseOrderNo && !signal.aborted && !loggedFailureOrderIds.has(f.orderId)) {
              const partialUpdate: Record<string, unknown> = {
                purchase_order_no: f.purchaseOrderNo,
                delivery_status: "부분구매",
              };
              if (f.cost !== undefined) partialUpdate.cost = f.cost;
              if (f.paymentMethod) partialUpdate.payment_method = f.paymentMethod;

              const existingPartialQuery = supabase
                .from("orders")
                .select("purchased_at, purchase_order_no, delivery_status")
                .eq("id", f.orderId)
                .eq("user_id", userId);
              const { data: existingPartialOrder } = await existingPartialQuery.maybeSingle();
              if (!existingPartialOrder?.purchased_at) partialUpdate.purchased_at = new Date().toISOString();

              const existingPartialPurchaseNo = typeof existingPartialOrder?.purchase_order_no === "string"
                ? existingPartialOrder.purchase_order_no.trim()
                : "";

              if (existingPartialPurchaseNo || existingPartialOrder?.delivery_status !== purchaseLockStatus) {
                sendEvent({
                  type: "db_updated",
                  orderId: f.orderId,
                  status: "error",
                  message: existingPartialPurchaseNo
                    ? `이미 구매번호(${existingPartialPurchaseNo})가 있어 부분구매 번호(${f.purchaseOrderNo})를 자동 반영하지 않았습니다.`
                    : `주문 상태가 '${existingPartialOrder?.delivery_status ?? "없음"}'로 변경되어 부분구매 번호(${f.purchaseOrderNo})를 자동 반영하지 않았습니다.`,
                  purchaseOrderNo: f.purchaseOrderNo,
                  cost: f.cost,
                  paymentMethod: f.paymentMethod,
                });
              } else {
                const partialQuery = supabase
                  .from("orders")
                  .update(partialUpdate)
                  .eq("id", f.orderId)
                  .eq("user_id", userId)
                  .eq("delivery_status", purchaseLockStatus)
                  .or("purchase_order_no.is.null,purchase_order_no.eq.")
                  .select("id");
                const { data: partialRows, error: partialErr } = await partialQuery;
                if (partialErr) {
                  console.error(`[auto-purchase] 부분구매 DB 업데이트 실패 (${f.orderId}):`, partialErr.message);
                } else if (!partialRows || partialRows.length !== 1) {
                  sendEvent({
                    type: "db_updated",
                    orderId: f.orderId,
                    status: "error",
                    message: `다른 작업이 먼저 주문을 변경해 부분구매 번호(${f.purchaseOrderNo})를 자동 반영하지 않았습니다.`,
                    purchaseOrderNo: f.purchaseOrderNo,
                    cost: f.cost,
                    paymentMethod: f.paymentMethod,
                  });
                } else {
                  sendEvent({
                    type: "db_updated",
                    orderId: f.orderId,
                    status: "partial",
                    purchaseOrderNo: f.purchaseOrderNo,
                    cost: f.cost,
                    paymentMethod: f.paymentMethod,
                  });
                  // 부분구매도 구매 주문 목록·상세링크를 남긴다 (반품/운송장 수집이 산 만큼 찾을 수 있게)
                  const partialAt = (partialUpdate.purchased_at as string | undefined) ?? existingPartialOrder?.purchased_at ?? new Date().toISOString();
                  const partialUnits: PurchasedUnit[] = f.units && f.units.length > 0 ? f.units : [{ orderNo: f.purchaseOrderNo, payNo: f.payNo, cost: f.cost, paymentMethod: f.paymentMethod }];
                  const partialEntries = partialUnits.map((u) => unitToEntry(u, partialAt));
                  await supabase.from("orders")
                    .update({ purchase_orders: partialEntries, purchase_detail_url: partialEntries[0]?.detail_url ?? null })
                    .eq("id", f.orderId).eq("user_id", userId)
                    .then(({ error: urlErr }) => {
                      if (urlErr) console.error(`[auto-purchase] 부분구매 주문 목록 저장 실패 (${f.orderId}):`, urlErr.message);
                    });
                }
            }

            }
            if (!loggedFailureOrderIds.has(f.orderId)) {
              await supabase.from("purchase_logs").insert({
                user_id: userId,
                batch_id: batchId,
                order_id: f.orderId,
                platform,
                login_id: loginId,
                status: signal.aborted ? "cancelled" : "failed",
                purchase_order_no: f.purchaseOrderNo ?? null,
                cost: f.cost ?? null,
                payment_method: f.paymentMethod ?? null,
                error_message: f.reason,
                product_name: orderInfo?.productName ?? null,
                recipient_name: orderInfo?.recipientName ?? null,
              }).then(({ error: logErr }) => {
                if (logErr) console.error(`[auto-purchase] 실패 로그 기록 실패 (${f.orderId}):`, logErr.message);
              });
              loggedFailureOrderIds.add(f.orderId);
            }

            if (!f.purchaseOrderNo) {
              await releasePurchaseLock(f.orderId);
            }
          }

          const isCancelled = signal.aborted;
          sendEvent({
            type: isCancelled ? "cancelled" : "done",
            success: allSuccess,
            failed: allFailed,
            successCount: allSuccess.length,
            failCount: allFailed.length,
            message: isCancelled ? "사용자가 작업을 중단했습니다." : undefined,
          });
          await sendPurchaseNotify({ cancelled: isCancelled });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // abort 에러는 cancelled로 처리
          if (signal.aborted || msg.includes("abort")) {
            sendEvent({
              type: "cancelled",
              success: allSuccess,
              failed: allFailed,
              successCount: allSuccess.length,
              failCount: allFailed.length,
              message: "사용자가 작업을 중단했습니다.",
            });
            await sendPurchaseNotify({ cancelled: true });
          } else {
            sendEvent({ type: "error", message: `서버 오류: ${msg}` });
            await sendPurchaseNotify({ errors: [`서버 오류: ${msg}`] });
          }
        } finally {
          const purchasedOrderIds = new Set([
            ...allSuccess.map((success) => success.orderId),
            ...allFailed.filter((failed) => failed.purchaseOrderNo).map((failed) => failed.orderId),
          ]);
          for (const orderId of [...lockedOrderIds]) {
            if (!purchasedOrderIds.has(orderId)) {
              await releasePurchaseLock(orderId);
            }
          }
          request.signal.removeEventListener("abort", onAbort);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
