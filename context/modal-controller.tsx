"use client";

/**
 * 모달 백그라운드 유지용 제네릭 컨트롤러 팩토리.
 *
 * 모달을 페이지가 아니라 WorkspaceLayout에 마운트해 "항상 살아있게" 만들고,
 * visible(보이기/최소화)만 토글한다. 최소화해도 컴포넌트가 마운트 상태로 남아
 * 진행 중인 작업·진행상황이 유지되며, 페이지를 이동해도(레이아웃은 유지됨) 살아남는다.
 *
 * 작업 로직(SSE 스트림·그룹 루프 등)은 각 모달 내부에 그대로 두고,
 * 이 컨트롤러는 마운트/표시 상태·입력 스냅샷·진행 요약만 관리한다.
 */

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

export interface ModalProgress {
  done: number;
  total: number;
  label: string;
  finished: boolean;
}

export interface ModalController<TInput, THandler = unknown> {
  /** 모달이 열릴 때 페이지가 넘긴 데이터 스냅샷 */
  input: TInput | null;
  /** 작업/모달이 존재 → 레이아웃에서 모달을 렌더 */
  mounted: boolean;
  /** 화면에 보이는지 (false = 최소화, 컴포넌트는 계속 마운트) */
  visible: boolean;
  /** 진행 요약 (배지 표시용) */
  progress: ModalProgress | null;
  /** 작업 완료 시마다 증가 — 페이지가 watch해서 refetch */
  completionTick: number;

  open: (input: TInput) => void;
  minimize: () => void;
  restore: () => void;
  close: () => void;
  setProgress: (p: ModalProgress | null) => void;
  notifyComplete: () => void;

  /** 페이지가 마운트 중일 때 동작 핸들러(예: DB insert)를 등록 (호스트가 호출) */
  registerHandler: (h: THandler | null) => void;
  /** 등록된 핸들러 조회 (없으면 null) */
  getHandler: () => THandler | null;
}

export function createModalController<TInput, THandler = unknown>(name: string) {
  const Ctx = createContext<ModalController<TInput, THandler> | null>(null);

  function Provider({ children }: { children: ReactNode }) {
    const [input, setInput] = useState<TInput | null>(null);
    const [mounted, setMounted] = useState(false);
    const [visible, setVisible] = useState(false);
    const [progress, setProgress] = useState<ModalProgress | null>(null);
    const [completionTick, setCompletionTick] = useState(0);
    const handlerRef = useRef<THandler | null>(null);

    const open = useCallback((i: TInput) => {
      setInput(i);
      setProgress(null);
      setMounted(true);
      setVisible(true);
    }, []);
    const minimize = useCallback(() => setVisible(false), []);
    const restore = useCallback(() => setVisible(true), []);
    const close = useCallback(() => {
      setMounted(false);
      setVisible(false);
      setInput(null);
      setProgress(null);
    }, []);
    const notifyComplete = useCallback(() => setCompletionTick((t) => t + 1), []);
    const registerHandler = useCallback((h: THandler | null) => { handlerRef.current = h; }, []);
    const getHandler = useCallback(() => handlerRef.current, []);

    return (
      <Ctx.Provider
        value={{ input, mounted, visible, progress, completionTick, open, minimize, restore, close, setProgress, notifyComplete, registerHandler, getHandler }}
      >
        {children}
      </Ctx.Provider>
    );
  }
  Provider.displayName = `${name}ControllerProvider`;

  function useController(): ModalController<TInput, THandler> {
    const v = useContext(Ctx);
    if (!v) throw new Error(`use${name} must be used within <${name}ControllerProvider>`);
    return v;
  }

  return { Provider, useController };
}
