"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { fetchAllPages } from "@/lib/supabase-paginate";
import type { MarketplaceInquiry } from "@/types/database";

/** 문의에 연결된 발주서 주문 요약 (join) */
export interface InquiryOrderSummary {
  id: string;
  delivery_status: string | null;
  tracking_no: string | null;
  courier: string | null;
  purchased_at: string | null;
  order_date: string | null;
  ship_by_date: string | null;
  recipient_name: string | null;
  product_name: string | null;
  quantity: number | null;
  marketplace: string | null;
}

export type InquiryWithOrder = MarketplaceInquiry & { order: InquiryOrderSummary | null };

interface UseInquiriesOptions {
  status?: "unanswered" | "answered" | null;
  platform?: string | null;
  search?: string;
}

export interface InquiryDay {
  date: string;
  inquiries: InquiryWithOrder[];
}

export function useInquiries(options: UseInquiriesOptions = {}) {
  const { user } = useAuth();
  const [inquiries, setInquiries] = useState<InquiryWithOrder[]>([]);
  const [counts, setCounts] = useState({ unanswered: 0, answered: 0 });
  const [loading, setLoading] = useState(true);

  const userId = user?.id;

  const fetchList = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    const { rows, error } = await fetchAllPages<InquiryWithOrder>((from, to) => {
      let query = supabase
        .from("marketplace_inquiries")
        .select("*, order:orders(id, delivery_status, tracking_no, courier, purchased_at, order_date, ship_by_date, recipient_name, product_name, quantity, marketplace)")
        .eq("user_id", userId)
        .order("inquiry_at", { ascending: false, nullsFirst: false })
        .range(from, to);

      if (options.status) query = query.eq("status", options.status);
      if (options.platform) query = query.eq("platform", options.platform);
      if (options.search) {
        const s = options.search.replace(/[%_\\]/g, "\\$&");
        query = query.or(`product_name.ilike.%${s}%,content.ilike.%${s}%`);
      }
      return query as unknown as PromiseLike<{ data: InquiryWithOrder[] | null; error: { message: string } | null }>;
    });
    if (error) console.error("[use-inquiries] 조회 실패:", error);

    setInquiries(rows);
    setLoading(false);
  }, [userId, options.status, options.platform, options.search]);

  // 미답변/답변완료 칩 카운트 — 필터와 무관한 전체 기준이라 필터 변경 시 재조회하지 않는다
  const fetchCounts = useCallback(async () => {
    if (!userId) return;
    const [un, an] = await Promise.all([
      supabase.from("marketplace_inquiries").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("status", "unanswered"),
      supabase.from("marketplace_inquiries").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("status", "answered"),
    ]);
    setCounts({ unanswered: un.count ?? 0, answered: an.count ?? 0 });
  }, [userId]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  const refetch = useCallback(async () => {
    await Promise.all([fetchList(), fetchCounts()]);
  }, [fetchList, fetchCounts]);

  const groupedByDay: InquiryDay[] = useMemo(() => {
    const dayMap = new Map<string, InquiryWithOrder[]>();
    for (const inq of inquiries) {
      const date = (inq.inquiry_at ?? inq.created_at).slice(0, 10);
      const arr = dayMap.get(date) || [];
      arr.push(inq);
      dayMap.set(date, arr);
    }
    return [...dayMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, dayInquiries]) => ({ date, inquiries: dayInquiries }));
  }, [inquiries]);

  return { inquiries, groupedByDay, counts, loading, refetch };
}
