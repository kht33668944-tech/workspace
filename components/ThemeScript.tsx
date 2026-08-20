"use client";

import { useRef } from "react";
import { useServerInsertedHTML } from "next/navigation";

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"){document.documentElement.classList.add("light")}else{document.documentElement.classList.add("dark")}}catch(e){document.documentElement.classList.add("dark")}})()`;

/**
 * 테마 초기화 스크립트를 SSR 스트림에 직접 주입한다.
 * React 19부터 컴포넌트 트리 안의 <script>는 개발 모드 경고를 유발하므로,
 * useServerInsertedHTML로 트리 밖에서 주입해 경고 없이 FOUC를 방지한다.
 */
export function ThemeScript() {
  const inserted = useRef(false);
  useServerInsertedHTML(() => {
    if (inserted.current) return;
    inserted.current = true;
    return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />;
  });
  return null;
}
