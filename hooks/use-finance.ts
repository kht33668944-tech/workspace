"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { recalcTotals } from "@/lib/finance-utils";
import type {
  DailySnapshot,
  DailySnapshotUpdate,
  CardEntry,
  PlatformEntry,
  CashEntry,
} from "@/types/database";

export interface SnapshotChanges {
  totalCards: number;
  totalPlatforms: number;
  totalCash: number;
  netBalance: number;
  cards: { name: string; totalChange: number }[];
  platforms: { name: string; totalChange: number }[];
}

function getLocalDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return getLocalDateStr(d);
}

function computeChanges(current: DailySnapshot | null, prev: DailySnapshot | null): SnapshotChanges | null {
  if (!current || !prev) return null;
  return {
    totalCards: current.total_cards - prev.total_cards,
    totalPlatforms: current.total_platforms - prev.total_platforms,
    totalCash: current.total_cash - prev.total_cash,
    netBalance: current.net_balance - prev.net_balance,
    cards: current.cards.map((c) => {
      const p = prev.cards.find((pc) => pc.name === c.name);
      return { name: c.name, totalChange: p ? c.total - p.total : c.total };
    }),
    platforms: current.platforms.map((p) => {
      const pp = prev.platforms.find((pp) => pp.name === p.name);
      return { name: p.name, totalChange: pp ? p.total - pp.total : p.total };
    }),
  };
}

export function useFinance() {
  const { session } = useAuth();
  const [snapshot, setSnapshot] = useState<DailySnapshot | null>(null);
  const [prevSnapshot, setPrevSnapshot] = useState<DailySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saving = saveStatus === "saving";
  const [selectedDate, setSelectedDate] = useState<string>(getLocalDateStr());

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchGenRef = useRef(0);

  // ─── Fetch ───
  const fetchSnapshot = useCallback(
    async (date: string) => {
      if (!session?.access_token) return;
      const gen = ++fetchGenRef.current;
      setLoading(true);

      try {
        const res = await fetch(`/api/finance?date=${date}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (gen !== fetchGenRef.current) return;
        if (!res.ok) {
          console.error("[Finance] fetch error:", await res.text());
          setSnapshot(null);
          setPrevSnapshot(null);
          return;
        }
        const json = await res.json();
        setSnapshot(json.snapshot ?? null);
        setPrevSnapshot(json.prevSnapshot ?? null);
      } catch (e) {
        console.error("[Finance] fetch error:", e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === fetchGenRef.current) setLoading(false);
      }
    },
    [session?.access_token]
  );

  useEffect(() => {
    fetchSnapshot(selectedDate);
  }, [selectedDate, fetchSnapshot]);

  // ─── Save (debounced) ───
  const saveSnapshot = useCallback(
    async (updates: DailySnapshotUpdate) => {
      if (!snapshot || !session?.access_token) return;

      // 즉시 로컬 상태 업데이트 (optimistic)
      const cards = (updates.cards ?? snapshot.cards) as CardEntry[];
      const platforms = (updates.platforms ?? snapshot.platforms) as PlatformEntry[];
      const cash = (updates.cash ?? snapshot.cash) as CashEntry[];
      const pending = updates.pending_purchase ?? snapshot.pending_purchase;
      const totals = recalcTotals(cards, platforms, cash, pending);

      const merged: DailySnapshot = {
        ...snapshot,
        ...updates,
        ...totals,
      };
      setSnapshot(merged);

      // 디바운스 저장
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaveStatus("saving");

      saveTimerRef.current = setTimeout(async () => {
        try {
          setSaveStatus("saving");
          const res = await fetch(`/api/finance/${snapshot.id}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify(updates),
          });

          if (!res.ok) {
            console.error("[Finance] save error:", await res.text());
            setSaveStatus("error");
            return;
          }

          const json = await res.json();
          setSnapshot(json.snapshot);
          if (json.prevSnapshot) setPrevSnapshot(json.prevSnapshot);
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 2000);
        } catch (e) {
          console.error("[Finance] save error:", e instanceof Error ? e.message : String(e));
          setSaveStatus("error");
        } finally {
          setSaveStatus("idle");
        }
      }, 500);
    },
    [snapshot, session?.access_token]
  );

  // ─── Create ───
  const createSnapshot = useCallback(
    async (date: string, copyFromPrevious: boolean) => {
      if (!session?.access_token) return;
      setSaveStatus("saving");
      try {
        const res = await fetch("/api/finance", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ date, copy_from_previous: copyFromPrevious }),
        });

        if (!res.ok) {
          const err = await res.json();
          console.error("[Finance] create error:", err.error);
          return;
        }

        const json = await res.json();
        setSnapshot(json.snapshot);
        setPrevSnapshot(json.prevSnapshot ?? null);
      } catch (e) {
        console.error("[Finance] create error:", e instanceof Error ? e.message : String(e));
      } finally {
        setSaveStatus("idle");
      }
    },
    [session?.access_token]
  );

  // ─── Delete ───
  const deleteSnapshot = useCallback(
    async () => {
      if (!snapshot || !session?.access_token) return;
      setSaveStatus("saving");
      try {
        const res = await fetch(`/api/finance/${snapshot.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) {
          console.error("[Finance] delete error:", await res.text());
          return;
        }
        setSnapshot(null);
        setPrevSnapshot(null);
      } catch (e) {
        console.error("[Finance] delete error:", e instanceof Error ? e.message : String(e));
      } finally {
        setSaveStatus("idle");
      }
    },
    [snapshot, session?.access_token]
  );

  // ─── Trend Data ───
  const fetchTrendData = useCallback(
    async (days: number): Promise<DailySnapshot[]> => {
      if (!session?.access_token) return [];
      const to = getLocalDateStr();
      const from = days > 0 ? addDays(to, -days) : "2020-01-01";
      try {
        const res = await fetch(`/api/finance?from=${from}&to=${to}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) return [];
        const json = await res.json();
        return json.snapshots ?? [];
      } catch {
        return [];
      }
    },
    [session?.access_token]
  );

  // ─── Navigation ───
  const goToPrevDay = useCallback(() => {
    setSelectedDate((d) => addDays(d, -1));
  }, []);

  const goToNextDay = useCallback(() => {
    setSelectedDate((d) => addDays(d, 1));
  }, []);

  const goToToday = useCallback(() => {
    setSelectedDate(getLocalDateStr());
  }, []);

  // ─── Computed ───
  const changes = useMemo(
    () => computeChanges(snapshot, prevSnapshot),
    [snapshot, prevSnapshot]
  );

  const isToday = selectedDate === getLocalDateStr();

  // Cleanup
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return {
    snapshot,
    prevSnapshot,
    loading,
    saving,
    saveStatus,
    selectedDate,
    setSelectedDate,
    fetchSnapshot,
    saveSnapshot,
    createSnapshot,
    deleteSnapshot,
    fetchTrendData,
    goToPrevDay,
    goToNextDay,
    goToToday,
    changes,
    isToday,
  };
}
