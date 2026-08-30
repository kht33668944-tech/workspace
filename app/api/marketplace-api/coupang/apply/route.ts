import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { buildCoupangPreview, getCoupangClientFromCredential } from "@/lib/marketplace-api-helpers";
import { isDryRun, sleep } from "@/lib/marketplace/common";
import type { MarketplaceApiAction } from "@/types/database";

export const maxDuration = 300;

const ACTIONS = new Set(["price", "stock", "stop", "resume"]);
// 쿠팡 초당 5건 한도를 플레이오토와 공유하므로 넉넉히 300ms
const BATCH_DELAY_MS = 300;

export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const body = await request.json() as {
      credentialId?: string;
      productIds?: string[];
      action?: MarketplaceApiAction;
      stockQuantity?: number | null;
    };
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    if (!body.credentialId) return NextResponse.json({ error: "쿠팡 API 계정을 선택하세요." }, { status: 400 });
    if (productIds.length === 0) return NextResponse.json({ error: "상품을 선택하세요." }, { status: 400 });
    if (!body.action || !ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "지원하지 않는 쿠팡 작업입니다." }, { status: 400 });
    }

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });

    const { client } = await getCoupangClientFromCredential(supabase, body.credentialId);
    const preview = await buildCoupangPreview(supabase, productIds, body.action, body.stockQuantity ?? null);
    const dry = isDryRun();

    const results: Array<{
      productId: string;
      productName: string;
      vendorItemId: string;
      status: "success" | "failed" | "dry";
      message: string;
      previousValue: string | null;
      newValue: string | null;
    }> = [];

    for (const item of preview.items) {
      let apiResult;
      const newNumber = item.newValue == null ? null : Number(item.newValue);
      if (body.action === "price" && newNumber != null) {
        apiResult = await client.changePrice(item.vendorItemId, newNumber);
      } else if (body.action === "stock" && newNumber != null) {
        apiResult = await client.changeQuantity(item.vendorItemId, newNumber);
      } else if (body.action === "stop") {
        apiResult = await client.stopSale(item.vendorItemId);
      } else if (body.action === "resume") {
        apiResult = await client.resumeSale(item.vendorItemId);
      } else {
        apiResult = { ok: false, status: 400, body: null, message: "지원하지 않는 작업입니다." };
      }

      const status = apiResult.ok ? "success" : "failed";
      const message = apiResult.ok ? "반영 완료" : apiResult.message;
      results.push({
        productId: item.productId,
        productName: item.productName,
        vendorItemId: item.vendorItemId,
        status,
        message,
        previousValue: item.previousValue,
        newValue: item.newValue,
      });

      if (apiResult.ok) {
        const updateData: Record<string, unknown> = {};
        if (body.action === "price") updateData.sale_price = newNumber;
        if (body.action === "stock") updateData.stock = newNumber;
        if (body.action === "stop") updateData.sale_status = "판매중지";
        if (body.action === "resume") updateData.sale_status = "판매중";
        if (Object.keys(updateData).length > 0) {
          await supabase
            .from("coupang_price_inventory")
            .update(updateData)
            .eq("user_id", userData.user.id)
            .eq("vendor_item_id", item.vendorItemId);
        }
      }

      await supabase.from("marketplace_api_logs").insert({
        user_id: userData.user.id,
        platform: "coupang",
        credential_id: body.credentialId,
        action: body.action,
        status,
        product_id: item.productId,
        product_name: item.productName,
        vendor_item_id: item.vendorItemId,
        previous_value: item.previousValue,
        new_value: item.newValue,
        error_message: apiResult.ok ? null : message,
        response_payload: typeof apiResult.body === "object" ? apiResult.body : { body: apiResult.body },
      });

      if (!dry) await sleep(BATCH_DELAY_MS);
    }

    const successCount = results.filter((r) => r.status === "success" || r.status === "dry").length;
    const failCount = results.length - successCount;
    return NextResponse.json({
      successCount,
      failCount,
      blocked: preview.blocked,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[coupang-api] 실행 오류:", message);
    return NextResponse.json({ error: "쿠팡 API 반영 실패" }, { status: 500 });
  }
}
