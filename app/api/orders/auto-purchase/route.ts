import { NextRequest, NextResponse } from "next/server";
import { purchaseGmarket } from "@/lib/scrapers/gmarket-purchase";
import { purchaseOhouse } from "@/lib/scrapers/ohouse-purchase";
import { decrypt } from "@/lib/crypto";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import type { PurchaseOrderInfo } from "@/lib/scrapers/types";

export const maxDuration = 300;

interface AutoPurchaseRequest {
  credentialId?: string;
  loginId?: string;
  loginPw?: string;
  platform?: "gmarket" | "auction" | "ohouse";
  paymentPin?: string;
  orders: PurchaseOrderInfo[];
}

export async function POST(request: NextRequest) {
  try {
    const token = getAccessToken(request);
    if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

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

    // 플랫폼별 자동구매 실행 (동시성 제어)
    if (platform === "gmarket" && (!body.paymentPin || body.paymentPin.length !== 6)) {
      return NextResponse.json({ error: "결제 비밀번호 6자리가 필요합니다." }, { status: 400 });
    }
    if (platform !== "gmarket" && platform !== "ohouse") {
      return NextResponse.json({ error: `${platform}은(는) 아직 자동구매를 지원하지 않습니다.` }, { status: 400 });
    }

    await browserPool.acquire();
    let result;
    try {
      if (platform === "gmarket") {
        result = await purchaseGmarket(loginId, loginPw, body.paymentPin!, body.orders);
      } else {
        const ohouseSupabase = getSupabaseClient(token);
        result = await purchaseOhouse(loginId, loginPw, body.orders, undefined, ohouseSupabase);
      }
    } finally {
      browserPool.release();
    }

    // 성공한 주문의 purchase_order_no + cost + payment_method를 DB에 업데이트
    const dbErrors: string[] = [];
    if (result.success.length > 0) {
      const supabase = getSupabaseClient(token);
      for (const s of result.success) {
        const updateData: Record<string, unknown> = {
          purchase_order_no: s.purchaseOrderNo,
          delivery_status: "배송준비",
        };
        if (s.cost !== undefined) {
          updateData.cost = s.cost;
        }
        if (s.paymentMethod) {
          updateData.payment_method = s.paymentMethod;
        }
        const { error, count } = await supabase
          .from("orders")
          .update(updateData)
          .eq("id", s.orderId);
        if (error) {
          console.error(`[auto-purchase] DB 업데이트 실패 (${s.orderId}):`, error.message);
          dbErrors.push(`${s.orderId}: ${error.message}`);
        } else {
          console.log(`[auto-purchase] DB 업데이트 성공 (${s.orderId}): ${JSON.stringify(updateData)}, count=${count}`);
        }
      }
    }

    return NextResponse.json({
      success: result.success,
      failed: result.failed,
      successCount: result.success.length,
      failCount: result.failed.length,
      ...(dbErrors.length > 0 && { dbErrors }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
