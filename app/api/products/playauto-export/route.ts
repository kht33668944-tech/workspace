import { NextRequest, NextResponse } from "next/server";
import { fetchAllRows, getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { extractProductMetadataBatch, suggestSmartStoreCategoryCodes, extractUnitPriceInfo, extractCoupangPurchaseOptions } from "@/lib/gemini";
import { generatePlayAutoProductExcel, arrayBufferToBase64, PLATFORM_CONFIGS, platformToSellerGroup, type PlayAutoExportPlatform } from "@/lib/excel-export";
import { applyCoupangPlayAutoLearnedRules } from "@/lib/playauto-coupang-rules";
import type { Product } from "@/types/database";

function koreanShortDate(): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const yy = parts.find((p) => p.type === "year")?.value ?? "";
  const mm = parts.find((p) => p.type === "month")?.value ?? "";
  const dd = parts.find((p) => p.type === "day")?.value ?? "";
  return `${yy}${mm}${dd}`;
}

export async function POST(req: NextRequest) {
  try {
    const token = getAccessToken(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { productIds, platform = "smartstore", priceUpdate = false, startIndex = 0 } = (await req.json()) as {
      productIds: string[];
      platform?: PlayAutoExportPlatform;
      priceUpdate?: boolean;
      startIndex?: number;
    };

    if (platform === "11st") {
      return NextResponse.json({ error: "11번가는 현재 운영 제외 상태라 내보내기를 만들지 않습니다." }, { status: 400 });
    }

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

    const assignFreshExportSellerCodes = async (): Promise<string[] | undefined> => {
      if (priceUpdate) return undefined;

      const sellerGroup = platformToSellerGroup(platform);
      const dateStr = koreanShortDate();
      const allWithCode = await fetchAllRows<{ seller_code: Record<string, string> | null }>(
        (from, to) => supabase
          .from("products")
          .select("seller_code")
          .eq("user_id", userId)
          .not("seller_code", "is", null)
          .range(from, to),
      );

      let maxSeq = 0;
      for (const row of allWithCode) {
        const codes = row.seller_code ?? {};
        for (const code of Object.values(codes)) {
          if (typeof code !== "string" || !code.startsWith(dateStr)) continue;
          const seq = Number.parseInt(code.slice(6), 10);
          if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
        }
      }

      const sellerCodes = products.map((_, index) => `${dateStr}${String(maxSeq + index + 1).padStart(3, "0")}`);
      const updates = products.map((product, index) => ({
        id: product.id,
        seller_code: {
          ...(((product as Record<string, unknown>).seller_code as Record<string, string> | null) ?? {}),
          [sellerGroup]: sellerCodes[index],
        },
      }));

      const BATCH = 20;
      for (let i = 0; i < updates.length; i += BATCH) {
        const batch = updates.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map((item) =>
            supabase
              .from("products")
              .update({ seller_code: item.seller_code })
              .eq("id", item.id)
              .eq("user_id", userId)
          )
        );
        const failed = results.find((result) => result.status === "fulfilled" && result.value.error);
        if (failed?.status === "fulfilled") {
          throw new Error(`판매자관리코드 저장 실패: ${failed.value.error?.message ?? "알 수 없는 오류"}`);
        }
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") {
          throw new Error(`판매자관리코드 저장 실패: ${String(rejected.reason)}`);
        }
      }

      console.log(`[playauto-export] ${platform} 새 판매자관리코드 ${sellerCodes.length}개 저장 (${sellerCodes[0]}~${sellerCodes.at(-1)})`);
      return sellerCodes;
    };

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

    type CoupangOpt = { hasOption: boolean; optionName: string; optionValue: string; missingRequired?: string[] };
    let metadataList: Array<{ model: string; brand: string; manufacturer: string }>;
    let smartstoreCategoryCodes: string[];
    let unitPriceInfoList: Array<{ display: string; displayAmount: number; displayUnit: string | number; totalAmount: number }> | undefined;
    let coupangPurchaseOptions: CoupangOpt[] | undefined;
    const exportWarnings: Array<{ productName: string; missing: string[] }> = [];

    if (priceUpdate) {
      metadataList = productNames.map(() => ({ model: "", brand: "", manufacturer: "" }));
      smartstoreCategoryCodes = productNames.map(() => "");
      unitPriceInfoList = undefined;

      if (platform === "coupang") {
        // 1) DB 캐시 읽기
        // 과거 캐시에 총수량 단위 "팩"이 박혀있을 수 있음 → 플레이오토/쿠팡이 거부하므로 "개"로 교정
        const fixStaleQtyUnit = (o: CoupangOpt): CoupangOpt => {
          if (!o.optionValue || !o.optionValue.includes("팩")) return o;
          const optionValue = o.optionValue.replace(/(\d)\s*팩(?=$|=)/g, "$1개");
          return optionValue === o.optionValue ? o : { ...o, optionValue };
        };
        const cached: (CoupangOpt | null)[] = products.map((p) => {
          const v = (p as Record<string, unknown>).coupang_options;
          return (v && typeof v === "object") ? fixStaleQtyUnit(v as CoupangOpt) : null;
        });
        // 2) 누락분만 Gemini 호출
        const missingIdx: number[] = [];
        cached.forEach((c, i) => { if (c === null) missingIdx.push(i); });
        let extracted: CoupangOpt[] = [];
        if (missingIdx.length > 0) {
          console.log(`[playauto-export] coupang_options 누락 ${missingIdx.length}개 → Gemini 호출`);
          extracted = await extractCoupangPurchaseOptions(missingIdx.map((i) => productNames[i]), { callSource: "coupang_options_extract", userId: user.id });
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
        extractProductMetadataBatch(productNames, { callSource: "product_metadata_extract", userId: user.id }),
        availableSsCodes.length > 0
          ? suggestSmartStoreCategoryCodes(
              products.map((p) => ({
                product_name: p.product_name as string,
                category: (p as Record<string, unknown>).category as string,
                source_category: (p as Record<string, unknown>).source_category as string,
              })),
              availableSsCodes,
              { callSource: "smartstore_category_suggest", userId: user.id }
            )
          : Promise.resolve(products.map(() => "")),
        platform === "smartstore"
          ? extractUnitPriceInfo(productNames, { callSource: "unit_price_extract", userId: user.id })
          : Promise.resolve(undefined),
        platform === "coupang"
          ? extractCoupangPurchaseOptions(productNames, { callSource: "coupang_options_extract", userId: user.id })
          : Promise.resolve(undefined),
      ]);
      metadataList = result[0];
      smartstoreCategoryCodes = result[1];
      unitPriceInfoList = result[2];
      coupangPurchaseOptions = result[3];
    }

    if (!priceUpdate && platform === "coupang" && coupangPurchaseOptions) {
      const adjusted = applyCoupangPlayAutoLearnedRules(
        products as unknown as Product[],
        smartstoreCategoryCodes,
        coupangPurchaseOptions,
        availableSsCodes
      );
      smartstoreCategoryCodes = adjusted.siteCategoryCodes;
      coupangPurchaseOptions = adjusted.coupangOptions;
      exportWarnings.push(...adjusted.warnings);
    }

    // Gemini 카테고리 매칭은 간헐적으로 일부 상품을 빈칸으로 돌려준다(비결정적).
    // 실패분만 한 번 더 요청하면 대부분 채워지므로, 차단 전에 재시도한다.
    if (!priceUpdate && availableSsCodes.length > 0) {
      const retryIdx = smartstoreCategoryCodes
        .map((code, i) => (!code || String(code).trim() === "" ? i : -1))
        .filter((i) => i >= 0);
      if (retryIdx.length > 0) {
        console.log(`[playauto-export] 카테고리 매칭 실패 ${retryIdx.length}개 → 재시도`);
        const retried = await suggestSmartStoreCategoryCodes(
          retryIdx.map((i) => ({
            product_name: products[i].product_name as string,
            category: (products[i] as Record<string, unknown>).category as string,
            source_category: (products[i] as Record<string, unknown>).source_category as string,
          })),
          availableSsCodes,
          { callSource: "smartstore_category_suggest_retry", userId: user.id }
        );
        retryIdx.forEach((productIdx, j) => {
          if (retried[j]) smartstoreCategoryCodes[productIdx] = retried[j];
        });
        const stillMissing = retryIdx.filter((i) => !smartstoreCategoryCodes[i]).length;
        console.log(`[playauto-export] 재시도 결과: ${retryIdx.length - stillMissing}개 복구, ${stillMissing}개 여전히 실패`);
      }
    }

    if (!priceUpdate) {
      const missingCategoryProducts = products
        .map((p, i) => ({ productName: p.product_name as string, categoryCode: smartstoreCategoryCodes[i] }))
        .filter((p) => !p.categoryCode || String(p.categoryCode).trim() === "");

      if (missingCategoryProducts.length > 0) {
        console.error(
          `[playauto-export] 카테고리코드 매칭 실패 ${missingCategoryProducts.length}/${products.length}개: ` +
          missingCategoryProducts.map((p) => p.productName).join(", ")
        );
        return NextResponse.json({
          error:
            `카테고리코드 매칭에 실패한 상품이 ${missingCategoryProducts.length}개 있습니다.\n\n` +
            missingCategoryProducts.slice(0, 30).map((p) => `· ${p.productName}`).join("\n") +
            "\n\n빈 카테고리코드로 내보내면 플레이오토 등록이 실패하므로 엑셀 생성을 중단했습니다. " +
            "해당 상품을 선택에서 제외하거나 카테고리를 확인해 주세요.",
          missingCategories: missingCategoryProducts.slice(0, 30),
        }, { status: 422 });
      }
    }

    // 쿠팡 필수옵션 누락 경고 집계 (업로드 전 사전 안내 → "필수 추천 옵션" 오류 예방)
    const warnings: Array<{ productName: string; missing: string[] }> = [...exportWarnings];
    if (platform === "coupang" && coupangPurchaseOptions) {
      coupangPurchaseOptions.forEach((opt, i) => {
        const missing = opt?.missingRequired ?? [];
        if (missing.length > 0) {
          warnings.push({ productName: products[i].product_name as string, missing });
        }
      });
      if (warnings.length > 0) {
        console.warn(`[playauto-export] 쿠팡 필수옵션 누락 ${warnings.length}개 상품 (업로드 시 오류 가능)`);
      }
    }

    // 쿠팡 GTIN(바코드) 누락 경고 — 유명 브랜드 상품은 바코드 없이 등록 반려됨 (2026-06 UID 의무화)
    if (platform === "coupang") {
      for (const p of products as unknown as Array<{ product_name: string; item_info: Record<string, string> | null }>) {
        if (p.item_info && !p.item_info.바코드) {
          warnings.push({ productName: p.product_name, missing: ["바코드(GTIN) 미확보 — 쿠팡 등록 반려 가능"] });
        }
      }
    }

    // 사용자 커스텀 설정 (DB에 저장된 값 우선)
    let userConfig = exportConfigResult.data ?? undefined;

    // 개별 ESM 플랫폼(auction, gmarket)은 gmarket_auction 설정에서 계정명 추출
    const isIndividualEsm = ["auction", "gmarket"].includes(platform);
    if (isIndividualEsm && !userConfig) {
      const { data: esmConfig } = await supabase
        .from("playauto_export_configs").select("*")
        .eq("user_id", userId).eq("platform", "gmarket_auction").maybeSingle();
      if (esmConfig?.shop_account) {
        const platformConfig = PLATFORM_CONFIGS[platform as PlayAutoExportPlatform];
        const prefix = platformConfig.filenameLabel; // "옥션", "지마켓"
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

    // 엑셀 생성 전에 이번 내보내기용 판매자관리코드를 DB에도 저장한다.
    // 그래야 플레이오토 상품목록을 다시 가져왔을 때 상품명이 조금 달라도 판매자관리코드로 정확히 매칭된다.
    const exportSellerCodes = await assignFreshExportSellerCodes();

    const { buffer, filename } = await generatePlayAutoProductExcel(
      products as unknown as Product[],
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
      { startIndex, sellerCodes: exportSellerCodes },
      unitPriceInfoList ?? undefined,
      coupangPurchaseOptions ?? undefined
    );

    const base64 = arrayBufferToBase64(buffer);
    return NextResponse.json({ base64, filename, warnings });
  } catch (e) {
    console.error("[playauto-export]", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
