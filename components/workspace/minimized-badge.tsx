"use client";

import type { ModalController } from "@/context/modal-controller";

// 배지는 표시 관련 필드만 사용 — 제네릭(TInput/THandler) 변성 문제를 피하려 Pick으로 좁힌다.
type BadgeController = Pick<ModalController<unknown, unknown>, "mounted" | "visible" | "progress" | "restore">;

/**
 * 최소화된 백그라운드 작업을 우하단에 표시하는 배지.
 * mounted && !visible(최소화) 일 때만 보이며, 클릭하면 모달을 다시 연다.
 * 레이아웃의 flex 컨테이너 안에서 여러 개가 세로로 쌓인다.
 */
export function MinimizedBadge({
  controller,
  label,
}: {
  controller: BadgeController;
  label: string;
}) {
  if (!controller.mounted || controller.visible) return null;

  const p = controller.progress;
  const allDone = p?.finished ?? false;
  const counter = p && p.total > 0 ? ` ${p.done}/${p.total}` : "";

  return (
    <button
      onClick={controller.restore}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium transition-all ${
        allDone ? "bg-emerald-600 text-white" : "bg-amber-500 text-white animate-pulse"
      }`}
    >
      {!allDone && (
        <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
      )}
      {allDone ? `✓ ${label} 완료${counter}` : `${label}${counter ? ` 진행 중${counter}` : " 진행 중"}`}
    </button>
  );
}
