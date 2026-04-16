"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { CommissionRate, CommissionPlatform } from "@/types/database";

/** 총수수료 자동 계산: vat/coupon_burden 제외 합산 후 vat 승수 적용 */
export function calcTotalRate(details: Record<string, number>): number {
  const exclude = new Set(["vat", "coupon_burden"]);
  let sum = 0;
  for (const [key, val] of Object.entries(details)) {
    if (!exclude.has(key)) sum += val;
  }
  const total = details.vat !== undefined ? sum * details.vat : sum;
  return Math.round(total * 100) / 100;
}

// 플랫폼별 수수료 항목 정의
export const PLATFORM_FEE_FIELDS: Record<CommissionPlatform, { key: string; label: string }[]> = {
  smartstore: [
    { key: "payment", label: "결제" },
    { key: "sales_linked", label: "매출연동" },
  ],
  esm: [
    { key: "category", label: "카테고리" },
    { key: "search", label: "검색" },
    { key: "coupon", label: "쿠폰" },
    { key: "coupon_burden", label: "쿠폰부담" },
    { key: "vat", label: "부가세" },
  ],
  coupang: [
    { key: "category", label: "카테고리" },
    { key: "vat", label: "부가세" },
  ],
  esm_5pct: [
    { key: "payment", label: "결제" },
    { key: "search", label: "검색" },
    { key: "coupon", label: "쿠폰" },
    { key: "coupon_burden", label: "쿠폰부담" },
    { key: "vat", label: "부가세" },
  ],
};

// 기본 수수료 데이터 (최초 시딩용)
const DEFAULT_CATEGORIES = [
  "물티슈", "가공식품", "펫", "욕실/세탁(세제샴푸등)",
  "화장품", "출산/유아동식품", "건강식품/다이어트", "뷰티기기(네일)", "계절가전",
];

const DEFAULT_RATES: Record<CommissionPlatform, { details: Record<string, number>; total: number }> = {
  smartstore: {
    details: { payment: 3.63, sales_linked: 2.00 },
    total: 5.63,
  },
  esm: {
    details: { category: 13.00, search: 2.00, coupon: 1.95, coupon_burden: 15, vat: 1.1 },
    total: 18.65,
  },
  coupang: {
    details: { category: 10.80, vat: 1.1 },
    total: 11.88,
  },
  esm_5pct: {
    details: { payment: 5.00, search: 2.00, coupon: 0.75, coupon_burden: 15, vat: 1.1 },
    total: 8.53,
  },
};

// 카테고리별 다른 기본값 (엑셀 스크린샷 기반)
const CATEGORY_OVERRIDES: Record<string, Partial<Record<CommissionPlatform, { details: Record<string, number>; total: number }>>> = {
  "물티슈": {
    esm: { details: { category: 9.00, search: 2.00, coupon: 1.35, coupon_burden: 15, vat: 1.1 }, total: 13.59 },
    coupang: { details: { category: 8.58, vat: 1.1 }, total: 9.44 },
  },
  "가공식품": {
    esm: { details: { category: 13.00, search: 2.00, coupon: 1.95, coupon_burden: 15, vat: 1.1 }, total: 18.65 },
    coupang: { details: { category: 10.90, vat: 1.1 }, total: 11.99 },
  },
  "펫": {
    esm: { details: { category: 13.00, search: 2.00, coupon: 1.95, coupon_burden: 15, vat: 1.1 }, total: 18.65 },
    coupang: { details: { category: 10.80, vat: 1.1 }, total: 11.88 },
  },
  "욕실/세탁(세제샴푸등)": {
    esm: { details: { category: 11.00, search: 2.00, coupon: 1.65, coupon_burden: 15, vat: 1.1 }, total: 16.12 },
    coupang: { details: { category: 7.80, vat: 1.1 }, total: 8.58 },
  },
  "화장품": {
    esm: { details: { category: 13.00, search: 2.00, coupon: 1.95, coupon_burden: 15, vat: 1.1 }, total: 18.65 },
    coupang: { details: { category: 9.60, vat: 1.1 }, total: 10.56 },
  },
  "출산/유아동식품": {
    esm: { details: { category: 9.00, search: 2.00, coupon: 1.35, coupon_burden: 15, vat: 1.1 }, total: 13.59 },
    coupang: { details: { category: 7.80, vat: 1.1 }, total: 8.58 },
  },
  "건강식품/다이어트": {
    esm: { details: { category: 13.00, search: 2.00, coupon: 1.95, coupon_burden: 15, vat: 1.1 }, total: 18.65 },
    coupang: { details: { category: 10.60, vat: 1.1 }, total: 11.66 },
  },
  "뷰티기기(네일)": {
    esm: { details: { category: 13.00, search: 2.00, coupon: 1.95, coupon_burden: 15, vat: 1.1 }, total: 18.65 },
    coupang: { details: { category: 9.60, vat: 1.1 }, total: 10.56 },
  },
  "계절가전": {
    esm: { details: { category: 13.00, search: 2.00, coupon: 1.95, coupon_burden: 15, vat: 1.1 }, total: 18.65 },
    coupang: { details: { category: 10.80, vat: 1.1 }, total: 11.88 },
  },
};

export function useCommissions() {
  const { user } = useAuth();
  const [rates, setRates] = useState<CommissionRate[]>([]);
  const [loading, setLoading] = useState(true);
  const seedingRef = useRef(false);

  const categories = useMemo(() => [...new Set(rates.map((r) => r.category))], [rates]);

  const userId = user?.id;

  const fetchRates = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    const { data, error } = await supabase
      .from("commission_rates")
      .select("*")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[use-commissions] 수수료율 조회 실패:", error instanceof Error ? error.message : String(error));
      setLoading(false);
      return;
    }

    if (!data || data.length === 0) {
      // 최초 접근: 기본 데이터 시딩 (중복 방지)
      if (!seedingRef.current) {
        seedingRef.current = true;
        await seedDefaults();
      }
      return;
    }

    setRates(data as CommissionRate[]);
    setLoading(false);
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const seedDefaults = async () => {
    if (!user) return;
    const platforms: CommissionPlatform[] = ["smartstore", "esm", "coupang", "esm_5pct"];
    const rows: Omit<CommissionRate, "id" | "created_at" | "updated_at">[] = [];

    DEFAULT_CATEGORIES.forEach((cat, catIdx) => {
      platforms.forEach((platform) => {
        const override = CATEGORY_OVERRIDES[cat]?.[platform];
        const base = DEFAULT_RATES[platform];
        const details = override?.details || base.details;
        const total = override?.total || base.total;

        rows.push({
          user_id: user.id,
          category: cat,
          platform,
          rate_details: details,
          total_rate: total,
          sort_order: catIdx,
        });
      });
    });

    const { error } = await supabase.from("commission_rates").insert(rows);
    if (error) {
      console.error("[use-commissions] 수수료 시딩 실패:", error.message);
      // 에러 시 (UNIQUE 위반 등) 재시딩 방지 — 직접 데이터만 조회
      const { data } = await supabase
        .from("commission_rates")
        .select("*")
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true });
      if (data && data.length > 0) {
        setRates(data as CommissionRate[]);
        setLoading(false);
      }
      return;
    }
    seedingRef.current = false;
    await fetchRates();
  };

  useEffect(() => {
    fetchRates();
  }, [fetchRates]);

  // 수수료율 업데이트 (optimistic)
  const updateRate = useCallback(
    (id: string, updates: { rate_details?: Record<string, number>; total_rate?: number }) => {
      setRates((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...updates, updated_at: new Date().toISOString() } : r))
      );

      supabase
        .from("commission_rates")
        .update(updates)
        .eq("id", id)
        .then(({ error }) => {
          if (error) {
            console.error("[use-commissions] 수수료율 업데이트 실패:", error instanceof Error ? error.message : String(error));
            fetchRates();
          }
        });
    },
    [fetchRates]
  );

  // 카테고리 추가
  const addCategory = useCallback(
    async (name: string) => {
      if (!user || categories.includes(name)) return;
      const platforms: CommissionPlatform[] = ["smartstore", "esm", "coupang", "esm_5pct"];
      const newOrder = categories.length;
      const rows = platforms.map((platform) => ({
        user_id: user.id,
        category: name,
        platform,
        rate_details: DEFAULT_RATES[platform].details,
        total_rate: DEFAULT_RATES[platform].total,
        sort_order: newOrder,
      }));

      const { error } = await supabase.from("commission_rates").insert(rows);
      if (error) {
        console.error("[use-commissions] 카테고리 추가 실패:", error instanceof Error ? error.message : String(error));
        return;
      }
      await fetchRates();
    },
    [user, categories, fetchRates]
  );

  // 카테고리 삭제
  const deleteCategory = useCallback(
    async (name: string) => {
      if (!user) return;
      const { error } = await supabase
        .from("commission_rates")
        .delete()
        .eq("user_id", user.id)
        .eq("category", name);

      if (error) {
        console.error("[use-commissions] 카테고리 삭제 실패:", error instanceof Error ? error.message : String(error));
        return;
      }
      await fetchRates();
    },
    [user, fetchRates]
  );

  return {
    rates,
    categories,
    loading,
    updateRate,
    addCategory,
    deleteCategory,
    refetch: fetchRates,
  };
}
