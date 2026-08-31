import type { SupabaseClient } from "@supabase/supabase-js";

export const PURCHASE_CANCEL_MODES = ["not_purchased", "purchased_cancelled"] as const;
export type PurchaseCancelMode = (typeof PURCHASE_CANCEL_MODES)[number];

export const PURCHASE_CANCEL_REASONS = [
  "품절/재고부족",
  "판매가 마이너스",
  "구매처 오류",
  "기타",
] as const;
export type PurchaseCancelReason = (typeof PURCHASE_CANCEL_REASONS)[number];

const BLOCKED_STATUSES = new Set(["배송완료", "반품완료", "교환완료"]);

type PurchaseCancelOrder = {
  id: string;
  delivery_status: string | null;
  tracking_no: string | null;
  purchase_order_no: string | null;
  purchased_at: string | null;
  payment_method: string | null;
  courier: string | null;
};

type PurchaseCancelLog = {
  id: string;
  order_id: string | null;
  status: "success" | "failed" | "cancelled";
  error_message: string | null;
};

export class PurchaseCancellationError extends Error {
  statusCode: number;
  details?: string[];

  constructor(message: string, statusCode = 400, details?: string[]) {
    super(message);
    this.name = "PurchaseCancellationError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

// 품절·역마진(구매 전)은 재구매를 막기 위해 발송불가(보류)로, 그 외에는 재구매 가능하도록 결제전으로 복귀
function getTargetStatus(mode: PurchaseCancelMode, reason: PurchaseCancelReason): string {
  return mode === "not_purchased" && (reason === "품절/재고부족" || reason === "판매가 마이너스") ? "발송불가" : "결제전";
}

function getCancellationMessage(reason: PurchaseCancelReason, mode: PurchaseCancelMode, existing: string | null): string {
  const modeLabel = mode === "not_purchased" ? "구매 전 실패" : "구매 후 취소/환불";
  const prefix = `[구매취소/정리] ${modeLabel} · ${reason}`;
  const previous = existing?.trim();
  return previous && !previous.includes(prefix) ? `${prefix} | 기존: ${previous}` : previous || prefix;
}

async function restoreLogs(
  supabase: SupabaseClient,
  userId: string,
  logs: PurchaseCancelLog[],
): Promise<void> {
  for (const log of logs) {
    await supabase
      .from("purchase_logs")
      .update({ status: log.status, error_message: log.error_message })
      .eq("id", log.id)
      .eq("user_id", userId);
  }
}

async function restoreOrder(
  supabase: SupabaseClient,
  userId: string,
  order: PurchaseCancelOrder,
): Promise<void> {
  await supabase
    .from("orders")
    .update({
      delivery_status: order.delivery_status,
      tracking_no: order.tracking_no,
      purchase_order_no: order.purchase_order_no,
      purchased_at: order.purchased_at,
      payment_method: order.payment_method,
      courier: order.courier,
    })
    .eq("id", order.id)
    .eq("user_id", userId);
}

export async function cancelPurchaseOrders(
  supabase: SupabaseClient,
  userId: string,
  orderIds: string[],
  mode: PurchaseCancelMode,
  reason: PurchaseCancelReason,
): Promise<{ processedOrderIds: string[]; targetStatus: string; cancelledLogCount: number }> {
  const ids = [...new Set(orderIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new PurchaseCancellationError("정리할 주문을 선택해주세요.");
  }
  if (ids.length > 500) {
    throw new PurchaseCancellationError("한 번에 최대 500건까지 처리할 수 있습니다.");
  }

  const { data: orders, error: orderError } = await supabase
    .from("orders")
    .select("id,delivery_status,tracking_no,purchase_order_no,purchased_at,payment_method,courier")
    .eq("user_id", userId)
    .in("id", ids);

  if (orderError) throw new PurchaseCancellationError(`주문 조회 실패: ${orderError.message}`, 500);

  const orderRows = (orders ?? []) as PurchaseCancelOrder[];
  const orderMap = new Map(orderRows.map((order) => [order.id, order]));
  const missingIds = ids.filter((id) => !orderMap.has(id));
  if (missingIds.length > 0) {
    throw new PurchaseCancellationError("일부 주문을 찾지 못해 처리를 중단했습니다.", 404, missingIds);
  }

  const blocked = orderRows
    .filter((order) => {
      const trackingNo = order.tracking_no?.trim();
      return Boolean(trackingNo) || BLOCKED_STATUSES.has(order.delivery_status ?? "");
    })
    .map((order) => `${order.id}: 배송완료·운송장 입력 주문은 정리할 수 없습니다.`);
  if (blocked.length > 0) {
    throw new PurchaseCancellationError("배송이 시작된 주문이 포함되어 처리를 중단했습니다.", 409, blocked);
  }

  const { data: logs, error: logError } = await supabase
    .from("purchase_logs")
    .select("id,order_id,status,error_message")
    .eq("user_id", userId)
    .in("order_id", ids);
  if (logError) throw new PurchaseCancellationError(`구매로그 조회 실패: ${logError.message}`, 500);

  const logsByOrderId = new Map<string, PurchaseCancelLog[]>();
  for (const log of (logs ?? []) as PurchaseCancelLog[]) {
    if (!log.order_id) continue;
    const current = logsByOrderId.get(log.order_id) ?? [];
    current.push(log);
    logsByOrderId.set(log.order_id, current);
  }

  const targetStatus = getTargetStatus(mode, reason);
  const processedOrderIds: string[] = [];
  let cancelledLogCount = 0;
  const processed: Array<{ order: PurchaseCancelOrder; logs: PurchaseCancelLog[] }> = [];
  const changedLogsByOrder = new Map<string, PurchaseCancelLog[]>();

  try {
    for (const order of orderRows) {
      const orderLogs = logsByOrderId.get(order.id) ?? [];
      const updatedLogs: PurchaseCancelLog[] = [];
      changedLogsByOrder.set(order.id, updatedLogs);

      for (const log of orderLogs) {
        const { error } = await supabase
          .from("purchase_logs")
          .update({
            status: "cancelled",
            error_message: getCancellationMessage(reason, mode, log.error_message),
          })
          .eq("id", log.id)
          .eq("user_id", userId);
        if (error) throw new PurchaseCancellationError(`구매로그 정리 실패: ${error.message}`, 500);
        updatedLogs.push(log);
      }

      // 재구매에 필요한 정산예정·원가·구매처·구매아이디·최저가링크(purchase_url)는 유지하고,
      // 실제 구매 흔적(결제방식·구매처 주문번호·구매일시·택배사·운송장)만 초기화한다.
      const { data: updatedOrder, error: updateError } = await supabase
        .from("orders")
        .update({
          delivery_status: targetStatus,
          purchase_order_no: null,
          purchased_at: null,
          payment_method: null,
          courier: null,
          tracking_no: null,
        })
        .eq("id", order.id)
        .eq("user_id", userId)
        .select("id")
        .maybeSingle();

      if (updateError || !updatedOrder) {
        throw new PurchaseCancellationError(
          `주문 구매정보 정리 실패: ${updateError?.message ?? "주문이 변경되지 않았습니다."}`,
          500,
        );
      }

      processed.push({ order, logs: updatedLogs });
      processedOrderIds.push(order.id);
      cancelledLogCount += updatedLogs.length;
    }
  } catch (error) {
    for (const [orderId, logsToRestore] of changedLogsByOrder) {
      if (!processed.some((item) => item.order.id === orderId)) {
        await restoreLogs(supabase, userId, logsToRestore);
      }
    }
    for (const item of processed) {
      await restoreOrder(supabase, userId, item.order);
      await restoreLogs(supabase, userId, item.logs);
    }
    throw error;
  }

  return { processedOrderIds, targetStatus, cancelledLogCount };
}
