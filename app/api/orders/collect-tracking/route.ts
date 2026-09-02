import { NextRequest, NextResponse } from "next/server";
import { collectGmarketTracking } from "@/lib/scrapers/gmarket";
import { collectAuctionTracking } from "@/lib/scrapers/auction";
import { collectOhouseTracking } from "@/lib/scrapers/ohouse";
import { decrypt } from "@/lib/crypto";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient, getServiceSupabaseClient } from "@/lib/api-helpers";
import type { ScrapeResult } from "@/lib/scrapers/types";
import { applyTrackingToOrders, saveTrackingLogs, loadTrackingOrderRows } from "@/lib/tracking/apply";
import { notifyAutomationResult } from "@/lib/discord-notifier";
import { buildTrackingNotification, groupScrapeResultsByOrder } from "@/lib/tracking-notification";

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
  // 여러 계정을 하나의 활동로그로 묶기 위해 클라이언트가 공유 batchId 전달 (선택)
  batchId?: string;
  // 디스코드 알림 발송 여부 (기본 true). 다계정 수집 시 마지막에 1회만 보내려면 false로 개별 호출 억제
  notify?: boolean;
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

      // 성공한 운송장을 발주서(orders)에 즉시 반영
      let appliedCount = 0;
      const applyErrors: string[] = [];
      if (supabase && result.success.length > 0) {
        const applyResult = await applyTrackingToOrders(supabase, result.success.map((s) => ({ purchase_order_no: s.orderNo, courier: s.courier, tracking_no: s.trackingNo })));
        appliedCount = applyResult.successCount;
        if (applyResult.failCount > 0) {
          console.warn("[collect-tracking] 발주서 반영 일부 실패:", applyResult.errors.slice(0, 5));
          applyErrors.push(...applyResult.errors.slice(0, 5).map((e) => `발주서 반영 실패: ${e}`));
        }
      }

      // 운송장 로그 저장 (백그라운드, 실패 시 콘솔 경고)
      // batchId가 전달되면 여러 계정 수집을 하나의 활동로그 배치로 묶는다
      if (supabase) {
        supabase.auth.getUser().then(({ data }) => saveTrackingLogs(supabase, data.user?.id ?? null, result, platform, loginId, body.orderNos, body.batchId)).catch((e) => {
          console.warn("[collect-tracking] 운송장 로그 저장 실패:", e instanceof Error ? e.message : String(e));
        });
      }

      // 다계정 수집 시 개별 호출은 알림을 억제하고, 클라이언트가 마지막에 합산 결과로 1회만 발송
      // (직접 API 호출용 — 수동 모달·크론과 같은 건별 포맷)
      if (body.notify !== false) {
        const rows = supabase ? await loadTrackingOrderRows(supabase, body.orderNos) : [];
        const payload = buildTrackingNotification({ trigger: "manual", orders: groupScrapeResultsByOrder(rows, [result]), errors: applyErrors });
        if (payload) await notifyAutomationResult(payload);
      }

      return NextResponse.json({ ...result, appliedCount });
    } finally {
      browserPool.release();
    }
  } catch (err) {
    const payload = buildTrackingNotification({ trigger: "manual", orders: [], errors: [`서버 오류: ${err instanceof Error ? err.message : String(err)}`] });
    if (payload) await notifyAutomationResult(payload);
    return NextResponse.json(
      { error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
