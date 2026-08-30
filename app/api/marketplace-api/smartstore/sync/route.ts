import { NextRequest, NextResponse } from "next/server";
import { fetchAllRows, getAccessToken, getSupabaseClient } from "@/lib/api-helpers";
import { getNaverClientFromCredential } from "@/lib/marketplace-api-helpers";
import { normalizeName } from "@/lib/smartstore-price-inventory";
import type { SmartstorePriceInventory } from "@/types/database";

type InventoryRow = Pick<SmartstorePriceInventory, "id" | "product_id" | "smartstore_product_id" | "product_name" | "sale_price" | "origin_product_no" | "channel_product_no" | "stock">;

export const maxDuration = 300;

/**
 * 네이버 상품 목록을 읽어 smartstore_price_inventory 에 원상품번호·현재가·재고를 채운다.
 * - 1차: channelProductNo == smartstore_product_id
 * - 2차: 상품명 정규화 일치 (인벤토리에 없으면 products 와 매칭해 새 행 생성)
 * 읽기 전용 API 라 DRY_RUN 과 무관하게 항상 실행된다.
 */
export async function POST(request: NextRequest) {
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  try {
    const { credentialId } = (await request.json()) as { credentialId?: string };
    if (!credentialId) return NextResponse.json({ error: "스마트스토어 API 계정을 선택하세요." }, { status: 400 });

    const supabase = getSupabaseClient(token);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return NextResponse.json({ error: "인증 실패" }, { status: 401 });
    const userId = userData.user.id;

    const { client } = await getNaverClientFromCredential(supabase, credentialId);
    const remote = await client.searchAllProducts();

    const inventory = await fetchAllRows<InventoryRow>((from, to) =>
      supabase
        .from("smartstore_price_inventory")
        .select("id,product_id,smartstore_product_id,product_name,sale_price,origin_product_no,channel_product_no,stock")
        .eq("user_id", userId)
        .range(from, to),
    );
    const products = await fetchAllRows<{ id: string; product_name: string }>((from, to) =>
      supabase.from("products").select("id,product_name").eq("user_id", userId).range(from, to),
    );

    const invByChannelNo = new Map(inventory.map((r) => [r.smartstore_product_id, r]));
    const invByName = new Map<string, InventoryRow>();
    for (const r of inventory) if (r.product_name) invByName.set(normalizeName(r.product_name), r);
    const productByName = new Map(products.map((p) => [normalizeName(p.product_name), p]));

    const now = new Date().toISOString();
    let matchedByNo = 0;
    let matchedByName = 0;
    let created = 0;
    const unmatched: string[] = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const inserts: Record<string, unknown>[] = [];

    for (const cp of remote) {
      const channelNo = String(cp.channelProductNo);
      const patch = {
        origin_product_no: String(cp.originProductNo),
        channel_product_no: channelNo,
        sale_price: cp.salePrice ?? null,
        stock: cp.stockQuantity ?? null,
        product_status: cp.statusType ?? null,
        api_synced_at: now,
      };
      const byNo = invByChannelNo.get(channelNo);
      if (byNo) {
        matchedByNo++;
        updates.push({ id: byNo.id, patch });
        continue;
      }
      const byName = invByName.get(normalizeName(cp.name));
      if (byName) {
        matchedByName++;
        updates.push({ id: byName.id, patch });
        continue;
      }
      const product = productByName.get(normalizeName(cp.name));
      if (product) {
        created++;
        inserts.push({
          user_id: userId,
          product_id: product.id,
          smartstore_product_id: channelNo,
          seller_product_code: cp.sellerManagementCode ?? null,
          product_name: cp.name,
          raw_row: {},
          ...patch,
        });
        continue;
      }
      unmatched.push(cp.name);
    }

    for (let i = 0; i < updates.length; i += 20) {
      await Promise.all(
        updates
          .slice(i, i + 20)
          .map(({ id, patch }) => supabase.from("smartstore_price_inventory").update(patch).eq("id", id).eq("user_id", userId)),
      );
    }
    for (let i = 0; i < inserts.length; i += 200) {
      const { error } = await supabase
        .from("smartstore_price_inventory")
        .upsert(inserts.slice(i, i + 200), { onConflict: "user_id,smartstore_product_id" });
      if (error) console.error("[smartstore-api/sync] insert 실패:", error.message);
    }

    const summary = `remote=${remote.length} byNo=${matchedByNo} byName=${matchedByName} created=${created} unmatched=${unmatched.length}`;
    await supabase.from("marketplace_api_logs").insert({
      user_id: userId,
      platform: "smartstore",
      credential_id: credentialId,
      action: "sync",
      status: "success",
      new_value: summary,
    });

    console.log(`[smartstore-api/sync] 완료: ${summary}`);
    return NextResponse.json({
      remoteCount: remote.length,
      matchedByNo,
      matchedByName,
      created,
      unmatched: unmatched.slice(0, 200),
      unmatchedCount: unmatched.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[smartstore-api/sync] 오류:", message);
    return NextResponse.json({ error: `스마트스토어 상품 동기화 실패: ${message}` }, { status: 500 });
  }
}
