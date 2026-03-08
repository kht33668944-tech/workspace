import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { purchaseGmarket } from "@/lib/scrapers/gmarket-purchase";
import { decrypt } from "@/lib/crypto";
import type { PurchaseOrderInfo } from "@/lib/scrapers/types";

function getSupabaseClient(accessToken: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
}

function getAccessToken(request: NextRequest): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

interface AutoPurchaseRequest {
  credentialId?: string;
  loginId?: string;
  loginPw?: string;
  platform?: "gmarket" | "auction";
  paymentPin: string;
  orders: PurchaseOrderInfo[];
}

export async function POST(request: NextRequest) {
  try {
    const token = getAccessToken(request);
    if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

    const body = (await request.json()) as AutoPurchaseRequest;

    if (!body.paymentPin || body.paymentPin.length !== 6) {
      return NextResponse.json({ error: "결제 비밀번호 6자리가 필요합니다." }, { status: 400 });
    }

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

    // 현재는 지마켓만 지원
    if (platform !== "gmarket") {
      return NextResponse.json({ error: `${platform}은(는) 아직 자동구매를 지원하지 않습니다.` }, { status: 400 });
    }

    const result = await purchaseGmarket(loginId, loginPw, body.paymentPin, body.orders);

    // 성공한 주문의 purchase_order_no + cost + payment_method를 DB에 업데이트
    if (result.success.length > 0) {
      const supabase = getSupabaseClient(token);
      for (const s of result.success) {
        const updateData: Record<string, unknown> = { purchase_order_no: s.purchaseOrderNo };
        if (s.cost !== undefined) {
          updateData.cost = s.cost;
        }
        if (s.paymentMethod) {
          updateData.payment_method = s.paymentMethod;
        }
        await supabase
          .from("orders")
          .update(updateData)
          .eq("id", s.orderId);
      }
    }

    return NextResponse.json({
      success: result.success,
      failed: result.failed,
      successCount: result.success.length,
      failCount: result.failed.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
