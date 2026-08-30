import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { buildSmartstorePreview, getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import { isDryRun, sleep } from "@/lib/marketplace/common";
import type { NaverApiResponse, NaverOriginProductResponse } from "@/lib/naver-commerce-api";
import type { MarketplaceApiAction } from "@/types/database";

export const maxDuration = 300;

const ACTIONS = new Set(["price", "stock", "stop", "resume"]);
// 내스토어 애플리케이션은 초당 2회. GET+PUT 두 번이므로 건당 1.2초 간격.
const BATCH_DELAY_MS = 1200;

export interface SmartstoreApplyResult {
  productId: string;
  productName: string;
  originProductNo: string;
  status: "success" | "failed" | "dry";
  message: string;
  previousValue: string | null;
  newValue: string | null;
}

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = (await request.json()) as {
      credentialId?: string;
      productIds?: string[];
      action?: MarketplaceApiAction;
      stockQuantity?: number | null;
    };
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    if (!body.credentialId) return NextResponse.json({ error: "스마트스토어 API 계정을 선택하세요." }, { status: 400 });
    if (productIds.length === 0) return NextResponse.json({ error: "상품을 선택하세요." }, { status: 400 });
    if (!body.action || !ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "지원하지 않는 스마트스토어 작업입니다." }, { status: 400 });
    }

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

    const { client } = await getNaverClientFromCredential(supabase, body.credentialId);
    const preview = await buildSmartstorePreview(supabase, productIds, body.action, body.stockQuantity ?? null);
    const dry = isDryRun();
    const results: SmartstoreApplyResult[] = [];

    for (const item of preview.items) {
      const newNumber = item.newValue == null ? null : Number(item.newValue);
      let apiResult: NaverApiResponse;

      if (body.action === "price" && newNumber != null) {
        apiResult = await client.patchOriginProduct(item.originProductNo, (p: NaverOriginProductResponse) => {
          p.originProduct.salePrice = newNumber;
        });
      } else if (body.action === "stock" && newNumber != null) {
        apiResult = await client.patchOriginProduct(item.originProductNo, (p: NaverOriginProductResponse) => {
          const combos = p.originProduct.detailAttribute?.optionInfo?.optionCombinations;
          if (Array.isArray(combos) && combos.length > 0) {
            // 조합형 옵션: 옵션 재고 합계 == 상품 재고 규칙. 모든 옵션에 동일 수량을 넣고 합계를 상품 재고로.
            for (const c of combos) c.stockQuantity = newNumber;
            p.originProduct.stockQuantity = newNumber * combos.length;
          } else {
            p.originProduct.stockQuantity = newNumber;
          }
        });
      } else if (body.action === "stop") {
        apiResult = await client.changeProductStatus(item.originProductNo, "SUSPENSION");
      } else if (body.action === "resume") {
        apiResult = await client.changeProductStatus(item.originProductNo, "SALE");
      } else {
        apiResult = { ok: false, status: 400, body: null, message: "지원하지 않는 작업입니다." };
      }

      const status: SmartstoreApplyResult["status"] = apiResult.dryRun ? "dry" : apiResult.ok ? "success" : "failed";
      const message = apiResult.dryRun ? "DRY RUN (실제 전송 안 함)" : apiResult.ok ? "반영 완료" : apiResult.message;
      results.push({
        productId: item.productId,
        productName: item.productName,
        originProductNo: item.originProductNo,
        status,
        message,
        previousValue: item.previousValue,
        newValue: item.newValue,
      });

      if (apiResult.ok && !apiResult.dryRun) {
        const updateData: Record<string, unknown> = { api_synced_at: new Date().toISOString() };
        if (body.action === "price") updateData.sale_price = newNumber;
        if (body.action === "stock") updateData.stock = newNumber;
        if (body.action === "stop") updateData.product_status = "SUSPENSION";
        if (body.action === "resume") updateData.product_status = "SALE";
        await supabase
          .from("smartstore_price_inventory")
          .update(updateData)
          .eq("user_id", userData.user.id)
          .eq("origin_product_no", item.originProductNo);
      }

      await supabase.from("marketplace_api_logs").insert({
        user_id: userData.user.id,
        platform: "smartstore",
        credential_id: body.credentialId,
        action: dry ? `${body.action}:dry` : body.action,
        status: apiResult.ok ? "success" : "failed",
        product_id: item.productId,
        product_name: item.productName,
        target_id: item.originProductNo,
        previous_value: item.previousValue,
        new_value: item.newValue,
        error_message: apiResult.ok ? null : message,
        response_payload: typeof apiResult.body === "object" ? apiResult.body : { body: apiResult.body },
      });

      if (!dry) await sleep(BATCH_DELAY_MS);
    }

    const successCount = results.filter((r) => r.status === "success" || r.status === "dry").length;
    return NextResponse.json({
      dryRun: dry,
      successCount,
      failCount: results.length - successCount,
      blocked: preview.blocked,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[smartstore-api] 실행 오류:", message);
    return NextResponse.json({ error: "스마트스토어 API 반영 실패" }, { status: 500 });
  }
}
