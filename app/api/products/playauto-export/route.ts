import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { extractProductMetadataBatch, suggestSmartStoreCategoryCodes } from "@/lib/gemini";
import { generatePlayAutoProductExcel, arrayBufferToBase64 } from "@/lib/excel-export";

export async function POST(req: NextRequest) {
  try {
    const { productIds, platform } = (await req.json()) as {
      productIds: string[];
      platform: "smartstore";
    };

    if (!productIds || productIds.length === 0) {
      return NextResponse.json({ error: "상품 ID가 없습니다." }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // 상품 조회
    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds)
      .order("sort_order");

    if (productsError || !products) {
      return NextResponse.json({ error: "상품 조회 실패" }, { status: 500 });
    }

    if (products.length === 0) {
      return NextResponse.json({ error: "조회된 상품이 없습니다." }, { status: 404 });
    }

    // 수수료 + 플레이오토 매핑 + 스마트스토어 카테고리코드 동시 조회
    const userId = products[0].user_id as string;
    const [ratesResult, mappingsResult, ssCodesResult] = await Promise.all([
      supabase.from("commission_rates").select("*").eq("user_id", userId),
      supabase.from("playauto_category_mappings").select("user_category, playauto_code").eq("user_id", userId),
      supabase.from("smartstore_category_codes").select("category_code, category_type, category_name").eq("user_id", userId),
    ]);

    if (ratesResult.error) {
      return NextResponse.json({ error: "수수료 조회 실패" }, { status: 500 });
    }

    // 카테고리 → 플레이오토 코드 맵 생성 (없으면 35 기본값)
    const categoryMappings: Record<string, string> = {};
    (mappingsResult.data ?? []).forEach((m) => {
      categoryMappings[m.user_category] = m.playauto_code;
    });

    const availableSsCodes = ssCodesResult.data ?? [];

    // Gemini로 브랜드/모델명/제조사 + 스마트스토어 카테고리코드 병렬 추출
    const productNames = products.map((p) => p.product_name as string);
    const [metadataList, smartstoreCategoryCodes] = await Promise.all([
      extractProductMetadataBatch(productNames),
      availableSsCodes.length > 0
        ? suggestSmartStoreCategoryCodes(
            products.map((p) => ({
              product_name: p.product_name as string,
              category: p.category as string,
              source_category: p.source_category as string,
            })),
            availableSsCodes
          )
        : Promise.resolve(products.map(() => "")),
    ]);

    // 엑셀 생성
    const { buffer, filename } = generatePlayAutoProductExcel(
      products,
      metadataList,
      ratesResult.data ?? [],
      categoryMappings,
      smartstoreCategoryCodes
    );

    const base64 = arrayBufferToBase64(buffer);
    return NextResponse.json({ base64, filename });
  } catch (e) {
    console.error("[playauto-export]", e);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
