"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { X, ShoppingCart, CheckCircle, AlertCircle, Loader2, Eye, EyeOff, AlertTriangle, Square } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import type { Order, PurchaseCredential, PurchasePlatform } from "@/types/database";
import { PLATFORM_LABELS } from "@/types/database";
import type { PurchaseOrderInfo } from "@/lib/scrapers/types";

interface AutoPurchaseModalProps {
  orders: Order[];
  onClose: () => void;
  onComplete: () => void;
}

type Step = "config" | "processing" | "result";

interface OrderStatus {
  orderId: string;
  recipientName: string;
  productName: string;
  status: "pending" | "processing" | "success" | "failed" | "waiting_payment" | "cancelled";
  message?: string;
  purchaseOrderNo?: string;
}

// 발주서의 구매처 -> platform 코드 변환
function detectPlatform(order: Order): PurchasePlatform | null {
  const source = order.purchase_source?.trim();
  if (source === "지마켓") return "gmarket";
  if (source === "옥션") return "auction";
  if (source === "오늘의집") return "ohouse";
  if (source === "쿠팡") return "coupang";
  if (source === "스마트스토어") return "smartstore";
  if (source === "11번가") return "11st";

  // fallback: URL로 판단
  const url = order.purchase_url?.toLowerCase() || "";
  if (url.includes("gmarket")) return "gmarket";
  if (url.includes("auction")) return "auction";
  if (url.includes("ohou.se") || url.includes("ohouse")) return "ohouse";

  return null;
}

// 현재 자동구매 지원 플랫폼
const SUPPORTED_PLATFORMS = new Set<PurchasePlatform>(["gmarket", "ohouse"]);

// 결제 비밀번호가 필요한 플랫폼
const PIN_REQUIRED_PLATFORMS = new Set<PurchasePlatform>(["gmarket", "ohouse"]);

// 구매 계정별 그룹
interface OrderGroup {
  key: string;
  purchaseId: string;
  platform: PurchasePlatform;
  credentialId: string;
  credentialLabel?: string;
  orders: Order[];
}

export default function AutoPurchaseModal({ orders, onClose, onComplete }: AutoPurchaseModalProps) {
  const { session } = useAuth();
  const [step, setStep] = useState<Step>("config");
  const [credentials, setCredentials] = useState<PurchaseCredential[]>([]);
  const [credLoading, setCredLoading] = useState(true);

  // 설정
  const [paymentPin, setPaymentPin] = useState("");
  const [showPin, setShowPin] = useState(false);

  // 진행 상태
  const [orderStatuses, setOrderStatuses] = useState<OrderStatus[]>([]);
  const [currentGroupIndex, setCurrentGroupIndex] = useState(0);
  const [error, setError] = useState("");
  const [isStopping, setIsStopping] = useState(false);
  const [wasCancelled, setWasCancelled] = useState(false);

  // AbortController ref (그룹별 fetch 중단용)
  const abortControllerRef = useRef<AbortController | null>(null);
  const shouldStopRef = useRef(false);

  // 자격증명 조회
  const fetchCredentials = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/credentials", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json() as PurchaseCredential[];
        setCredentials(data);
      }
    } catch {
      // ignore
    } finally {
      setCredLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  // 구매 가능 주문건 필터: purchase_url 있고, purchase_order_no 비어있는 것
  const purchasableOrders = useMemo(() => {
    return orders.filter(
      (o) => o.purchase_url && o.purchase_url.trim() !== "" && (!o.purchase_order_no || o.purchase_order_no.trim() === "")
    );
  }, [orders]);

  // 이미 구매 완료된 주문건
  const alreadyPurchased = useMemo(() => {
    return orders.filter((o) => o.purchase_order_no && o.purchase_order_no.trim() !== "");
  }, [orders]);

  // purchase_url 없는 주문건
  const noUrlOrders = useMemo(() => {
    return orders.filter((o) => !o.purchase_url || o.purchase_url.trim() === "");
  }, [orders]);

  // 계정별 그룹핑 + 자격증명 자동 매칭
  const { matchedGroups, unmatchedOrders, noPurchaseIdOrders, unsupportedPlatformOrders } = useMemo(() => {
    const groups = new Map<string, OrderGroup>();
    const unmatched: Order[] = [];
    const noPurchaseId: Order[] = [];
    const unsupported: Order[] = [];

    for (const order of purchasableOrders) {
      const purchaseId = order.purchase_id?.trim();
      const platform = detectPlatform(order);

      if (!purchaseId) {
        noPurchaseId.push(order);
        continue;
      }

      if (!platform || !SUPPORTED_PLATFORMS.has(platform)) {
        unsupported.push(order);
        continue;
      }

      const key = `${purchaseId}__${platform}`;

      if (!groups.has(key)) {
        const cred = credentials.find((c) => c.login_id === purchaseId && c.platform === platform);
        if (!cred) {
          unmatched.push(order);
          continue;
        }
        groups.set(key, {
          key,
          purchaseId,
          platform,
          credentialId: cred.id,
          credentialLabel: cred.label || undefined,
          orders: [],
        });
      }

      const group = groups.get(key);
      if (group) {
        group.orders.push(order);
      } else {
        unmatched.push(order);
      }
    }

    return {
      matchedGroups: Array.from(groups.values()),
      unmatchedOrders: unmatched,
      noPurchaseIdOrders: noPurchaseId,
      unsupportedPlatformOrders: unsupported,
    };
  }, [purchasableOrders, credentials]);

  const totalMatchedOrders = matchedGroups.reduce((sum, g) => sum + g.orders.length, 0);

  // 결제 비밀번호가 필요한 그룹이 있는지 확인
  const needsPaymentPin = matchedGroups.some(g => PIN_REQUIRED_PLATFORMS.has(g.platform));

  const canStart = useMemo(() => {
    if (totalMatchedOrders === 0) return false;
    if (needsPaymentPin && paymentPin.length !== 6) return false;
    return true;
  }, [totalMatchedOrders, paymentPin, needsPaymentPin]);

  // SSE 스트림을 읽어서 주문 상태를 실시간 업데이트
  async function readSSEStream(
    response: Response,
    groupOrders: Order[],
    signal: AbortSignal
  ): Promise<{ isDone: boolean; isCancelled: boolean }> {
    const reader = response.body?.getReader();
    if (!reader) return { isDone: true, isCancelled: false };

    const decoder = new TextDecoder();
    let buffer = "";
    let isCancelled = false;

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE 이벤트 파싱 (data: {...}\n\n)
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const dataLine = line.trim();
          if (!dataLine.startsWith("data: ")) continue;

          try {
            const event = JSON.parse(dataLine.slice(6));

            if (event.type === "progress" && event.orderId) {
              setOrderStatuses((prev) =>
                prev.map((s) =>
                  s.orderId === event.orderId
                    ? {
                        ...s,
                        status: event.status as OrderStatus["status"],
                        message: event.message || s.message,
                        purchaseOrderNo: event.purchaseOrderNo || s.purchaseOrderNo,
                      }
                    : s
                )
              );
            } else if (event.type === "db_updated" && event.orderId) {
              // DB 업데이트 완료 알림 (UI에서는 이미 progress로 반영됨)
              if (event.status === "error") {
                console.warn(`DB 업데이트 실패: ${event.orderId} - ${event.message}`);
              }
            } else if (event.type === "done" || event.type === "cancelled") {
              isCancelled = event.type === "cancelled";
              // 최종 결과로 상태 확정
              if (event.success) {
                const successMap = new Map(
                  event.success.map((s: { orderId: string; purchaseOrderNo: string }) => [s.orderId, s.purchaseOrderNo])
                );
                setOrderStatuses((prev) =>
                  prev.map((s) => {
                    const pno = successMap.get(s.orderId);
                    if (pno && s.status !== "success") {
                      return { ...s, status: "success" as const, message: `주문번호: ${pno}`, purchaseOrderNo: pno as string };
                    }
                    return s;
                  })
                );
              }
              if (event.failed) {
                const failMap = new Map(
                  event.failed.map((f: { orderId: string; reason: string }) => [f.orderId, f.reason])
                );
                setOrderStatuses((prev) =>
                  prev.map((s) => {
                    const reason = failMap.get(s.orderId);
                    if (reason && s.status !== "success" && s.status !== "failed") {
                      return { ...s, status: "failed" as const, message: reason as string };
                    }
                    return s;
                  })
                );
              }
            } else if (event.type === "error") {
              setOrderStatuses((prev) =>
                prev.map((s) =>
                  groupOrders.some((o) => o.id === s.orderId) && s.status !== "success"
                    ? { ...s, status: "failed" as const, message: event.message || "서버 오류" }
                    : s
                )
              );
            }
          } catch {
            // JSON 파싱 실패 무시
          }
        }
      }
    } catch (err) {
      // AbortError는 정상 중단
      if (err instanceof DOMException && err.name === "AbortError") {
        isCancelled = true;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setOrderStatuses((prev) =>
          prev.map((s) =>
            groupOrders.some((o) => o.id === s.orderId) && s.status !== "success"
              ? { ...s, status: "failed" as const, message: msg }
              : s
          )
        );
      }
    } finally {
      reader.releaseLock();
    }

    return { isDone: true, isCancelled };
  }

  const handleStart = async () => {
    if (!session?.access_token || !canStart) return;

    setStep("processing");
    setError("");
    setIsStopping(false);
    setWasCancelled(false);
    shouldStopRef.current = false;

    const batchId = crypto.randomUUID();

    // 전체 주문건 초기 상태 (그룹 순서대로)
    const allOrders = matchedGroups.flatMap((g) => g.orders);
    const initialStatuses: OrderStatus[] = allOrders.map((o) => ({
      orderId: o.id,
      recipientName: o.recipient_name || "-",
      productName: o.product_name || "-",
      status: "pending",
    }));
    setOrderStatuses(initialStatuses);

    let cancelled = false;

    // 그룹별 순차 처리
    for (let gi = 0; gi < matchedGroups.length; gi++) {
      // 다음 그룹 시작 전 중단 확인
      if (shouldStopRef.current) {
        cancelled = true;
        // 남은 그룹의 주문들을 cancelled 처리
        for (let rgi = gi; rgi < matchedGroups.length; rgi++) {
          setOrderStatuses((prev) =>
            prev.map((s) =>
              matchedGroups[rgi].orders.some((o) => o.id === s.orderId) && s.status === "pending"
                ? { ...s, status: "cancelled" as const, message: "사용자가 작업을 중단했습니다." }
                : s
            )
          );
        }
        break;
      }

      const group = matchedGroups[gi];
      setCurrentGroupIndex(gi);

      const purchaseOrders: PurchaseOrderInfo[] = group.orders.map((o) => ({
        orderId: o.id,
        productUrl: o.purchase_url!,
        recipientName: o.recipient_name || "",
        postalCode: o.postal_code || "",
        address: o.address || "",
        addressDetail: o.address_detail || "",
        recipientPhone: o.recipient_phone || "",
        deliveryMemo: o.delivery_memo || "",
        quantity: o.quantity || 1,
        productName: o.product_name || "",
      }));

      // AbortController 생성
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const res = await fetch("/api/orders/auto-purchase", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            credentialId: group.credentialId,
            batchId,
            ...(PIN_REQUIRED_PLATFORMS.has(group.platform) && { paymentPin }),
            orders: purchaseOrders,
          }),
          signal: controller.signal,
        });

        // SSE 스트림이 아닌 경우 (에러 응답)
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await res.json();
          setOrderStatuses((prev) =>
            prev.map((s) =>
              group.orders.some((o) => o.id === s.orderId)
                ? { ...s, status: "failed" as const, message: data.error || "구매 실패" }
                : s
            )
          );
          continue;
        }

        // SSE 스트림 읽기
        const { isCancelled } = await readSSEStream(res, group.orders, controller.signal);
        if (isCancelled) {
          cancelled = true;
          break;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          cancelled = true;
          // 중단된 그룹의 남은 주문을 cancelled 처리
          setOrderStatuses((prev) =>
            prev.map((s) =>
              group.orders.some((o) => o.id === s.orderId) && s.status !== "success" && s.status !== "failed"
                ? { ...s, status: "cancelled" as const, message: "사용자가 작업을 중단했습니다." }
                : s
            )
          );
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setOrderStatuses((prev) =>
          prev.map((s) =>
            group.orders.some((o) => o.id === s.orderId) && s.status !== "success"
              ? { ...s, status: "failed" as const, message: msg }
              : s
          )
        );
      } finally {
        abortControllerRef.current = null;
      }
    }

    setWasCancelled(cancelled);
    setIsStopping(false);
    setStep("result");
  };

  const handleStop = () => {
    setIsStopping(true);
    shouldStopRef.current = true;
    // 현재 진행 중인 fetch 중단
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const successCount = orderStatuses.filter((s) => s.status === "success").length;
  const failCount = orderStatuses.filter((s) => s.status === "failed").length;
  const cancelledCount = orderStatuses.filter((s) => s.status === "cancelled").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-overlay)] backdrop-blur-sm">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-orange-400" />
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">구매 자동화</h2>
            <span className="text-xs text-[var(--text-muted)] ml-1">
              {step === "config" && "설정"}
              {step === "processing" && `진행 중... (${currentGroupIndex + 1}/${matchedGroups.length} 그룹)`}
              {step === "result" && "결과"}
            </span>
          </div>
          <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {step === "config" && (
            <>
              {/* 계정별 자동 분류 */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-[var(--text-secondary)]">대상 주문 (계정별 자동 분류)</h3>

                {credLoading ? (
                  <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] py-4">
                    <Loader2 className="w-3 h-3 animate-spin" /> 계정 매칭 중...
                  </div>
                ) : matchedGroups.length > 0 ? (
                  <div className="space-y-3">
                    {matchedGroups.map((group) => (
                      <div key={group.key} className="bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-hover)]">
                          <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
                          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-active)] text-[var(--text-tertiary)]">
                            {PLATFORM_LABELS[group.platform] || group.platform}
                          </span>
                          <span className="text-sm text-[var(--text-secondary)] font-medium">{group.purchaseId}</span>
                          {group.credentialLabel && (
                            <span className="text-xs text-[var(--text-muted)]">({group.credentialLabel})</span>
                          )}
                          <span className="ml-auto text-xs text-[var(--text-muted)]">{group.orders.length}건</span>
                        </div>
                        <div className="px-3 py-2 space-y-1 max-h-32 overflow-y-auto">
                          {group.orders.map((o) => (
                            <div key={o.id} className="flex items-center gap-3 text-xs">
                              <span className="text-[var(--text-tertiary)] w-16 shrink-0">{o.recipient_name || "-"}</span>
                              <span className="text-[var(--text-secondary)] truncate flex-1" title={o.product_name || ""}>{o.product_name || "-"}</span>
                              <span className="text-[var(--text-muted)] text-[10px] shrink-0">{o.quantity}개</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-xs text-yellow-400">
                    구매 가능한 주문이 없습니다. (최저가링크, 구매아이디, 구매처가 입력되고 주문번호가 비어있는 주문건만 대상)
                  </div>
                )}

                {/* 제외 안내 */}
                {unmatchedOrders.length > 0 && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-xs text-yellow-400 flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">{unmatchedOrders.length}건 — 등록된 계정 없음 (제외)</p>
                      <p className="text-yellow-400/60 mt-0.5">
                        구매아이디에 해당하는 계정이{" "}
                        <Link href="/workspace/credentials" className="underline hover:text-yellow-400">계정 관리</Link>에
                        등록되어 있지 않습니다.
                      </p>
                      <div className="mt-1 space-y-0.5">
                        {unmatchedOrders.slice(0, 3).map((o) => (
                          <p key={o.id} className="text-yellow-400/50">
                            · {o.recipient_name} — 구매아이디: {o.purchase_id || "미입력"}
                          </p>
                        ))}
                        {unmatchedOrders.length > 3 && (
                          <p className="text-yellow-400/40">외 {unmatchedOrders.length - 3}건</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {noPurchaseIdOrders.length > 0 && (
                  <p className="text-xs text-[var(--text-muted)]">
                    {noPurchaseIdOrders.length}건은 구매아이디가 비어있어 제외됩니다.
                  </p>
                )}
                {unsupportedPlatformOrders.length > 0 && (
                  <p className="text-xs text-[var(--text-muted)]">
                    {unsupportedPlatformOrders.length}건은 미지원 플랫폼이라 제외됩니다. (현재 지마켓/오늘의집 지원)
                  </p>
                )}
                {alreadyPurchased.length > 0 && (
                  <p className="text-xs text-[var(--text-muted)]">
                    {alreadyPurchased.length}건은 이미 주문번호가 입력되어 제외됩니다.
                  </p>
                )}
                {noUrlOrders.length > 0 && (
                  <p className="text-xs text-[var(--text-muted)]">
                    {noUrlOrders.length}건은 최저가링크가 없어 제외됩니다.
                  </p>
                )}
              </div>

              {/* 결제 비밀번호 (지마켓 등 PIN 필요 플랫폼만) */}
              {totalMatchedOrders > 0 && needsPaymentPin && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-[var(--text-secondary)]">결제 비밀번호 (6자리)</h3>
                  <div className="relative max-w-48">
                    <input
                      type={showPin ? "text" : "password"}
                      value={paymentPin}
                      onChange={(e) => setPaymentPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="000000"
                      maxLength={6}
                      className="w-full px-3 py-2 pr-10 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50 tracking-widest"
                    />
                    <button onClick={() => setShowPin(!showPin)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                      {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">
                    {matchedGroups.some(g => g.platform === "gmarket") && "스마일페이"}
                    {matchedGroups.some(g => g.platform === "gmarket") && matchedGroups.some(g => g.platform === "ohouse") && " / "}
                    {matchedGroups.some(g => g.platform === "ohouse") && "네이버페이"}
                    {" "}결제 비밀번호를 입력하세요.
                  </p>
                </div>
              )}

              {/* 오늘의집 안내 */}
              {totalMatchedOrders > 0 && matchedGroups.some(g => g.platform === "ohouse") && (
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-400">
                  <p className="font-medium">오늘의집 주문 안내</p>
                  <p className="mt-1 text-blue-400/70">
                    간편결제 중 할인이 있으면 최대 할인 수단을, 없으면 네이버페이로 결제합니다.
                    네이버페이 결제 시 스마트스토어 계정으로 자동 로그인됩니다.
                  </p>
                </div>
              )}
            </>
          )}

          {step === "processing" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-sm text-[var(--text-secondary)]">
                <Loader2 className="w-5 h-5 animate-spin text-orange-400" />
                {isStopping
                  ? "현재 주문 완료 후 중단합니다..."
                  : "구매 자동화 진행 중... (브라우저를 닫지 마세요)"}
              </div>
              {matchedGroups[currentGroupIndex] && (
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] bg-[var(--bg-hover)] rounded-lg px-3 py-2">
                  <span className="px-1.5 py-0.5 rounded bg-[var(--bg-active)] text-[var(--text-tertiary)]">
                    {PLATFORM_LABELS[matchedGroups[currentGroupIndex].platform]}
                  </span>
                  <span>{matchedGroups[currentGroupIndex].purchaseId}</span>
                  <span className="ml-auto">{currentGroupIndex + 1}/{matchedGroups.length} 그룹</span>
                </div>
              )}
              <div className="space-y-2">
                {orderStatuses.map((s) => (
                  <div key={s.orderId} className="flex items-center gap-3 px-3 py-2 bg-[var(--bg-hover)] rounded-lg text-xs">
                    {s.status === "pending" && <div className="w-4 h-4 rounded-full border border-[var(--border-strong)]" />}
                    {s.status === "processing" && <Loader2 className="w-4 h-4 animate-spin text-orange-400" />}
                    {s.status === "waiting_payment" && <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />}
                    {s.status === "success" && <CheckCircle className="w-4 h-4 text-green-400" />}
                    {s.status === "failed" && <AlertCircle className="w-4 h-4 text-red-400" />}
                    {s.status === "cancelled" && <Square className="w-4 h-4 text-[var(--text-muted)]" />}
                    <span className="text-[var(--text-tertiary)] w-16 shrink-0">{s.recipientName}</span>
                    <span className="text-[var(--text-secondary)] truncate flex-1">{s.productName}</span>
                    {s.message && <span className="text-[var(--text-muted)] text-[10px] shrink-0">{s.message}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === "result" && (
            <div className="space-y-4">
              {wasCancelled && (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-xs text-yellow-400">
                  작업이 중단되었습니다. 이미 완료된 주문은 DB에 반영되었습니다.
                </div>
              )}
              <div className={`grid gap-3 ${cancelledCount > 0 ? "grid-cols-3" : "grid-cols-2"}`}>
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-green-400">{successCount}</p>
                  <p className="text-xs text-green-400/70">성공</p>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-red-400">{failCount}</p>
                  <p className="text-xs text-red-400/70">실패</p>
                </div>
                {cancelledCount > 0 && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-yellow-400">{cancelledCount}</p>
                    <p className="text-xs text-yellow-400/70">중단</p>
                  </div>
                )}
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                {orderStatuses.map((s) => (
                  <div key={s.orderId} className="flex items-center gap-3 px-3 py-2 bg-[var(--bg-hover)] rounded-lg text-xs">
                    {s.status === "success" ? (
                      <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                    ) : s.status === "cancelled" ? (
                      <Square className="w-4 h-4 text-yellow-400 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                    )}
                    <span className="text-[var(--text-tertiary)] w-16 shrink-0">{s.recipientName}</span>
                    <span className="text-[var(--text-secondary)] truncate flex-1">{s.productName}</span>
                    <span className={`text-[10px] shrink-0 ${
                      s.status === "success" ? "text-green-400" : s.status === "cancelled" ? "text-yellow-400" : "text-red-400"
                    }`}>
                      {s.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--border)]">
          {step === "config" && (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors">
                취소
              </button>
              <button
                onClick={handleStart}
                disabled={!canStart}
                className="flex items-center gap-1.5 px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-orange-600/30 disabled:cursor-not-allowed text-[var(--text-primary)] text-sm font-medium rounded-lg transition-colors"
              >
                <ShoppingCart className="w-4 h-4" />
                {totalMatchedOrders}건 구매 시작
                {matchedGroups.length > 1 && ` (${matchedGroups.length}계정)`}
              </button>
            </>
          )}
          {step === "processing" && (
            <div className="flex items-center gap-3 w-full">
              <p className="text-xs text-[var(--text-muted)] flex-1">
                {isStopping ? "중단 중..." : "진행 중에는 브라우저를 닫지 마세요."}
              </p>
              <button
                onClick={handleStop}
                disabled={isStopping}
                className="flex items-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-600/50 disabled:cursor-not-allowed text-[var(--text-primary)] text-sm font-medium rounded-lg transition-colors"
              >
                <Square className="w-3.5 h-3.5" />
                {isStopping ? "중단 중..." : "작업 중단"}
              </button>
            </div>
          )}
          {step === "result" && (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors">
                닫기
              </button>
              {successCount > 0 && (
                <button
                  onClick={onComplete}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-[var(--text-primary)] text-sm font-medium rounded-lg transition-colors"
                >
                  발주서에 적용
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
