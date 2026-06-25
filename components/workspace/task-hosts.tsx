"use client";

import dynamic from "next/dynamic";
import { useAiTask } from "@/context/AiTaskContext";
import { supabase } from "@/lib/supabase";
import {
  useAutoPurchaseController,
  useTrackingCollectController,
  useGmarketImportController,
} from "@/context/modal-controllers";
import { MinimizedBadge } from "./minimized-badge";

const AutoPurchaseModal = dynamic(() => import("./orders/auto-purchase-modal"), { ssr: false });
const TrackingCollectModal = dynamic(() => import("./orders/tracking-collect-modal"), { ssr: false });
const GmarketImportModal = dynamic(() => import("./products/gmarket-import-modal"), { ssr: false });

/** 자동구매 모달 호스트 — 레이아웃에 마운트되어 페이지 이동에도 유지 */
export function AutoPurchaseHost() {
  const c = useAutoPurchaseController();
  if (!c.mounted || !c.input) return null;
  return (
    <div className={c.visible ? "" : "hidden"}>
      <AutoPurchaseModal
        orders={c.input.orders}
        onClose={c.close}
        onMinimize={c.minimize}
        onComplete={() => {
          c.notifyComplete();
          c.close();
        }}
        onProgress={c.setProgress}
      />
    </div>
  );
}

/** 운송장 수집 모달 호스트 */
export function TrackingCollectHost() {
  const c = useTrackingCollectController();
  if (!c.mounted || !c.input) return null;
  return (
    <div className={c.visible ? "" : "hidden"}>
      <TrackingCollectModal
        orders={c.input.orders}
        courierCodeMap={c.input.courierCodeMap}
        onClose={c.close}
        onMinimize={c.minimize}
        onProgress={c.setProgress}
        onApply={async (updates) => {
          // 서버에서 이미 발주서 반영 완료 — 레거시 호환: updates가 넘어오면 일괄 업데이트
          if (updates.length > 0) {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch("/api/orders/bulk-update-tracking", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
              },
              body: JSON.stringify({ updates }),
            });
            const data = await res.json();
            if (!res.ok) {
              alert(`업데이트 실패: ${data.error}`);
            } else if (data.failCount > 0) {
              alert(`업데이트: 성공 ${data.successCount}건, 실패 ${data.failCount}건\n${data.errors?.slice(0, 5).join("\n")}`);
            }
          }
          c.notifyComplete(); // 발주서 페이지가 watch해서 refetch
        }}
      />
    </div>
  );
}

/** 지마켓 가져오기 모달 호스트 (데스크톱/모바일 공통 중앙 모달) */
export function GmarketImportHost() {
  const c = useGmarketImportController();
  if (!c.mounted || !c.input) return null;
  return (
    <div className={c.visible ? "" : "hidden"}>
      <GmarketImportModal
        categories={c.input.categories}
        existingUrls={c.input.existingUrls}
        onClose={c.close}
        onMinimize={c.minimize}
        onProgress={c.setProgress}
        onImport={async (rows) => {
          // products 페이지가 마운트 중이면 등록된 핸들러(중복필터·로컬캐시) 사용
          const handler = c.getHandler();
          if (!handler) {
            return { error: "상품 관리 페이지를 연 상태에서 '전체 등록'을 눌러주세요." };
          }
          const res = await handler(rows);
          if (!res.error) c.notifyComplete();
          return res;
        }}
      />
    </div>
  );
}

/** AI 상세 일괄생성 배지 (기존 BatchProgressBadge 로직) */
function AiBatchBadge() {
  const { batchItems, batchActive, batchVisible, showBatch } = useAiTask();
  if (!batchActive && !batchItems.length) return null;
  if (batchVisible && batchActive) return null;

  const done = batchItems.filter((i) => i.status === "done" || i.status === "error").length;
  const total = batchItems.length;
  const allDone = done === total && total > 0;

  return (
    <button
      onClick={showBatch}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium transition-all ${
        allDone ? "bg-emerald-600 text-white" : "bg-amber-500 text-white animate-pulse"
      }`}
    >
      {!allDone && (
        <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
      )}
      {allDone ? `✓ 상세페이지 ${total}건 완료` : `상세페이지 생성 중 ${done}/${total}`}
    </button>
  );
}

/** 우하단 플로팅 배지 모음 — 최소화된 백그라운드 작업들을 세로로 쌓아 표시 */
export function TaskBadges() {
  const ap = useAutoPurchaseController();
  const tc = useTrackingCollectController();
  const gi = useGmarketImportController();
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col-reverse gap-2 items-end">
      <AiBatchBadge />
      <MinimizedBadge controller={ap} label="자동구매" />
      <MinimizedBadge controller={tc} label="운송장 수집" />
      <MinimizedBadge controller={gi} label="지마켓 가져오기" />
    </div>
  );
}
