"use client";

import { useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { groupIntoBatches } from "@/lib/log-format";
import type { BatchLogEntry } from "@/lib/log-format";

export type { BatchLogEntry };

const LAST_READ_KEY = "notifications_last_read";

export function useNotifications() {
  const { user } = useAuth();
  const [batches, setBatches] = useState<BatchLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRead, setLastRead] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(LAST_READ_KEY) ?? "";
  });

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [purchaseRes, trackingRes] = await Promise.all([
        supabase
          .from("purchase_logs")
          .select("batch_id,platform,status,created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(150),
        supabase
          .from("tracking_logs")
          .select("batch_id,platform,status,created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(150),
      ]);

      type LogRow = { batch_id: string; platform: string; status: string; created_at: string };
      const merged = [
        ...groupIntoBatches((purchaseRes.data ?? []) as LogRow[], "purchase"),
        ...groupIntoBatches((trackingRes.data ?? []) as LogRow[], "tracking"),
      ]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 20);

      setBatches(merged);
    } finally {
      setLoading(false);
    }
  }, [user]);

  const markAsRead = useCallback(() => {
    const now = new Date().toISOString();
    localStorage.setItem(LAST_READ_KEY, now);
    setLastRead(now);
  }, []);

  const unreadCount = batches.filter(
    (b) => !lastRead || b.startedAt > lastRead
  ).length;

  return { batches, loading, unreadCount, lastRead, fetchNotifications, markAsRead };
}
