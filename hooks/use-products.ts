"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { Product, ProductUpdate } from "@/types/database";

interface UseProductsOptions {
  search?: string;
  categoryFilter?: string | null;
  columnFilters?: Record<string, string[]>;
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

export function useProducts(options: UseProductsOptions = {}) {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const undoStackRef = useRef<UndoGroup[]>([]);
  const batchUndoRef = useRef<UndoEntry[] | null>(null);
  const pinnedIdsRef = useRef<Set<string> | null>(null);
  const prevFiltersKeyRef = useRef<string>("");
  const fetchGenRef = useRef(0);
  const prevFetchGenRef = useRef(0);

  const fetchProducts = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const PAGE_SIZE = 1000;
    const allData: Product[] = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from("products")
        .select("*")
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (options.search) {
        const s = options.search.replace(/[%_\\]/g, "\\$&");
        query = query.or(
          `product_name.ilike.%${s}%,category.ilike.%${s}%,lowest_price_platform.ilike.%${s}%,purchase_url.ilike.%${s}%,memo.ilike.%${s}%`
        );
      }

      const { data, error } = await query;
      if (error) {
        console.error("Failed to fetch products:", error);
        break;
      }

      allData.push(...(data as Product[]));
      hasMore = data.length === PAGE_SIZE;
      from += PAGE_SIZE;
    }

    setProducts(allData);
    fetchGenRef.current++;
    setLoading(false);
  }, [user, options.search]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // 클라이언트 측 컬럼 필터링
  const filtersKey = JSON.stringify(options.columnFilters || {});
  const hasActiveFilters = Object.entries(options.columnFilters || {}).some(([, v]) => v.length > 0);

  if (filtersKey !== prevFiltersKeyRef.current || fetchGenRef.current !== prevFetchGenRef.current) {
    prevFiltersKeyRef.current = filtersKey;
    prevFetchGenRef.current = fetchGenRef.current;
    if (!hasActiveFilters) {
      pinnedIdsRef.current = null;
    } else {
      pinnedIdsRef.current = new Set(
        applyColumnFilters(products, options.columnFilters || {}).map((p) => p.id)
      );
    }
  }

  let filteredProducts = pinnedIdsRef.current
    ? products.filter((p) => pinnedIdsRef.current!.has(p.id))
    : products;

  // 카테고리 필터 (서버 쿼리 대신 클라이언트 필터링)
  if (options.categoryFilter) {
    filteredProducts = filteredProducts.filter((p) => p.category === options.categoryFilter);
  }

  const insertProducts = async (rows: Omit<Product, "id" | "created_at" | "updated_at">[]) => {
    if (!user) return { error: "Not authenticated" };
    const withUserId = rows.map((row) => ({ ...row, user_id: user.id }));

    const BATCH_SIZE = 500;
    for (let i = 0; i < withUserId.length; i += BATCH_SIZE) {
      const batch = withUserId.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("products").insert(batch);
      if (error) return { error: error.message };
    }

    await fetchProducts();
    return { error: null };
  };

  // 단일 상품 추가
  const addProduct = async () => {
    if (!user) return;
    const newProduct = {
      user_id: user.id,
      product_name: "",
      lowest_price: 0,
      lowest_price_platform: "",
      margin_rate: 0,
      category: "",
      purchase_url: "",
      memo: "",
      sort_order: products.length,
    };

    const { data, error } = await supabase
      .from("products")
      .insert(newProduct)
      .select()
      .single();

    if (error) {
      console.error("Failed to add product:", error);
      return;
    }

    setProducts((prev) => [...prev, data as Product]);
  };

  // Optimistic update
  const updateProduct = useCallback((id: string, updates: ProductUpdate, skipUndo = false) => {
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
        return prev.map((p) => (p.id === id ? { ...p, ...updates } : p));
      });
    } else {
      setProducts((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...updates } : p))
      );
    }

    supabase
      .from("products")
      .update(updates)
      .eq("id", id)
      .then(({ error }) => {
        if (error) {
          console.error("Update product failed:", error);
          fetchProducts();
        }
      });
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
    if (!group) return;
    for (let i = group.entries.length - 1; i >= 0; i--) {
      const entry = group.entries[i];
      if (entry.type === "update") {
        updateProduct(entry.id, entry.prev, true);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteProducts = async (ids: string[]) => {
    const BATCH_SIZE = 100;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("products").delete().in("id", batch);
      if (error) return { error: error.message };
    }
    await fetchProducts();
    return { error: null };
  };

  return {
    products: filteredProducts,
    allProducts: products,
    loading,
    refetch: fetchProducts,
    addProduct,
    insertProducts,
    updateProduct,
    deleteProducts,
    undo,
    startBatchUndo,
    endBatchUndo,
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
