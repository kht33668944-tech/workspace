import { NextRequest, NextResponse } from "next/server";
import { collectGmarketTracking } from "@/lib/scrapers/gmarket";
import { collectAuctionTracking } from "@/lib/scrapers/auction";
import { collectOhouseTracking } from "@/lib/scrapers/ohouse";
import { decrypt } from "@/lib/crypto";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import type { ScrapeResult } from "@/lib/scrapers/types";
import { randomUUID } from "crypto";

export const maxDuration = 300;

type SupabaseClient = ReturnType<typeof getSupabaseClient>;

interface CollectRequest {
  // 자동 모드: 저장된 자격증명 사용
  credentialId?: string;
  // 수동 모드: 직접 입력 (기존 호환)
  platform?: "gmarket" | "auction" | "ohouse";
  loginId?: string;
  loginPw?: string;
  // 공통
  orderNos: string[];
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CollectRequest;

    if (!body.orderNos || body.orderNos.length === 0) {
      return NextResponse.json({ error: "수집할 주문번호가 없습니다." }, { status: 400 });
    }

    let platform: string;
    let loginId: string;
    let loginPw: string;
    let supabase: SupabaseClient | null = null;

    // 인증 필수 (자동/수동 모드 공통)
    const token = getAccessToken(request);
    if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
    supabase = getSupabaseClient(token);

    if (body.credentialId) {
      // 자동 모드: DB에서 자격증명 조회
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
      // 수동 모드: 직접 입력 (기존 호환)
      if (!body.platform || !body.loginId || !body.loginPw) {
        return NextResponse.json({ error: "계정 정보가 필요합니다." }, { status: 400 });
      }
      platform = body.platform;
      loginId = body.loginId;
      loginPw = body.loginPw;
    }

    // 클라이언트 연결 끊김 감지 → 스크래퍼 중단
    const abortController = new AbortController();
    const { signal } = abortController;
    request.signal.addEventListener("abort", () => {
      abortController.abort();
    });

    // 동시성 제어
    await browserPool.acquire();
    try {
      let result: ScrapeResult;
      if (platform === "gmarket") {
        result = await collectGmarketTracking(loginId, loginPw, body.orderNos, signal);
      } else if (platform === "auction") {
        result = await collectAuctionTracking(loginId, loginPw, body.orderNos, signal);
      } else if (platform === "ohouse") {
        const ohouseSupabase = getServiceSupabaseClient();
        result = await collectOhouseTracking(loginId, loginPw, body.orderNos, ohouseSupabase, signal);
      } else {
        return NextResponse.json({ error: `${platform}은(는) 아직 지원되지 않습니다.` }, { status: 400 });
      }

      // 운송장 로그 저장 (백그라운드, 실패 시 콘솔 경고)
      if (supabase) {
        saveTrackingLogs(supabase, result, platform, loginId, body.orderNos).catch((e) => {
          console.warn("[collect-tracking] 운송장 로그 저장 실패:", e);
        });
      }

      return NextResponse.json(result);
    } finally {
      browserPool.release();
    }
  } catch (err) {
    return NextResponse.json(
      { error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

async function saveTrackingLogs(
  supabase: SupabaseClient,
  result: ScrapeResult,
  platform: string,
  loginId: string,
  orderNos: string[],
) {
  const batchId = randomUUID();
  const { data: { user: authUser } } = await supabase.auth.getUser();
  const userId = authUser?.id ?? null;

  // purchase_order_no로 order_id, recipient_name, product_name 조회
  const { data: orders } = await supabase
    .from("orders")
    .select("id, purchase_order_no, recipient_name, product_name")
    .in("purchase_order_no", orderNos);

  const orderMap = new Map<string, { id: string; recipient_name: string | null; product_name: string | null }>();
  for (const o of (orders || [])) {
    if (o.purchase_order_no) orderMap.set(o.purchase_order_no, o);
  }

  const base = { batch_id: batchId, platform, login_id: loginId, user_id: userId };

  const logs = [
    ...result.success.map((s) => {
      const order = orderMap.get(s.orderNo);
      return { ...base, status: "success", purchase_order_no: s.orderNo, courier: s.courier, tracking_no: s.trackingNo, error_message: null, recipient_name: order?.recipient_name ?? null, product_name: order?.product_name ?? s.itemName ?? null, order_id: order?.id ?? null };
    }),
    ...result.failed.map((f) => {
      const order = orderMap.get(f.orderNo);
      return { ...base, status: "failed", purchase_order_no: f.orderNo, courier: null, tracking_no: null, error_message: f.reason, recipient_name: order?.recipient_name ?? null, product_name: order?.product_name ?? null, order_id: order?.id ?? null };
    }),
    ...result.notFound.map((orderNo) => {
      const order = orderMap.get(orderNo);
      return { ...base, status: "not_found", purchase_order_no: orderNo, courier: null, tracking_no: null, error_message: null, recipient_name: order?.recipient_name ?? null, product_name: order?.product_name ?? null, order_id: order?.id ?? null };
    }),
  ];

  if (logs.length > 0) {
    await supabase.from("tracking_logs").insert(logs);
  }
}
