"use client";

import { useEffect } from "react";

/** Ctrl+S 브라우저 기본 동작(다른 이름으로 저장) 방지 */
export function usePreventBrowserSave() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") e.preventDefault();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
