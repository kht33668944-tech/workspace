import { NextRequest, NextResponse } from "next/server";
import { collectGmarketTracking } from "@/lib/scrapers/gmarket";
import { collectAuctionTracking } from "@/lib/scrapers/auction";
import type { CollectTrackingRequest } from "@/lib/scrapers/types";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CollectTrackingRequest;

    if (!body.loginId || !body.loginPw) {
      return NextResponse.json({ error: "아이디와 비밀번호를 입력해주세요." }, { status: 400 });
    }
    if (!body.orderNos || body.orderNos.length === 0) {
      return NextResponse.json({ error: "수집할 주문번호가 없습니다." }, { status: 400 });
    }

    let result;
    if (body.platform === "gmarket") {
      result = await collectGmarketTracking(body.loginId, body.loginPw, body.orderNos);
    } else if (body.platform === "auction") {
      result = await collectAuctionTracking(body.loginId, body.loginPw, body.orderNos);
    } else {
      return NextResponse.json({ error: `${body.platform}은(는) 아직 지원되지 않습니다.` }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
