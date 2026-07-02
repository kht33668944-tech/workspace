import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient, roundCoupangPrice } from "@/lib/coupang-api";
import { calcPlatformPrice, calcSettlementPrice, buildRateMap } from "@/lib/product-calculations";
import type { CommissionRate, CoupangPriceInventory, MarketplaceApiAction, Product } from "@/types/database";

export interface StoredMarketplaceApiCredential {
  id: string;
  user_id: string;
  platform: "coupang" | "smartstore" | "esm";
  label: string | null;
  account_id: string;
  access_key_encrypted: string | null;
  secret_key_encrypted: string | null;
  client_id_encrypted: string | null;
  client_secret_encrypted: string | null;
  meta: Record<string, unknown>;
  last_tested_at: string | null;
  last_test_status: "success" | "failed" | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicMarketplaceApiCredential {
  id: string;
  user_id: string;
  platform: "coupang" | "smartstore" | "esm";
  label: string | null;
  account_id: string;
  meta: Record<string, unknown>;
  last_tested_at: string | null;
  last_test_status: "success" | "failed" | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface CoupangPreviewItem {
  productId: string;
  productName: string;
  vendorItemId: string;
  optionId: string | null;
  optionName: string | null;
  previousValue: string | null;
  newValue: string | null;
  action: MarketplaceApiAction;
}

export interface CoupangPreviewBlockedItem {
  productId: string | null;
  productName: string;
  reason: string;
}

export interface CoupangPreviewResult {
  items: CoupangPreviewItem[];
  blocked: CoupangPreviewBlockedItem[];
}

export function toPublicMarketplaceCredential(row: StoredMarketplaceApiCredential): PublicMarketplaceApiCredential {
  return {
    id: row.id,
    user_id: row.user_id,
    platform: row.platform,
    label: row.label,
    account_id: row.account_id,
    meta: row.meta ?? {},
    last_tested_at: row.last_tested_at,
    last_test_status: row.last_test_status,
    last_test_message: row.last_test_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getCoupangClientFromCredential(
  supabase: SupabaseClient,
  credentialId: string,
) {
  const { data, error } = await supabase
    .from("marketplace_api_credentials")
    .select("*")
    .eq("id", credentialId)
    .eq("platform", "coupang")
    .single();

  if (error || !data) throw new Error("쿠팡 API 계정을 찾을 수 없습니다.");

  const row = data as StoredMarketplaceApiCredential;
  if (!row.access_key_encrypted || !row.secret_key_encrypted || !row.account_id) {
    throw new Error("쿠팡 API 키 정보가 부족합니다.");
  }

  return {
    credential: row,
    client: new CoupangOpenApiClient({
      vendorId: row.account_id,
      accessKey: decrypt(row.access_key_encrypted),
      secretKey: decrypt(row.secret_key_encrypted),
    }),
  };
}

export async function buildCoupangPreview(
  supabase: SupabaseClient,
  productIds: string[],
  action: MarketplaceApiAction,
  stockQuantity?: number | null,
): Promise<CoupangPreviewResult> {
  const ids = [...new Set(productIds)].filter(Boolean);
  if (ids.length === 0) return { items: [], blocked: [] };

  const products: Product[] = [];
  const inventories: CoupangPriceInventory[] = [];
  const CHUNK = 200;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data: productData, error: productErr } = await supabase
      .from("products")
      .select("*")
      .in("id", chunk);
    if (productErr) throw productErr;
    products.push(...((productData ?? []) as Product[]));

    const { data: inventoryData, error: inventoryErr } = await supabase
      .from("coupang_price_inventory")
      .select("*")
      .in("product_id", chunk);
    if (inventoryErr) throw inventoryErr;
    inventories.push(...((inventoryData ?? []) as CoupangPriceInventory[]));
  }

  const { data: rates, error: ratesErr } = await supabase.from("commission_rates").select("*");
  if (ratesErr) throw ratesErr;
  const rateMap = buildRateMap((rates ?? []) as CommissionRate[]);
  const productMap = new Map(products.map((p) => [p.id, p]));
  const inventoryByProductId = new Map<string, CoupangPriceInventory[]>();
  for (const row of inventories) {
    if (!row.product_id) continue;
    const list = inventoryByProductId.get(row.product_id) ?? [];
    list.push(row);
    inventoryByProductId.set(row.product_id, list);
  }

  const items: CoupangPreviewItem[] = [];
  const blocked: CoupangPreviewBlockedItem[] = [];
  const seenVendorItemIds = new Set<string>();

  for (const id of ids) {
    const product = productMap.get(id);
    if (!product) {
      blocked.push({ productId: id, productName: "(삭제된 상품)", reason: "상품을 찾을 수 없습니다." });
      continue;
    }

    const rows = inventoryByProductId.get(id) ?? [];
    if (rows.length === 0) {
      blocked.push({ productId: id, productName: product.product_name, reason: "쿠팡 양식 임포트 매칭이 없습니다." });
      continue;
    }

    let targetPrice: number | null = null;
    if (action === "price") {
      if (product.fixed_price_coupang != null) {
        targetPrice = roundCoupangPrice(product.fixed_price_coupang);
      } else {
        const rate = rateMap[product.category]?.coupang ?? 0;
        if (rate <= 0) {
          blocked.push({ productId: id, productName: product.product_name, reason: "쿠팡 수수료율 또는 고정가가 없어 제외했습니다." });
          continue;
        }
        const settlement = calcSettlementPrice(product.lowest_price, product.margin_rate);
        targetPrice = roundCoupangPrice(calcPlatformPrice(settlement, rate));
      }
      if (!targetPrice || targetPrice <= 0) {
        blocked.push({ productId: id, productName: product.product_name, reason: "계산된 쿠팡 판매가가 올바르지 않습니다." });
        continue;
      }
    }

    for (const row of rows) {
      const vendorItemId = (row.vendor_item_id ?? "").trim();
      if (!vendorItemId) {
        blocked.push({ productId: id, productName: product.product_name, reason: "vendorItemId가 없어 API 반영이 불가합니다." });
        continue;
      }
      if (seenVendorItemIds.has(vendorItemId)) continue;
      seenVendorItemIds.add(vendorItemId);

      let previousValue: string | null = null;
      let newValue: string | null = null;
      if (action === "price") {
        previousValue = row.sale_price != null ? String(row.sale_price) : null;
        newValue = String(targetPrice);
      } else if (action === "stock") {
        const qty = stockQuantity ?? row.stock;
        if (qty == null || !Number.isInteger(qty) || qty < 0) {
          blocked.push({ productId: id, productName: product.product_name, reason: "재고 수량이 올바르지 않습니다." });
          continue;
        }
        previousValue = row.stock != null ? String(row.stock) : null;
        newValue = String(qty);
      } else if (action === "stop") {
        previousValue = row.sale_status;
        newValue = "판매중지";
      } else if (action === "resume") {
        previousValue = row.sale_status;
        newValue = "판매재개";
      } else {
        blocked.push({ productId: id, productName: product.product_name, reason: "지원하지 않는 쿠팡 작업입니다." });
        continue;
      }

      items.push({
        productId: id,
        productName: product.product_name,
        vendorItemId,
        optionId: row.option_id,
        optionName: row.option_name,
        previousValue,
        newValue,
        action,
      });
    }
  }

  return { items, blocked };
}
