"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import type { Product, ProductInsert, ProductUpdate } from "@/types/database";

function urlToStoragePath(publicUrl: string): string {
  const marker = "/product-images/";
  const idx = publicUrl.indexOf(marker);
  return idx >= 0 ? publicUrl.slice(idx + marker.length) : publicUrl;
}

export interface PriceChangeFilter {
  minPercent: number | null; // 하한 (예: -3)
  maxPercent: number | null; // 상한 (예: 5)
}

interface UseProductsOptions {
  search?: string;
  categoryFilter?: string | null;
  columnFilters?: Record<string, string[]>;
  priceChangeFilter?: PriceChangeFilter | null;
}

interface UndoEntry {
  type: "update";
  id: string;
  prev: ProductUpdate;
  next: ProductUpdate;
}

interface UndoGroup {
  entries: UndoEntry[];
}

const MAX_UNDO = 20;

// detail_html은 payload가 크므로 목록 조회 시 제외. 필요 시 fetchProductDetailHtml로 단건 조회.
const PRODUCT_LIST_COLUMNS =
  "id, user_id, product_name, lowest_price, margin_rate, category, source_category, purchase_url, memo, sort_order, thumbnail_url, image_urls, source_platform, detail_image_url, registration_status, platform_codes, seller_code, fixed_price_smartstore, fixed_price_esm, fixed_price_coupang, created_at, updated_at";

export async function fetchProductDetailHtml(productId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("products")
    .select("detail_html")
    .eq("id", productId)
    .single();
  if (error) {
    console.error("[use-products] detail_html 조회 실패:", error.message);
    return null;
  }
  return (data as { detail_html: string | null } | null)?.detail_html ?? null;
}

export function useProducts(options: UseProductsOptions = {}) {
  const { user, session } = useAuth();
  const { showToast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [priceChanges, setPriceChanges] = useState<Record<string, number>>({});
  const undoStackRef = useRef<UndoGroup[]>([]);
  const batchUndoRef = useRef<UndoEntry[] | null>(null);
  const pinnedIdsRef = useRef<Set<string> | null>(null);
  const prevFiltersKeyRef = useRef<string>("");
  const fetchGenRef = useRef(0);
  const prevFetchGenRef = useRef(0);
  // DB 업데이트 디바운스: 같은 상품에 대한 빠른 연속 업데이트를 하나로 합침
  const pendingDbUpdates = useRef<Map<string, { updates: ProductUpdate; timer: ReturnType<typeof setTimeout> }>>(new Map());
  // 상품 추가 시 중복 없는 sort_order 보장
  const nextSortOrderRef = useRef(0);

  const userId = user?.id;

  const fetchProducts = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    const PAGE_SIZE = 1000;
    const allData: Product[] = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from("products")
        .select(PRODUCT_LIST_COLUMNS)
        .eq("user_id", userId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (options.search) {
        const s = options.search.replace(/[%_\\]/g, "\\$&").replace(/[,().]/g, "");
        query = query.or(
          `product_name.ilike.%${s}%,category.ilike.%${s}%,purchase_url.ilike.%${s}%,memo.ilike.%${s}%`
        );
      }

      const { data, error } = await query;
      if (error) {
        console.error("[use-products] 상품 조회 실패:", error instanceof Error ? error.message : String(error));
        break;
      }

      allData.push(...(data as unknown as Product[]));
      hasMore = data.length === PAGE_SIZE;
      from += PAGE_SIZE;
    }

    // detail_html 보유 여부만 별도로 조회 (내용은 전송하지 않음)
    const { data: detailRows } = await supabase
      .from("products")
      .select("id")
      .eq("user_id", userId)
      .not("detail_html", "is", null);
    const detailSet = new Set((detailRows ?? []).map((r: { id: string }) => r.id));

    for (const p of allData) {
      p.detail_html = null;
      p.has_detail_html = detailSet.has(p.id);
    }

    setProducts(allData);
    fetchGenRef.current++;
    nextSortOrderRef.current = allData.reduce((max, p) => Math.max(max, p.sort_order ?? 0), -1) + 1;
    setLoading(false);
  }, [userId, options.search]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const priceChangesFetchedRef = useRef(false);
  const fetchPriceChanges = useCallback(() => {
    if (!session?.access_token) return;
    const today = new Date().toISOString().slice(0, 10);
    fetch(`/api/products/price-history?from=${today}&to=${today}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(r => r.json())
      .then((json: { history?: Array<{ product_id: string; change_rate: number }> }) => {
        const map: Record<string, number> = {};
        (json.history ?? []).forEach(h => {
          if (!(h.product_id in map)) map[h.product_id] = h.change_rate;
        });
        setPriceChanges(prev => {
          const prevKeys = Object.keys(prev);
          const mapKeys = Object.keys(map);
          if (prevKeys.length === mapKeys.length && mapKeys.every(k => prev[k] === map[k])) return prev;
          return map;
        });
      })
      .catch(() => {});
  }, [session?.access_token]);

  useEffect(() => {
    if (loading || priceChangesFetchedRef.current) return;
    priceChangesFetchedRef.current = true;
    fetchPriceChanges();
  }, [loading, fetchPriceChanges]);

  // 클라이언트 측 컬럼 필터링
  const filtersKey = JSON.stringify(options.columnFilters || {});
  const hasActiveFilters = Object.entries(options.columnFilters || {}).some(([, v]) => v.length > 0);

  if (filtersKey !== prevFiltersKeyRef.current) {
    // 필터 설정 변경 시에만 전체 재평가
    prevFiltersKeyRef.current = filtersKey;
    prevFetchGenRef.current = fetchGenRef.current;
    if (!hasActiveFilters) {
      pinnedIdsRef.current = null;
    } else {
      pinnedIdsRef.current = new Set(
        applyColumnFilters(products, options.columnFilters || {}).map((p) => p.id)
      );
    }
  } else if (fetchGenRef.current !== prevFetchGenRef.current && hasActiveFilters && pinnedIdsRef.current) {
    // 데이터 refetch 시: 삭제된 행 제거 + 새로 매칭되는 행 추가 (기존 pinned 유지)
    prevFetchGenRef.current = fetchGenRef.current;
    const currentIds = new Set(products.map(p => p.id));
    pinnedIdsRef.current = new Set([...pinnedIdsRef.current].filter(id => currentIds.has(id)));
    const newMatching = applyColumnFilters(products, options.columnFilters || {});
    for (const p of newMatching) {
      pinnedIdsRef.current.add(p.id);
    }
  }

  let filteredProducts = pinnedIdsRef.current
    ? products.filter((p) => pinnedIdsRef.current!.has(p.id))
    : products;

  // 카테고리 필터 (서버 쿼리 대신 클라이언트 필터링)
  if (options.categoryFilter) {
    filteredProducts = filteredProducts.filter((p) => p.category === options.categoryFilter);
  }

  // 전일대비 범위 필터
  if (options.priceChangeFilter) {
    let { minPercent, maxPercent } = options.priceChangeFilter;
    // min > max이면 자동 swap (예: min=-0.5, max=-20 → min=-20, max=-0.5)
    if (minPercent !== null && maxPercent !== null && minPercent > maxPercent) {
      [minPercent, maxPercent] = [maxPercent, minPercent];
    }
    filteredProducts = filteredProducts.filter((p) => {
      const change = priceChanges[p.id] ?? 0;
      if (minPercent !== null && change < minPercent) return false;
      if (maxPercent !== null && change > maxPercent) return false;
      return true;
    });
  }

  const insertProducts = async (rows: ProductInsert[]) => {
    if (!user) return { error: "Not authenticated" };
    const startSort = nextSortOrderRef.current;
    const withUserId = rows.map((row, i) => ({ ...row, user_id: user.id, sort_order: startSort + i }));

    const inserted: Product[] = [];
    const BATCH_SIZE = 500;
    for (let i = 0; i < withUserId.length; i += BATCH_SIZE) {
      const batch = withUserId.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase.from("products").insert(batch).select();
      if (error) return { error: error.message };
      if (data) inserted.push(...(data as Product[]));
    }

    inserted.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    // detail_html payload 메모리 보유를 피하기 위해 플래그만 남기고 null 처리
    for (const p of inserted) {
      p.has_detail_html = Boolean(p.detail_html);
      p.detail_html = null;
    }
    setProducts((prev) => [...prev, ...inserted]);
    nextSortOrderRef.current = startSort + inserted.length;
    fetchGenRef.current++;
    return { error: null };
  };

  // 단일 상품 추가
  const addProduct = async () => {
    if (!user) return;
    const sortOrder = nextSortOrderRef.current++;
    const newProduct = {
      user_id: user.id,
      product_name: "",
      lowest_price: 0,
      margin_rate: 0,
      category: "",
      purchase_url: "",
      memo: "",
      sort_order: sortOrder,
    };

    const { data, error } = await supabase
      .from("products")
      .insert(newProduct)
      .select()
      .single();

    if (error) {
      console.error("[use-products] 상품 추가 실패:", error instanceof Error ? error.message : String(error));
      return;
    }

    const newRow = { ...(data as Product), detail_html: null, has_detail_html: false };
    setProducts((prev) => [...prev, newRow]);
  };

  // Optimistic update — DB 쓰기는 50ms 디바운스로 같은 상품 업데이트를 합침
  const updateProduct = useCallback((id: string, updates: ProductUpdate, skipUndo = false) => {
    const hasDetailKey = Object.prototype.hasOwnProperty.call(updates, "detail_html");
    const mergeRow = (p: Product): Product => {
      if (p.id !== id) return p;
      const merged: Product = { ...p, ...updates };
      if (hasDetailKey) merged.has_detail_html = Boolean(updates.detail_html);
      return merged;
    };
    if (!skipUndo) {
      setProducts((prev) => {
        const product = prev.find((p) => p.id === id);
        if (product) {
          const prevUpdates: ProductUpdate = {};
          for (const key of Object.keys(updates) as (keyof ProductUpdate)[]) {
            (prevUpdates as Record<string, unknown>)[key] = product[key as keyof Product];
          }
          const entry: UndoEntry = { type: "update", id, prev: prevUpdates, next: updates };
          if (batchUndoRef.current) {
            batchUndoRef.current.push(entry);
          } else {
            undoStackRef.current.push({ entries: [entry] });
            if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
          }
        }
        return prev.map(mergeRow);
      });
    } else {
      setProducts((prev) => prev.map(mergeRow));
    }

    // 디바운스: 같은 상품에 대한 연속 업데이트를 하나의 DB 요청으로 합침
    const pending = pendingDbUpdates.current.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      Object.assign(pending.updates, updates);
    } else {
      pendingDbUpdates.current.set(id, { updates: { ...updates }, timer: setTimeout(() => {}, 0) });
    }
    const entry = pendingDbUpdates.current.get(id)!;
    entry.timer = setTimeout(() => {
      const merged = entry.updates;
      pendingDbUpdates.current.delete(id);
      supabase
        .from("products")
        .update(merged)
        .eq("id", id)
        .then(({ error }) => {
          if (error) {
            console.error("[use-products] 상품 업데이트 실패:", error instanceof Error ? error.message : String(error));
            fetchProducts();
          }
        });
    }, 50);
  }, [fetchProducts]);

  const startBatchUndo = useCallback(() => {
    batchUndoRef.current = [];
  }, []);

  const endBatchUndo = useCallback(() => {
    if (batchUndoRef.current && batchUndoRef.current.length > 0) {
      undoStackRef.current.push({ entries: batchUndoRef.current });
      if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
    }
    batchUndoRef.current = null;
  }, []);

  const undo = useCallback(() => {
    const group = undoStackRef.current.pop();
    if (!group) {
      showToast("더 이상 취소할 수 없습니다", "info");
      return;
    }
    for (let i = group.entries.length - 1; i >= 0; i--) {
      const entry = group.entries[i];
      if (entry.type === "update") {
        updateProduct(entry.id, entry.prev, true);
      }
    }
    showToast(
      `실행 취소 (${group.entries.length}개 변경)`,
      "info"
    );
  }, [showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteProducts = useCallback(async (ids: string[]) => {
    const idSet = new Set(ids);

    // 삭제 대상 상품의 이미지 경로 수집 (현재 state에서)
    const storagePaths: string[] = [];
    setProducts((prev) => {
      for (const p of prev) {
        if (!idSet.has(p.id)) continue;
        if (p.image_urls?.length) storagePaths.push(...p.image_urls.map(urlToStoragePath));
        if (p.detail_image_url) storagePaths.push(urlToStoragePath(p.detail_image_url));
      }
      return prev;
    });

    // Storage 이미지 삭제
    if (storagePaths.length > 0) {
      const STORAGE_BATCH = 100;
      for (let i = 0; i < storagePaths.length; i += STORAGE_BATCH) {
        await supabase.storage.from("product-images").remove(storagePaths.slice(i, i + STORAGE_BATCH));
      }
    }

    // DB 레코드 삭제
    const BATCH_SIZE = 100;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("products").delete().in("id", batch);
      if (error) {
        console.error("[use-products] DB 삭제 실패:", error.message);
        return { error: error.message };
      }
    }

    // DB 삭제 성공 후 로컬 state 업데이트
    setProducts((prev) => prev.filter((p) => !idSet.has(p.id)));
    fetchGenRef.current++;
    return { error: null };
  }, []);

  const updateProductImages = useCallback(
    (id: string, imageUrls: string[], thumbnailUrl: string | null) => {
      updateProduct(id, { image_urls: imageUrls, thumbnail_url: thumbnailUrl }, true);
    },
    [updateProduct]
  );

  return {
    products: filteredProducts,
    allProducts: products,
    loading,
    refetch: fetchProducts,
    addProduct,
    insertProducts,
    updateProduct,
    updateProductImages,
    deleteProducts,
    undo,
    startBatchUndo,
    endBatchUndo,
    priceChanges,
    refetchPriceChanges: fetchPriceChanges,
  };
}

function applyColumnFilters(products: Product[], filters: Record<string, string[]>): Product[] {
  const activeFilters = Object.entries(filters).filter(([, v]) => v.length > 0);
  if (activeFilters.length === 0) return products;

  return products.filter((product) =>
    activeFilters.every(([key, allowedValues]) => {
      if (allowedValues.length === 1 && allowedValues[0] === "__NONE__") return false;
      const raw = product[key as keyof Product];
      const cellVal = raw === null || raw === undefined || raw === "" ? "(빈 값)" : String(raw);
      return allowedValues.includes(cellVal);
    })
  );
}
