import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { purchaseGmarket } from "@/lib/scrapers/gmarket-purchase";
import { purchaseOhouse } from "@/lib/scrapers/ohouse-purchase";
import { decrypt } from "@/lib/crypto";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import type { PurchaseOrderInfo } from "@/lib/scrapers/types";

export const maxDuration = 300;

interface AutoPurchaseRequest {
  credentialId?: string;
  loginId?: string;
  loginPw?: string;
  platform?: "gmarket" | "auction" | "ohouse";
  paymentPin?: string;
  batchId?: string;
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
  success?: { orderId: string; purchaseOrderNo: string; cost?: number; paymentMethod?: string }[];
  failed?: { orderId: string; reason: string }[];
  successCount?: number;
  failCount?: number;
}

export async function POST(request: NextRequest) {
  try {
    const token = getAccessToken(request);
    if (!token) {
      return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    }

    const body = (await request.json()) as AutoPurchaseRequest;

    if (!body.orders || body.orders.length === 0) {
      return NextResponse.json({ error: "구매할 주문이 없습니다." }, { status: 400 });
    }

    let platform: string;
    let loginId: string;
    let loginPw: string;

    if (body.credentialId) {
      const supabase = getSupabaseClient(token);
      const { data: cred, error } = await supabase
        .from("purchase_credentials")
        .select("platform, login_id, login_pw_encrypted")
        .eq("id", body.credentialId)
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
      const supabaseForCred = getSupabaseClient(token);
      // smartstore 플랫폼으로 등록된 계정 중 첫 번째 사용
      const { data: naverCred } = await supabaseForCred
        .from("purchase_credentials")
        .select("login_id, login_pw_encrypted")
        .eq("platform", "smartstore")
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
        // JWT에서 user_id 추출 (purchase_logs insert 시 필요)
        const userSupabase = getSupabaseClient(token);
        const { data: { user: authUser } } = await userSupabase.auth.getUser();
        const userId = authUser?.id;
        const batchId = body.batchId || crypto.randomUUID();
        const allSuccess: SSEEvent["success"] = [];
        const allFailed: SSEEvent["failed"] = [];

        // 주문별 즉시 DB 업데이트 + SSE 전송 콜백
        const onProgress = (
          orderId: string,
          status: "processing" | "success" | "failed" | "waiting_payment",
          message: string,
          purchaseOrderNo?: string
        ) => {
          sendEvent({ type: "progress", orderId, status, message, purchaseOrderNo });
        };

        // 성공 시 즉시 DB 업데이트하는 콜백
        const onOrderComplete = async (
          orderId: string,
          purchaseOrderNo: string,
          cost?: number,
          paymentMethod?: string
        ) => {
          allSuccess!.push({ orderId, purchaseOrderNo, cost, paymentMethod });

          // 즉시 DB 업데이트
          const updateData: Record<string, unknown> = {
            purchase_order_no: purchaseOrderNo,
            delivery_status: "배송준비",
          };
          if (cost !== undefined) updateData.cost = cost;
          if (paymentMethod) updateData.payment_method = paymentMethod;

          const { error } = await supabase
            .from("orders")
            .update(updateData)
            .eq("id", orderId);

          if (error) {
            console.error(`[auto-purchase] DB 업데이트 실패 (${orderId}):`, error.message);
            sendEvent({ type: "db_updated", orderId, status: "error", message: error.message });
          } else {
            console.log(`[auto-purchase] DB 즉시 업데이트 성공 (${orderId}): ${JSON.stringify(updateData)}`);
            sendEvent({ type: "db_updated", orderId, status: "ok", purchaseOrderNo, cost, paymentMethod });
          }

          // 구매 로그 기록
          const orderInfo = body.orders.find(o => o.orderId === orderId);
          await supabase.from("purchase_logs").insert({
            user_id: userId,
            batch_id: batchId,
            order_id: orderId,
            platform,
            login_id: loginId,
            status: "success",
            purchase_order_no: purchaseOrderNo,
            cost: cost ?? null,
            payment_method: paymentMethod ?? null,
            product_name: orderInfo?.productName ?? null,
            recipient_name: orderInfo?.recipientName ?? null,
          }).then(({ error: logErr }) => {
            if (logErr) console.error(`[auto-purchase] 구매 로그 기록 실패 (${orderId}):`, logErr.message);
          });
        };

        try {
          await browserPool.acquire();
          let result;
          try {
            if (platform === "gmarket") {
              result = await purchaseGmarket(loginId, loginPw, body.paymentPin!, body.orders, onProgress, signal);
            } else {
              result = await purchaseOhouse(loginId, loginPw, body.orders, onProgress, supabase, signal, body.paymentPin, naverLoginId, naverLoginPw);
            }
          } finally {
            browserPool.release();
          }

          // 성공한 주문 즉시 DB 업데이트 (스크래퍼에서 콜백 안 탄 경우 대비)
          for (const s of result.success) {
            if (!allSuccess!.some(a => a!.orderId === s.orderId)) {
              await onOrderComplete(s.orderId, s.purchaseOrderNo, s.cost, s.paymentMethod);
            }
          }

          for (const f of result.failed) {
            if (!allFailed!.some(a => a!.orderId === f.orderId)) {
              allFailed!.push(f);
            }
          }

          // 실패/취소 건 구매 로그 기록
          for (const f of allFailed!) {
            const orderInfo = body.orders.find(o => o.orderId === f!.orderId);
            await supabase.from("purchase_logs").insert({
              user_id: userId,
              batch_id: batchId,
              order_id: f!.orderId,
              platform,
              login_id: loginId,
              status: signal.aborted ? "cancelled" : "failed",
              error_message: f!.reason,
              product_name: orderInfo?.productName ?? null,
              recipient_name: orderInfo?.recipientName ?? null,
            }).then(({ error: logErr }) => {
              if (logErr) console.error(`[auto-purchase] 실패 로그 기록 실패 (${f!.orderId}):`, logErr.message);
            });
          }

          const isCancelled = signal.aborted;
          sendEvent({
            type: isCancelled ? "cancelled" : "done",
            success: allSuccess,
            failed: allFailed,
            successCount: allSuccess!.length,
            failCount: allFailed!.length,
            message: isCancelled ? "사용자가 작업을 중단했습니다." : undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // abort 에러는 cancelled로 처리
          if (signal.aborted || msg.includes("abort")) {
            sendEvent({
              type: "cancelled",
              success: allSuccess,
              failed: allFailed,
              successCount: allSuccess!.length,
              failCount: allFailed!.length,
              message: "사용자가 작업을 중단했습니다.",
            });
          } else {
            sendEvent({ type: "error", message: `서버 오류: ${msg}` });
          }
        } finally {
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
