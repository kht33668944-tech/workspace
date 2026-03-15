import { NextRequest, NextResponse } from "next/server";
import { collectGmarketTracking } from "@/lib/scrapers/gmarket";
import { collectAuctionTracking } from "@/lib/scrapers/auction";
import { collectOhouseTracking } from "@/lib/scrapers/ohouse";
import { decrypt } from "@/lib/crypto";
import { browserPool } from "@/lib/scrapers/browser-pool";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import type { ScrapeResult } from "@/lib/scrapers/types";

export const maxDuration = 300;

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

    if (body.credentialId) {
      // 자동 모드: DB에서 자격증명 조회
      const token = getAccessToken(request);
      if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

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
      // 수동 모드: 직접 입력 (기존 호환)
      if (!body.platform || !body.loginId || !body.loginPw) {
        return NextResponse.json({ error: "계정 정보가 필요합니다." }, { status: 400 });
      }
      platform = body.platform;
      loginId = body.loginId;
      loginPw = body.loginPw;
    }

    // 동시성 제어
    await browserPool.acquire();
    try {
      let result: ScrapeResult;
      if (platform === "gmarket") {
        result = await collectGmarketTracking(loginId, loginPw, body.orderNos);
      } else if (platform === "auction") {
        result = await collectAuctionTracking(loginId, loginPw, body.orderNos);
      } else if (platform === "ohouse") {
        const token = getAccessToken(request);
        const ohouseSupabase = token ? getSupabaseClient(token) : undefined;
        result = await collectOhouseTracking(loginId, loginPw, body.orderNos, ohouseSupabase);
      } else {
        return NextResponse.json({ error: `${platform}은(는) 아직 지원되지 않습니다.` }, { status: 400 });
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
