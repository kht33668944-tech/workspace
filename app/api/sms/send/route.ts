import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { sendMessages, substituteTemplate } from "@/lib/solapi";
import type { Order } from "@/types/database";

export const maxDuration = 300;

interface SendRequest {
  orderIds: string[];
  templateContent: string;
  phoneField: "recipient_phone" | "orderer_phone";
}

interface SSEEvent {
  type: "progress" | "done" | "error";
  current?: number;
  total?: number;
  phone?: string;
  status?: string;
  message?: string;
  success?: number;
  failed?: number;
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const body = (await request.json()) as SendRequest;
  if (!body.orderIds || body.orderIds.length === 0) {
    return NextResponse.json({ error: "발송 대상이 없습니다." }, { status: 400 });
  }
  if (!body.templateContent?.trim()) {
    return NextResponse.json({ error: "메시지 내용이 없습니다." }, { status: 400 });
  }

  const phoneField = body.phoneField || "recipient_phone";
  const userSupabase = getSupabaseClient(token);
  const { data: { user } } = await userSupabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const serviceSupabase = getServiceSupabaseClient();
  const { data: orders, error: orderError } = await serviceSupabase
    .from("orders")
    .select("*")
    .in("id", body.orderIds)
    .eq("user_id", user.id);

  if (orderError || !orders) {
    return NextResponse.json({ error: "주문 조회 실패" }, { status: 500 });
  }

  const validOrders = (orders as Order[]).filter((o) => {
    const phone = o[phoneField];
    return phone && phone.replace(/[^0-9]/g, "").length >= 10;
  });

  if (validOrders.length === 0) {
    return NextResponse.json({ error: "유효한 전화번호가 있는 주문이 없습니다." }, { status: 400 });
  }

  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => {
    console.log("[sms-send] 클라이언트 연결 끊김 → 작업 중단");
    abortController.abort();
  });

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

      const batchId = crypto.randomUUID();
      let successCount = 0;
      let failedCount = 0;
      const total = validOrders.length;

      const messageList: Array<{ order: Order; to: string; text: string }> = [];
      for (const order of validOrders) {
        const phone = (order[phoneField] as string).replace(/[^0-9]/g, "");
        const variables: Record<string, string> = {
          recipient_name: order.recipient_name || "",
          product_name: order.product_name || "",
          quantity: String(order.quantity || 1),
          marketplace: order.marketplace || "",
          courier: order.courier || "",
          tracking_no: order.tracking_no || "",
          order_date: order.order_date ? order.order_date.slice(0, 16).replace("T", " ") : "",
          address: [order.address, order.address_detail].filter(Boolean).join(" "),
          delivery_memo: order.delivery_memo || "",
        };
        const text = substituteTemplate(body.templateContent, variables);
        messageList.push({ order, to: phone, text });
      }

      const BATCH_SIZE = 1000;
      for (let i = 0; i < messageList.length; i += BATCH_SIZE) {
        if (abortController.signal.aborted) break;

        const batch = messageList.slice(i, i + BATCH_SIZE);

        try {
          const result = await sendMessages(
            batch.map((m) => ({ to: m.to, text: m.text }))
          );

          const failedPhones = new Set(
            (result.failedMessageList || []).map((f) => f.to.replace(/[^0-9]/g, ""))
          );

          const logInserts = [];
          for (const item of batch) {
            const normalizedPhone = item.to.replace(/[^0-9]/g, "");
            const isFailed = failedPhones.has(normalizedPhone);
            const failedInfo = isFailed
              ? (result.failedMessageList || []).find(
                  (f) => f.to.replace(/[^0-9]/g, "") === normalizedPhone
                )
              : null;

            if (isFailed) {
              failedCount++;
            } else {
              successCount++;
            }

            sendEvent({
              type: "progress",
              current: successCount + failedCount,
              total,
              phone: normalizedPhone.replace(/(\d{3})(\d{4})(\d{4})/, "$1-****-$3"),
              status: isFailed ? "failed" : "success",
              message: isFailed ? (failedInfo?.statusMessage || "발송 실패") : "발송 성공",
            });

            logInserts.push({
              user_id: user.id,
              batch_id: batchId,
              order_id: item.order.id,
              phone: normalizedPhone,
              message: item.text,
              status: isFailed ? "failed" : "success",
              error_message: failedInfo?.statusMessage || null,
              message_id: isFailed ? null : (result.groupId || null),
            });
          }

          if (logInserts.length > 0) {
            await serviceSupabase.from("sms_logs").insert(logInserts);
          }
        } catch (err) {
          for (const item of batch) {
            failedCount++;
            sendEvent({
              type: "progress",
              current: successCount + failedCount,
              total,
              phone: item.to.replace(/(\d{3})(\d{4})(\d{4})/, "$1-****-$3"),
              status: "failed",
              message: err instanceof Error ? err.message : String(err),
            });
          }

          const failLogs = batch.map((item) => ({
            user_id: user.id,
            batch_id: batchId,
            order_id: item.order.id,
            phone: item.to.replace(/[^0-9]/g, ""),
            message: item.text,
            status: "failed",
            error_message: err instanceof Error ? err.message : String(err),
            message_id: null,
          }));
          await serviceSupabase.from("sms_logs").insert(failLogs);
        }
      }

      sendEvent({ type: "done", success: successCount, failed: failedCount, total });
      try { controller.close(); } catch { /* already closed */ }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
