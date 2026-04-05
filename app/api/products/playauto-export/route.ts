import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { extractProductMetadataBatch, suggestSmartStoreCategoryCodes, extractUnitPriceInfo, extractCoupangPurchaseOptions } from "@/lib/gemini";
import { generatePlayAutoProductExcel, arrayBufferToBase64, PLATFORM_CONFIGS, type PlayAutoExportPlatform } from "@/lib/excel-export";

export async function POST(req: NextRequest) {
  try {
    const token = getAccessToken(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { productIds, platform = "smartstore", priceUpdate = false } = (await req.json()) as {
      productIds: string[];
      platform?: PlayAutoExportPlatform;
      priceUpdate?: boolean;
    };

    if (!productIds || productIds.length === 0) {
      return NextResponse.json({ error: "상품 ID가 없습니다." }, { status: 400 });
    }

    // 상품 조회 (RLS로 본인 소유만 반환)
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

    const userId = user.id;

    // 카테고리코드는 1000개 이상일 수 있으므로 페이지네이션
    async function fetchAllCategoryCodes() {
      const PAGE = 1000;
      const all: Array<{ category_code: string; category_type: string; category_name: string }> = [];
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from("smartstore_category_codes")
          .select("category_code, category_type, category_name")
          .eq("user_id", userId)
          .range(from, from + PAGE - 1);
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return all;
    }

    const [ratesResult, mappingsResult, allCategoryCodes, exportConfigResult, noticeConfigsResult] = await Promise.all([
      supabase.from("commission_rates").select("*").eq("user_id", userId),
      supabase.from("playauto_category_mappings").select("user_category, playauto_code").eq("user_id", userId),
      fetchAllCategoryCodes(),
      supabase.from("playauto_export_configs").select("*").eq("user_id", userId).eq("platform", platform).maybeSingle(),
      supabase.from("playauto_notice_configs").select("schema_code, field_values").eq("user_id", userId),
    ]);

    if (ratesResult.error) {
      return NextResponse.json({ error: "수수료 조회 실패" }, { status: 500 });
    }

    // 카테고리 → 플레이오토 코드 맵 생성 (없으면 35 기본값)
    const categoryMappings: Record<string, string> = {};
    (mappingsResult.data ?? []).forEach((m) => {
      categoryMappings[m.user_category] = m.playauto_code;
    });

    const availableSsCodes = allCategoryCodes;

    // Gemini로 브랜드/모델명/제조사 + 스마트스토어 카테고리코드 + 단위가격정보 병렬 추출
    const productNames = products.map((p) => p.product_name as string);
    const [metadataList, smartstoreCategoryCodes, unitPriceInfoList, coupangPurchaseOptions] = await Promise.all([
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
      platform === "smartstore"
        ? extractUnitPriceInfo(productNames)
        : Promise.resolve(undefined),
      platform === "coupang"
        ? extractCoupangPurchaseOptions(productNames)
        : Promise.resolve(undefined),
    ]);

    // 사용자 커스텀 설정 (DB에 저장된 값 우선)
    let userConfig = exportConfigResult.data ?? undefined;

    // 개별 ESM 플랫폼(auction, gmarket, 11st)은 gmarket_auction 설정에서 계정명 추출
    const isIndividualEsm = ["auction", "gmarket", "11st"].includes(platform);
    if (isIndividualEsm && !userConfig) {
      const { data: esmConfig } = await supabase
        .from("playauto_export_configs").select("*")
        .eq("user_id", userId).eq("platform", "gmarket_auction").maybeSingle();
      if (esmConfig?.shop_account) {
        const platformConfig = PLATFORM_CONFIGS[platform as PlayAutoExportPlatform];
        const prefix = platformConfig.filenameLabel; // "옥션", "지마켓", "11번가"
        const lines = esmConfig.shop_account.split("\n").map((s: string) => s.trim());
        const matchedLine = lines.find((l: string) => l.startsWith(prefix + "="));
        if (matchedLine) {
          const accountName = matchedLine.split("=")[1];
          userConfig = {
            shop_account: `${prefix}=${accountName}`,
            template_code: platformConfig.templateCode,
            header_footer_template_code: platformConfig.headerFooterTemplateCode,
            sale_quantity: esmConfig.sale_quantity ?? 2000,
          };
        }
      }
    }

    // 상품정보제공고시 커스텀 값 (schema_code → field_values 맵)
    const noticeMap: Record<string, string[]> = {};
    (noticeConfigsResult.data ?? []).forEach((n: { schema_code: string; field_values: string[] }) => {
      noticeMap[n.schema_code] = n.field_values;
    });

    // 오늘 날짜의 seller_code 최대 순번 조회
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const { data: maxSellerCodeRow } = await supabase
      .from("products")
      .select("seller_code")
      .eq("user_id", userId)
      .like("seller_code", `${dateStr}%`)
      .order("seller_code", { ascending: false })
      .limit(1);
    const maxIndex = maxSellerCodeRow && maxSellerCodeRow.length > 0
      ? parseInt(maxSellerCodeRow[0].seller_code.slice(6), 10) || 0
      : 0;

    // seller_code가 없는 상품 ID 목록 수집 (엑셀 생성 후 DB 저장용)
    const productsWithoutSellerCode = products.filter((p) => !p.seller_code);
    const idsWithoutSellerCode = productsWithoutSellerCode.map((p) => p.id);

    // 엑셀 생성
    const { buffer, filename } = await generatePlayAutoProductExcel(
      products,
      metadataList,
      ratesResult.data ?? [],
      categoryMappings,
      smartstoreCategoryCodes,
      platform,
      userConfig ? {
        shopAccount: userConfig.shop_account,
        templateCode: userConfig.template_code,
        headerFooterTemplateCode: userConfig.header_footer_template_code,
        saleQuantity: userConfig.sale_quantity,
        productInfoNotice: "상세페이지 참조",
      } : undefined,
      Object.keys(noticeMap).length > 0 ? noticeMap : undefined,
      { startIndex: maxIndex },
      unitPriceInfoList ?? undefined,
      coupangPurchaseOptions ?? undefined
    );

    // 새로 생성된 seller_code를 DB에 저장
    if (idsWithoutSellerCode.length > 0) {
      let idx = maxIndex + 1;
      const updates = idsWithoutSellerCode.map((id) => {
        const sellerCode = `${dateStr}${String(idx).padStart(3, "0")}`;
        idx++;
        return supabase.from("products").update({ seller_code: sellerCode }).eq("id", id);
      });
      await Promise.all(updates);
    }

    const base64 = arrayBufferToBase64(buffer);
    return NextResponse.json({ base64, filename });
  } catch (e) {
    console.error("[playauto-export]", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
