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

    // 대량 처리: .in() URL 길이 한계 회피 위해 200개씩 청크 조회 (RLS로 본인 소유만 반환)
    const CHUNK = 200;
    type ProductRow = Record<string, unknown> & { id: string; product_name: string; sort_order?: number | null };
    const products: ProductRow[] = [];
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const chunk = productIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .in("id", chunk);
      if (error) {
        console.error(`[playauto-export] 청크 조회 실패 (${i}~${i + chunk.length}):`, error.message);
        return NextResponse.json({ error: `상품 조회 실패: ${error.message}` }, { status: 500 });
      }
      if (data) products.push(...(data as ProductRow[]));
    }
    products.sort((a, b) => ((a.sort_order ?? 0) as number) - ((b.sort_order ?? 0) as number));

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

    // 가격수정 모드: 대부분 Gemini skip (브랜드/카테고리코드/단위가격은 양식에 안 들어감)
    // 단, 쿠팡 옵션조합/옵션은 가격수정 양식에 들어가므로 처리 필요 — DB 캐시 우선 + 누락 시 Gemini fallback
    const productNames = products.map((p) => p.product_name as string);

    type CoupangOpt = { hasOption: boolean; optionName: string; optionValue: string };
    let metadataList: Array<{ model: string; brand: string; manufacturer: string }>;
    let smartstoreCategoryCodes: string[];
    let unitPriceInfoList: Array<{ display: string; displayAmount: number; displayUnit: string | number; totalAmount: number }> | undefined;
    let coupangPurchaseOptions: CoupangOpt[] | undefined;

    if (priceUpdate) {
      metadataList = productNames.map(() => ({ model: "", brand: "", manufacturer: "" }));
      smartstoreCategoryCodes = productNames.map(() => "");
      unitPriceInfoList = undefined;

      if (platform === "coupang") {
        // 1) DB 캐시 읽기
        const cached: (CoupangOpt | null)[] = products.map((p) => {
          const v = (p as Record<string, unknown>).coupang_options;
          return (v && typeof v === "object") ? (v as CoupangOpt) : null;
        });
        // 2) 누락분만 Gemini 호출
        const missingIdx: number[] = [];
        cached.forEach((c, i) => { if (c === null) missingIdx.push(i); });
        let extracted: CoupangOpt[] = [];
        if (missingIdx.length > 0) {
          console.log(`[playauto-export] coupang_options 누락 ${missingIdx.length}개 → Gemini 호출`);
          extracted = await extractCoupangPurchaseOptions(missingIdx.map((i) => productNames[i]));
          // 3) DB에 캐시 저장 (응답 지연 최소화: await 안 함)
          Promise.all(missingIdx.map((idx, j) =>
            supabase.from("products")
              .update({ coupang_options: extracted[j] })
              .eq("id", (products[idx] as Record<string, unknown>).id as string)
          )).catch((e) => console.error("[playauto-export] coupang_options 캐시 저장 실패:", e instanceof Error ? e.message : String(e)));
        }
        let extPtr = 0;
        coupangPurchaseOptions = cached.map((c) => {
          if (c !== null) return c;
          return extracted[extPtr++] ?? { hasOption: false, optionName: "", optionValue: "" };
        });
      } else {
        coupangPurchaseOptions = undefined;
      }
    } else {
      const result = await Promise.all([
        extractProductMetadataBatch(productNames),
        availableSsCodes.length > 0
          ? suggestSmartStoreCategoryCodes(
              products.map((p) => ({
                product_name: p.product_name as string,
                category: (p as Record<string, unknown>).category as string,
                source_category: (p as Record<string, unknown>).source_category as string,
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
      metadataList = result[0];
      smartstoreCategoryCodes = result[1];
      unitPriceInfoList = result[2];
      coupangPurchaseOptions = result[3];
    }

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

    // 엑셀 생성 (seller_code는 사전 할당된 DB 값 사용)
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
      undefined,
      unitPriceInfoList ?? undefined,
      coupangPurchaseOptions ?? undefined
    );

    const base64 = arrayBufferToBase64(buffer);
    return NextResponse.json({ base64, filename });
  } catch (e) {
    console.error("[playauto-export]", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
