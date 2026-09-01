import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { buildSmartstorePreview } from "@/lib/marketplace-api-helpers";
import type { MarketplaceApiAction } from "@/types/database";

export const maxDuration = 60;

const ACTIONS = new Set(["price", "stock", "stop", "resume"]);

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = (await request.json()) as { productIds?: string[]; action?: MarketplaceApiAction; stockQuantity?: number | null };
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    if (productIds.length === 0) return NextResponse.json({ error: "상품을 선택하세요." }, { status: 400 });
    if (!body.action || !ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "지원하지 않는 스마트스토어 작업입니다." }, { status: 400 });
    }
    const supabase = getSupabaseClient(token);
    const preview = await buildSmartstorePreview(supabase, productIds, body.action, body.stockQuantity ?? null);
    return NextResponse.json(preview);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[smartstore-api] 미리보기 오류:", message);
    return NextResponse.json({ error: "스마트스토어 미리보기 생성 실패" }, { status: 500 });
  }
}
