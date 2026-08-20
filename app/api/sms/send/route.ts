import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import { sendMessages, substituteTemplate } from "@/lib/solapi";
import { sendGatewayMessage, checkGatewayOnline } from "@/lib/sms-gateway";
import { formatKoreanDateTime } from "@/lib/date-utils";
import type { Order } from "@/types/database";
import { countTodayPhoneSms, SMS_DAILY_LIMIT } from "@/lib/sms-daily-limit";

export const maxDuration = 300;

interface SendRequest {
  orderIds: string[];
  templateContent: string;
  phoneField: "recipient_phone" | "orderer_phone";
  provider?: "solapi" | "phone";
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

  let body: SendRequest;
  try {
    body = (await request.json()) as SendRequest;
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }
  if (!body.orderIds || body.orderIds.length === 0) {
    return NextResponse.json({ error: "발송 대상이 없습니다." }, { status: 400 });
  }
  if (!body.templateContent?.trim()) {
    return NextResponse.json({ error: "메시지 내용이 없습니다." }, { status: 400 });
  }

  const phoneField = body.phoneField || "recipient_phone";
  const provider = body.provider || "phone";
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

  // ── KT 일일 한도 검사 (휴대폰 경로만) ──
  // 한도 초과 상태에서 발송하면 게이트웨이는 정상 접수하고 sms_logs에도 success로 남지만
  // 통신사가 실제 발송을 막아 TTL 만료로 조용히 소멸한다. 그 전에 끊는다.
  // 클라이언트에도 같은 검사가 있으나, 구번들 탭 우회를 막기 위해 서버에서 강제한다.
  if (provider === "phone") {
    const used = await countTodayPhoneSms(serviceSupabase, user.id);
    if (used !== null && used + validOrders.length > SMS_DAILY_LIMIT) {
      const allowed = Math.max(0, SMS_DAILY_LIMIT - used);
      console.warn(
        `[sms-send] 일일 한도 초과로 발송 거부: 오늘 ${used}건 + 요청 ${validOrders.length}건 > 한도 ${SMS_DAILY_LIMIT}건`
      );
      return NextResponse.json(
        {
          error: `KT 일일 발송 한도(${SMS_DAILY_LIMIT}건)를 초과합니다. 오늘 ${used}건 발송했고, 지금은 최대 ${allowed}건까지만 가능합니다.`,
          used,
          limit: SMS_DAILY_LIMIT,
          allowed,
        },
        { status: 400 }
      );
    }
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
          order_date: order.order_date ? formatKoreanDateTime(order.order_date) : "",
          address: [order.address, order.address_detail].filter(Boolean).join(" "),
          delivery_memo: order.delivery_memo || "",
        };
        const text = substituteTemplate(body.templateContent, variables);
        messageList.push({ order, to: phone, text });
      }

      const maskPhone = (p: string) =>
        p.replace(/(\d{3})(\d{4})(\d{4})/, "$1-****-$3");

      if (provider === "phone") {
        // ── v2: 내 휴대폰(SMS Gate 클라우드 릴레이)로 발송 (건당 무료) ──
        // 발송 전 폰 상태 사전 점검: 앱이 오프라인이면 조용히 큐에 쌓이므로 미리 경고.
        const gwStatus = await checkGatewayOnline(30);
        if (!gwStatus.online) {
          console.warn(`[sms-send] 발송 폰 오프라인 경고: ${gwStatus.reason}`);
          sendEvent({
            type: "progress",
            current: 0,
            total,
            status: "warning",
            message: `⚠️ ${gwStatus.reason}`,
          });
        }

        // 주문마다 본문이 다르므로 1건씩 큐잉. 폰이 자체 속도제한으로 비동기 발송.
        for (const item of messageList) {
          if (abortController.signal.aborted) break;
          const normalizedPhone = item.to.replace(/[^0-9]/g, "");

          try {
            const result = await sendGatewayMessage(item.to, item.text);
            successCount++;
            sendEvent({
              type: "progress",
              current: successCount + failedCount,
              total,
              phone: maskPhone(normalizedPhone),
              status: "success",
              message: "발송 요청됨",
            });
            await serviceSupabase.from("sms_logs").insert({
              user_id: user.id,
              batch_id: batchId,
              order_id: item.order.id,
              phone: normalizedPhone,
              message: item.text,
              status: "success",
              error_message: null,
              message_id: result.messageId || null,
              provider: "phone",
            });
          } catch (err) {
            failedCount++;
            const errMsg = err instanceof Error ? err.message : String(err);
            sendEvent({
              type: "progress",
              current: successCount + failedCount,
              total,
              phone: maskPhone(normalizedPhone),
              status: "failed",
              message: errMsg,
            });
            await serviceSupabase.from("sms_logs").insert({
              user_id: user.id,
              batch_id: batchId,
              order_id: item.order.id,
              phone: normalizedPhone,
              message: item.text,
              status: "failed",
              error_message: errMsg,
              message_id: null,
              provider: "phone",
            });
          }
        }
      } else {
        // ── v1: SOLAPI 대량 발송 (건당 유료, send-many 최대 1000건 배치) ──
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
                phone: maskPhone(normalizedPhone),
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
                provider: "solapi",
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
                phone: maskPhone(item.to.replace(/[^0-9]/g, "")),
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
              provider: "solapi",
            }));
            await serviceSupabase.from("sms_logs").insert(failLogs);
          }
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
