"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import type { ProductUpdate } from "@/types/database";

export type AiStatus = "idle" | "loading" | "done" | "error";

export interface TaskEntry {
  thumbStatus: AiStatus;
  detailStatus: AiStatus;
  thumbSummary: string;
}

export interface BatchItem {
  productId: string;
  productName: string;
  purchaseUrl: string | null;
  thumbnailUrl: string | null;
  status: "pending" | "running" | "done" | "error";
  errorMsg?: string;
}

interface AiTaskContextValue {
  // ── 개별 작업 상태 ──────────────────────────────────────────────────────
  tasks: Record<string, TaskEntry>;
  setThumbStatus: (id: string, status: AiStatus) => void;
  setDetailStatus: (id: string, status: AiStatus) => void;
  setThumbSummary: (id: string, summary: string) => void;

  // ── 일괄 상세페이지 생성 ────────────────────────────────────────────────
  batchItems: BatchItem[];
  batchActive: boolean;   // 진행 중 여부
  batchVisible: boolean;  // 모달 표시 여부
  startBatch: (
    items: Omit<BatchItem, "status">[],
    accessToken: string
  ) => void;
  dismissBatch: () => void; // 모달 숨기기 (처리는 계속)
  showBatch: () => void;
  clearBatch: () => void;   // 완전히 초기화

  // ── 로컬 캐시 업데이트 콜백 등록 (ImageTab이 마운트 중일 때) ────────────
  registerOnUpdate: (fn: (id: string, updates: ProductUpdate, skipUndo?: boolean) => void) => void;
  unregisterOnUpdate: () => void;
}

const AiTaskContext = createContext<AiTaskContextValue | null>(null);

const DEFAULT_ENTRY: TaskEntry = {
  thumbStatus: "idle",
  detailStatus: "idle",
  thumbSummary: "",
};

export function AiTaskProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<Record<string, TaskEntry>>({});
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchVisible, setBatchVisible] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const onUpdateRef = useRef<
    ((id: string, updates: ProductUpdate, skipUndo?: boolean) => void) | null
  >(null);

  // ── 개별 상태 setter ────────────────────────────────────────────────────
  const setThumbStatus = useCallback((id: string, status: AiStatus) => {
    setTasks((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? DEFAULT_ENTRY), thumbStatus: status },
    }));
  }, []);

  const setDetailStatus = useCallback((id: string, status: AiStatus) => {
    setTasks((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? DEFAULT_ENTRY), detailStatus: status },
    }));
  }, []);

  const setThumbSummary = useCallback((id: string, summary: string) => {
    setTasks((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? DEFAULT_ENTRY), thumbSummary: summary },
    }));
  }, []);

  // ── 일괄 처리 시작 ──────────────────────────────────────────────────────
  const startBatch = useCallback(
    (items: Omit<BatchItem, "status">[], token: string) => {
      setBatchItems(
        items.map((item) => ({ ...item, status: "pending" as const }))
      );
      setAccessToken(token);
      setBatchVisible(true);
      // 개별 상태 초기화
      setTasks((prev) => {
        const next = { ...prev };
        for (const item of items) {
          next[item.productId] = {
            ...(prev[item.productId] ?? DEFAULT_ENTRY),
            detailStatus: "idle",
          };
        }
        return next;
      });
    },
    []
  );

  const dismissBatch = useCallback(() => setBatchVisible(false), []);
  const showBatch = useCallback(() => setBatchVisible(true), []);
  const clearBatch = useCallback(() => {
    setBatchItems([]);
    setBatchVisible(false);
    setAccessToken(null);
  }, []);

  const registerOnUpdate = useCallback(
    (fn: (id: string, updates: ProductUpdate, skipUndo?: boolean) => void) => {
      onUpdateRef.current = fn;
    },
    []
  );
  const unregisterOnUpdate = useCallback(() => {
    onUpdateRef.current = null;
  }, []);

  // ── 일괄 처리 루프 (컨텍스트 내부에서 실행 → 네비게이션 무관) ───────────
  const batchActive =
    batchItems.some((i) => i.status === "pending" || i.status === "running");

  useEffect(() => {
    if (!accessToken) return;

    const pendingIdx = batchItems.findIndex((i) => i.status === "pending");
    const runningCount = batchItems.filter((i) => i.status === "running").length;

    if (pendingIdx === -1 || runningCount > 0) return;

    const item = batchItems[pendingIdx];

    // running 으로 변경
    setBatchItems((prev) =>
      prev.map((i, idx) =>
        idx === pendingIdx ? { ...i, status: "running" as const } : i
      )
    );
    setDetailStatus(item.productId, "loading");

    // API 호출
    fetch("/api/ai/detail", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        productId: item.productId,
        productName: item.productName,
        purchaseUrl: item.purchaseUrl,
        thumbnailUrl: item.thumbnailUrl,
      }),
    })
      .then((res) => res.json())
      .then(
        (data: {
          detailHtml?: string;
          detailImageUrl?: string;
          error?: string;
        }) => {
          if (data.error) throw new Error(data.error);

          setBatchItems((prev) =>
            prev.map((i) =>
              i.productId === item.productId
                ? { ...i, status: "done" as const }
                : i
            )
          );
          setDetailStatus(item.productId, "done");

          // 로컬 캐시 업데이트 (ImageTab이 마운트 중일 때만)
          if (onUpdateRef.current) {
            onUpdateRef.current(
              item.productId,
              {
                detail_html: data.detailHtml ?? null,
                detail_image_url: data.detailImageUrl ?? null,
              },
              true
            );
          }
        }
      )
      .catch((err: Error) => {
        setBatchItems((prev) =>
          prev.map((i) =>
            i.productId === item.productId
              ? { ...i, status: "error" as const, errorMsg: err.message }
              : i
          )
        );
        setDetailStatus(item.productId, "error");
      });
  }, [batchItems, accessToken, setDetailStatus]);

  return (
    <AiTaskContext.Provider
      value={{
        tasks,
        setThumbStatus,
        setDetailStatus,
        setThumbSummary,
        batchItems,
        batchActive,
        batchVisible,
        startBatch,
        dismissBatch,
        showBatch,
        clearBatch,
        registerOnUpdate,
        unregisterOnUpdate,
      }}
    >
      {children}
    </AiTaskContext.Provider>
  );
}

export function useAiTask() {
  const ctx = useContext(AiTaskContext);
  if (!ctx) throw new Error("useAiTask must be used within AiTaskProvider");
  return ctx;
}
