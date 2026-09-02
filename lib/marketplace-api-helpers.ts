import { AUTOMATION_EXCLUDED_STATUSES, NO_AUTO_RESUME_STATUSES } from "@/lib/constants";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { CoupangOpenApiClient, roundCoupangPrice } from "@/lib/coupang-api";
import { NaverCommerceApiClient } from "@/lib/naver-commerce-api";
import { calcPlatformPrice, calcSettlementPrice, buildRateMap } from "@/lib/product-calculations";
import type { CommissionRate, CoupangPriceInventory, MarketplaceApiAction, Product, SmartstorePriceInventory } from "@/types/database";

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

/** 쿠팡 목표 판매가 — 고정가 우선, 없으면 정산가×수수료. null = 수수료율·고정가 모두 없음(반영 제외 대상) */
export function computeCoupangTargetPrice(product: Product, rateMap: ReturnType<typeof buildRateMap>): number | null {
  if (product.fixed_price_coupang != null) return roundCoupangPrice(product.fixed_price_coupang);
  const rate = rateMap[product.category]?.coupang ?? 0;
  if (rate <= 0) return null;
  return roundCoupangPrice(calcPlatformPrice(calcSettlementPrice(product.lowest_price, product.margin_rate), rate));
}

/** 스마트스토어 목표 판매가 — 계산 규칙은 computeCoupangTargetPrice 와 동일 구조 */
export function computeSmartstoreTargetPrice(product: Product, rateMap: ReturnType<typeof buildRateMap>): number | null {
  if (product.fixed_price_smartstore != null) return roundSmartstorePrice(product.fixed_price_smartstore);
  const rate = rateMap[product.category]?.smartstore ?? 0;
  if (rate <= 0) return null;
  return roundSmartstorePrice(calcPlatformPrice(calcSettlementPrice(product.lowest_price, product.margin_rate), rate));
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
    if (AUTOMATION_EXCLUDED_STATUSES.has(product.registration_status)) {
      blocked.push({ productId: id, productName: product.product_name, reason: "판매종료 상품은 마켓 API 반영에서 제외됩니다." });
      continue;
    }
    if (action === "resume" && NO_AUTO_RESUME_STATUSES.has(product.registration_status)) {
      blocked.push({ productId: id, productName: product.product_name, reason: `${product.registration_status} 상품은 판매재개하지 않습니다 (등록완료로 바꾼 뒤 수동 재개).` });
      continue;
    }

    const rows = inventoryByProductId.get(id) ?? [];
    if (rows.length === 0) {
      blocked.push({ productId: id, productName: product.product_name, reason: "쿠팡 양식 임포트 매칭이 없습니다." });
      continue;
    }

    let targetPrice: number | null = null;
    if (action === "price") {
      targetPrice = computeCoupangTargetPrice(product, rateMap);
      if (targetPrice == null) {
        blocked.push({ productId: id, productName: product.product_name, reason: "쿠팡 수수료율 또는 고정가가 없어 제외했습니다." });
        continue;
      }
      if (!targetPrice || targetPrice <= 0) {
        blocked.push({ productId: id, productName: product.product_name, reason: "계산된 쿠팡 판매가가 올바르지 않습니다." });
        continue;
      }
    }

    for (const row of rows) {
      // 쿠팡 엑셀의 "업체상품 ID"(vendor_item_id 컬럼)는 sellerProductId 이고, API 가 요구하는 vendorItemId 는 "옵션 ID"(option_id) 다.
      const vendorItemId = (row.option_id ?? "").trim();
      if (!vendorItemId) {
        blocked.push({ productId: id, productName: product.product_name, reason: "옵션 ID(vendorItemId)가 없어 API 반영이 불가합니다." });
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

// ───────────────────────── 스마트스토어 (네이버 커머스API) ─────────────────────────

export async function getNaverClientFromCredential(supabase: SupabaseClient, credentialId: string) {
  const { data, error } = await supabase
    .from("marketplace_api_credentials")
    .select("*")
    .eq("id", credentialId)
    .eq("platform", "smartstore")
    .single();

  if (error || !data) throw new Error("스마트스토어 API 계정을 찾을 수 없습니다.");

  const row = data as StoredMarketplaceApiCredential;
  if (!row.client_id_encrypted || !row.client_secret_encrypted) {
    throw new Error("스마트스토어 애플리케이션 ID/시크릿이 없습니다.");
  }

  return {
    credential: row,
    client: new NaverCommerceApiClient({
      clientId: decrypt(row.client_id_encrypted),
      clientSecret: decrypt(row.client_secret_encrypted),
    }),
  };
}

export interface SmartstorePreviewItem {
  productId: string;
  productName: string;
  originProductNo: string;
  channelProductNo: string;
  previousValue: string | null;
  newValue: string | null;
  action: MarketplaceApiAction;
}

export interface SmartstorePreviewResult {
  items: SmartstorePreviewItem[];
  blocked: CoupangPreviewBlockedItem[];
}

export function roundSmartstorePrice(price: number) {
  return Math.ceil(price / 10) * 10;
}

export async function buildSmartstorePreview(
  supabase: SupabaseClient,
  productIds: string[],
  action: MarketplaceApiAction,
  stockQuantity?: number | null,
): Promise<SmartstorePreviewResult> {
  const ids = [...new Set(productIds)].filter(Boolean);
  if (ids.length === 0) return { items: [], blocked: [] };

  const products: Product[] = [];
  const inventories: SmartstorePriceInventory[] = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data: productData, error: productErr } = await supabase.from("products").select("*").in("id", chunk);
    if (productErr) throw productErr;
    products.push(...((productData ?? []) as Product[]));

    const { data: inventoryData, error: inventoryErr } = await supabase
      .from("smartstore_price_inventory")
      .select("id,product_id,smartstore_product_id,product_name,sale_price,product_status,origin_product_no,channel_product_no,stock")
      .in("product_id", chunk);
    if (inventoryErr) throw inventoryErr;
    inventories.push(...((inventoryData ?? []) as SmartstorePriceInventory[]));
  }

  const { data: rates, error: ratesErr } = await supabase.from("commission_rates").select("*");
  if (ratesErr) throw ratesErr;
  const rateMap = buildRateMap((rates ?? []) as CommissionRate[]);
  const productMap = new Map(products.map((p) => [p.id, p]));
  const inventoryByProductId = new Map<string, SmartstorePriceInventory[]>();
  for (const row of inventories) {
    if (!row.product_id) continue;
    const list = inventoryByProductId.get(row.product_id) ?? [];
    list.push(row);
    inventoryByProductId.set(row.product_id, list);
  }

  const items: SmartstorePreviewItem[] = [];
  const blocked: CoupangPreviewBlockedItem[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    const product = productMap.get(id);
    if (!product) {
      blocked.push({ productId: id, productName: "(삭제된 상품)", reason: "상품을 찾을 수 없습니다." });
      continue;
    }
    if (AUTOMATION_EXCLUDED_STATUSES.has(product.registration_status)) {
      blocked.push({ productId: id, productName: product.product_name, reason: "판매종료 상품은 마켓 API 반영에서 제외됩니다." });
      continue;
    }
    if (action === "resume" && NO_AUTO_RESUME_STATUSES.has(product.registration_status)) {
      blocked.push({ productId: id, productName: product.product_name, reason: `${product.registration_status} 상품은 판매재개하지 않습니다 (등록완료로 바꾼 뒤 수동 재개).` });
      continue;
    }
    const rows = inventoryByProductId.get(id) ?? [];
    if (rows.length === 0) {
      blocked.push({ productId: id, productName: product.product_name, reason: "스마트스토어 양식 임포트 매칭이 없습니다." });
      continue;
    }

    let targetPrice: number | null = null;
    if (action === "price") {
      targetPrice = computeSmartstoreTargetPrice(product, rateMap);
      if (targetPrice == null) {
        blocked.push({ productId: id, productName: product.product_name, reason: "스마트스토어 수수료율 또는 고정가가 없어 제외했습니다." });
        continue;
      }
      if (!targetPrice || targetPrice <= 0) {
        blocked.push({ productId: id, productName: product.product_name, reason: "계산된 스마트스토어 판매가가 올바르지 않습니다." });
        continue;
      }
    }

    for (const row of rows) {
      const originProductNo = (row.origin_product_no ?? "").trim();
      if (!originProductNo) {
        blocked.push({ productId: id, productName: product.product_name, reason: "원상품번호가 없습니다. 설정에서 '스마트스토어 상품 동기화'를 먼저 실행하세요." });
        continue;
      }
      if (seen.has(originProductNo)) continue;
      seen.add(originProductNo);

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
        previousValue = row.product_status;
        newValue = "판매중지";
      } else if (action === "resume") {
        previousValue = row.product_status;
        newValue = "판매중";
      } else {
        blocked.push({ productId: id, productName: product.product_name, reason: "지원하지 않는 스마트스토어 작업입니다." });
        continue;
      }

      items.push({
        productId: id,
        productName: product.product_name,
        originProductNo,
        channelProductNo: row.channel_product_no ?? row.smartstore_product_id,
        previousValue,
        newValue,
        action,
      });
    }
  }

  return { items, blocked };
}

// ───────────────────────── 문의 공용 ─────────────────────────

/** 문의 동기화/답변용 플랫폼 클라이언트 + 쿠팡윙ID 조립 (sync·reply 라우트 공용) */
export async function getInquiryClients(
  supabase: SupabaseClient,
  cred: { id: string; platform: string; meta: unknown },
): Promise<{ coupang?: CoupangOpenApiClient; smartstore?: NaverCommerceApiClient; wingUserId: string | null }> {
  const clients = cred.platform === "coupang"
    ? { coupang: (await getCoupangClientFromCredential(supabase, cred.id)).client }
    : { smartstore: (await getNaverClientFromCredential(supabase, cred.id)).client };
  const meta = cred.meta as Record<string, unknown> | null;
  const wingUserId = typeof meta?.wingUserId === "string" ? meta.wingUserId : null;
  return { ...clients, wingUserId };
}
