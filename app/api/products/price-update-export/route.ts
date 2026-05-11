import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { generatePriceUpdateExcel } from "@/lib/excel-export";
import type { Product } from "@/types/database";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = await request.json();
    const productIds = body?.productIds;
    const supabase = getSupabaseClient(token);

    // productIds 필수 검증
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return NextResponse.json({ error: "상품 ID가 필요합니다." }, { status: 400 });
    }

    // 대량 처리: .in() URL 길이 한계 회피 위해 200개씩 청크 조회
    const CHUNK = 200;
    const products: Product[] = [];
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const chunk = productIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .in("id", chunk);
      if (error) {
        console.error(`[price-update-export] 청크 조회 실패 (${i}~${i + chunk.length}):`, error.message);
        return NextResponse.json({ error: `상품 조회 실패: ${error.message}` }, { status: 400 });
      }
      if (data) products.push(...(data as Product[]));
    }
    if (products.length === 0) {
      return NextResponse.json({ error: "상품이 없습니다." }, { status: 400 });
    }

    // 플랫폼 코드가 있는 상품만 필터
    const withCodes = products.filter(p => p.platform_codes && Object.keys(p.platform_codes).length > 0);
    if (withCodes.length === 0) {
      return NextResponse.json({ error: "플랫폼 코드가 등록된 상품이 없습니다. 먼저 플랫폼 코드를 가져와주세요." }, { status: 400 });
    }

    // 수수료 조회
    const { data: rates } = await supabase.from("commission_rates").select("*");

    // 내보내기 설정 조회
    const { data: configs } = await supabase.from("playauto_export_configs").select("*");
    const exportConfigs: Record<string, { shopAccount: string }> = {};
    for (const c of configs ?? []) {
      exportConfigs[c.platform] = { shopAccount: c.shop_account };
    }

    const result = await generatePriceUpdateExcel(withCodes, rates ?? [], exportConfigs);

    const response: Record<string, unknown> = {};
    if (result.normal) {
      response.normal = {
        base64: Buffer.from(result.normal.buffer).toString("base64"),
        filename: result.normal.filename,
      };
    }
    if (result.single) {
      response.single = {
        base64: Buffer.from(result.single.buffer).toString("base64"),
        filename: result.single.filename,
      };
    }

    if (!response.normal && !response.single) {
      return NextResponse.json({ error: "내보낼 가격수정 데이터가 없습니다." }, { status: 400 });
    }

    console.log(`[price-update-export] 완료: 일반 ${result.normal ? "O" : "X"}, 단일 ${result.single ? "O" : "X"}`);
    return NextResponse.json(response);
  } catch (err) {
    console.error("[price-update-export] 오류:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "가격수정 내보내기 실패" }, { status: 500 });
  }
}
