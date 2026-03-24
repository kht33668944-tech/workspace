"use client";

import { useEffect } from "react";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[workspace error]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
        오류가 발생했습니다
      </h2>
      <p className="text-sm text-[var(--text-secondary)]">
        {error.message || "알 수 없는 오류"}
      </p>
      <button
        onClick={reset}
        className="px-4 py-2 text-sm rounded-lg bg-[var(--bg-accent)] text-white hover:opacity-90 transition-opacity"
      >
        다시 시도
      </button>
    </div>
  );
}
