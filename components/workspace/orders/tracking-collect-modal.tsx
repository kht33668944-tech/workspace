"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { X, Truck, CheckCircle, AlertCircle, Loader2, Eye, EyeOff, KeyRound, Settings, Download, FileSpreadsheet } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import type { Order, PurchaseCredential } from "@/types/database";
import { PLATFORM_LABELS } from "@/types/database";
import type { ScrapeResult, TrackingInfo } from "@/lib/scrapers/types";
import { generateOrderExcel, generatePlayAutoTrackingExcel, arrayBufferToBase64, downloadExcel } from "@/lib/excel-export";

interface TrackingCollectModalProps {
  orders: Order[];
  courierCodeMap?: Record<string, number>;
  onClose: () => void;
  onApply: (updates: { purchase_order_no: string; courier: string; tracking_no: string }[]) => Promise<void>;
}

type Step = "config" | "collecting" | "result";
type Platform = "gmarket" | "auction" | "ohouse";

const SUPPORTED_PLATFORMS: Platform[] = ["gmarket", "auction", "ohouse"];

const PLATFORM_NAME_MAP: Record<string, Platform> = {
  "지마켓": "gmarket",
  "옥션": "auction",
  "오늘의집": "ohouse",
};

export default function TrackingCollectModal({ orders, courierCodeMap = {}, onClose, onApply }: TrackingCollectModalProps) {
  const { session } = useAuth();
  const [step, setStep] = useState<Step>("config");
  const [credentials, setCredentials] = useState<PurchaseCredential[]>([]);
  const [credLoading, setCredLoading] = useState(true);

  // 수동 입력 모드용
  const [manualMode, setManualMode] = useState(false);
  const [platform, setPlatform] = useState<Platform>("gmarket");
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [showPw, setShowPw] = useState(false);

  const [progress, setProgress] = useState("");
  const [progressDetail, setProgressDetail] = useState("");
  const [results, setResults] = useState<ScrapeResult[]>([]);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null); // "order" | "playauto" | null

  // 등록된 자격증명 조회
  const fetchCredentials = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/credentials", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json() as PurchaseCredential[];
        setCredentials(data.filter((c) => SUPPORTED_PLATFORMS.includes(c.platform as Platform)));
      }
    } catch {
      // 무시 - 수동 모드로 fallback
    } finally {
      setCredLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  // 운송장 미수집 주문 (플랫폼 무관)
  const pendingOrders = useMemo(() => {
    return orders.filter(
      (o) => o.purchase_order_no && (!o.tracking_no || o.tracking_no.trim() === "")
    );
  }, [orders]);

  // 계정별 수집 대상: purchase_id와 credential.login_id를 매칭
  const autoCollectGroups = useMemo(() => {
    return credentials
      .map((cred) => {
        const p = cred.platform as Platform;
        if (!SUPPORTED_PLATFORMS.includes(p)) return null;

        const platformName = p === "gmarket" ? "지마켓" : p === "auction" ? "옥션" : "오늘의집";
        // 해당 플랫폼 주문 중, purchase_id가 이 계정의 login_id를 포함하는 것만
        const targets = pendingOrders.filter(
          (o) =>
            o.purchase_source === platformName &&
            o.purchase_id &&
            o.purchase_id.includes(cred.login_id)
        );

        if (targets.length === 0) return null;
        return { credential: cred, platform: p, targets };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);
  }, [credentials, pendingOrders]);

  // 어느 계정에도 매칭되지 않은 미수집 주문
  const unmatchedOrders = useMemo(() => {
    const matchedIds = new Set(autoCollectGroups.flatMap((g) => g.targets.map((o) => o.id)));
    return pendingOrders.filter(
      (o) => !matchedIds.has(o.id) && PLATFORM_NAME_MAP[o.purchase_source || ""]
    );
  }, [autoCollectGroups, pendingOrders]);

  const totalAutoTargets = autoCollectGroups.reduce((sum, g) => sum + g.targets.length, 0);

  // 수동 모드: 선택된 플랫폼의 전체 타겟
  const manualTargets = useMemo(() => {
    const platformName = platform === "gmarket" ? "지마켓" : platform === "auction" ? "옥션" : "오늘의집";
    return pendingOrders.filter((o) => o.purchase_source === platformName);
  }, [pendingOrders, platform]);

  // 전체 결과 합산
  const mergedResult: ScrapeResult | null = results.length > 0
    ? {
        success: results.flatMap((r) => r.success),
        failed: results.flatMap((r) => r.failed),
        notFound: results.flatMap((r) => r.notFound),
      }
    : null;

  // 자동 수집 시작
  const handleAutoCollect = async () => {
    if (autoCollectGroups.length === 0) return;

    setError("");
    setStep("collecting");
    setResults([]);

    const allResults: ScrapeResult[] = [];

    for (let i = 0; i < autoCollectGroups.length; i++) {
      const { credential, platform: p, targets } = autoCollectGroups[i];
      const label = credential.label || PLATFORM_LABELS[p];
      setProgress(`[${i + 1}/${autoCollectGroups.length}] ${label} 수집 중...`);
      setProgressDetail(`${targets.length}건 처리 중`);

      try {
        const orderNos = targets.map((o) => o.purchase_order_no!);
        const res = await fetch("/api/orders/collect-tracking", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ credentialId: credential.id, orderNos }),
        });

        const data = await res.json();
        if (res.ok) {
          allResults.push(data as ScrapeResult);
        } else {
          allResults.push({
            success: [],
            failed: orderNos.map((no) => ({ orderNo: no, reason: data.error || "수집 실패" })),
            notFound: [],
          });
        }
      } catch (err) {
        const orderNos = targets.map((o) => o.purchase_order_no!);
        allResults.push({
          success: [],
          failed: orderNos.map((no) => ({ orderNo: no, reason: `오류: ${err instanceof Error ? err.message : String(err)}` })),
          notFound: [],
        });
      }
    }

    setResults(allResults);
    setStep("result");
  };

  // 수동 수집 시작
  const handleManualCollect = async () => {
    if (!loginId || !loginPw) {
      setError("아이디와 비밀번호를 입력해주세요.");
      return;
    }
    if (manualTargets.length === 0) {
      setError("수집할 대상이 없습니다.");
      return;
    }

    setError("");
    setStep("collecting");
    setProgress(`${PLATFORM_LABELS[platform]} 수집 중...`);
    setProgressDetail(`${manualTargets.length}건 처리 중`);

    try {
      const orderNos = manualTargets.map((o) => o.purchase_order_no!);
      const res = await fetch("/api/orders/collect-tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, loginId, loginPw, orderNos }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "수집 실패");
        setStep("config");
        return;
      }

      setResults([data as ScrapeResult]);
      setStep("result");
    } catch (err) {
      setError(`오류: ${err instanceof Error ? err.message : String(err)}`);
      setStep("config");
    }
  };

  // 수집 성공한 주문 목록 (원본 Order 객체에 수집된 운송장 반영)
  const collectedOrders = useMemo(() => {
    if (!mergedResult?.success.length) return [];
    return mergedResult.success
      .map((t: TrackingInfo) => {
        const order = orders.find((o) => o.purchase_order_no === t.orderNo);
        if (!order) return null;
        return { ...order, courier: t.courier, tracking_no: t.trackingNo, delivery_status: "배송완료" };
      })
      .filter((o) => o !== null) as Order[];
  }, [mergedResult, orders]);

  // 엑셀 내보내기 + 보관함 자동 저장 (단일 양식)
  const handleExport = async (type: "order" | "playauto") => {
    if (collectedOrders.length === 0) return;
    setExporting(type);

    try {
      const { buffer, filename } = type === "order"
        ? generateOrderExcel(collectedOrders)
        : generatePlayAutoTrackingExcel(collectedOrders, courierCodeMap);

      downloadExcel(buffer, filename);

      if (session?.access_token) {
        const base64 = arrayBufferToBase64(buffer);
        await fetch("/api/archives", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            file_name: filename,
            file_type: type === "order" ? "order_export" : "playauto_tracking",
            file_data: base64,
            order_count: collectedOrders.length,
          }),
        });
      }
    } catch (err) {
      console.error("엑셀 내보내기 실패:", err);
    } finally {
      setExporting(null);
    }
  };

  // 양쪽 양식 모두 자동 다운로드 + 보관함 저장
  const autoExportAll = async (targetOrders: Order[]) => {
    if (targetOrders.length === 0) return;
    try {
      // 1) 발주서 양식
      const orderResult = generateOrderExcel(targetOrders);
      downloadExcel(orderResult.buffer, orderResult.filename);

      // 2) 플레이오토 운송장 양식
      const playAutoResult = generatePlayAutoTrackingExcel(targetOrders, courierCodeMap);
      downloadExcel(playAutoResult.buffer, playAutoResult.filename);

      // 보관함 저장
      if (session?.access_token) {
        const saves = [
          { ...orderResult, file_type: "order_export" as const },
          { ...playAutoResult, file_type: "playauto_tracking" as const },
        ];
        for (const s of saves) {
          const base64 = arrayBufferToBase64(s.buffer);
          await fetch("/api/archives", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              file_name: s.filename,
              file_type: s.file_type,
              file_data: base64,
              order_count: targetOrders.length,
            }),
          });
        }
      }
    } catch (err) {
      console.error("자동 엑셀 내보내기 실패:", err);
    }
  };

  const handleApply = async () => {
    if (!mergedResult?.success.length) return;
    setApplying(true);

    const updates = mergedResult.success
      .filter((t: TrackingInfo) => t.trackingNo)
      .map((t: TrackingInfo) => ({
        purchase_order_no: t.orderNo,
        courier: t.courier,
        tracking_no: t.trackingNo,
      }));

    // 자동 내보내기 (적용 전에 실행 - collectedOrders에 이미 운송장 반영됨)
    await autoExportAll(collectedOrders);

    await onApply(updates);
    setApplying(false);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
            <div className="flex items-center gap-2">
              <Truck className="w-5 h-5 text-blue-400" />
              <h2 className="text-base font-semibold text-white">배송정보 자동 수집</h2>
            </div>
            <button onClick={onClose} className="p-1 text-white/40 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {step === "config" && (
              <>
                {credLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
                  </div>
                ) : !manualMode && autoCollectGroups.length > 0 ? (
                  /* === 자동 모드 === */
                  <>
                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <KeyRound className="w-4 h-4 text-blue-400" />
                        <span className="text-sm font-medium text-blue-400">등록된 계정으로 자동 수집</span>
                      </div>
                      <p className="text-xs text-white/40">
                        설정에 등록된 구매처 계정으로 자동 로그인하여 배송정보를 수집합니다.
                      </p>
                    </div>

                    {/* 수집 대상 플랫폼 목록 */}
                    <div className="space-y-2">
                      {autoCollectGroups.map(({ credential, platform: p, targets }) => (
                        <div key={credential.id} className="bg-white/5 border border-white/10 rounded-lg p-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium border ${
                                p === "gmarket"
                                  ? "bg-green-500/10 text-green-400 border-green-500/20"
                                  : p === "auction"
                                    ? "bg-orange-500/10 text-orange-400 border-orange-500/20"
                                    : "bg-cyan-500/10 text-cyan-400 border-cyan-500/20"
                              }`}>
                                {PLATFORM_LABELS[p]}
                              </span>
                              <span className="text-sm text-white">{credential.login_id}</span>
                              {credential.label && (
                                <span className="text-xs text-white/30">({credential.label})</span>
                              )}
                            </div>
                            <span className="text-sm font-medium text-white">{targets.length}건</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* 계정 미매칭 주문 안내 */}
                    {unmatchedOrders.length > 0 && (
                      <div className="bg-yellow-500/5 border border-yellow-500/10 rounded-lg p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-3.5 h-3.5 text-yellow-400" />
                            <span className="text-xs text-yellow-400/80">
                              계정 미매칭 — {unmatchedOrders.length}건 수집 불가
                            </span>
                          </div>
                          <Link
                            href="/workspace/settings"
                            className="text-xs text-blue-400 hover:text-blue-300"
                            onClick={onClose}
                          >
                            계정 등록
                          </Link>
                        </div>
                        <p className="text-xs text-white/20 mt-1">
                          주문의 구매 아이디와 일치하는 계정이 없습니다.
                        </p>
                      </div>
                    )}

                    <button
                      onClick={() => setManualMode(true)}
                      className="text-xs text-white/20 hover:text-white/40 transition-colors"
                    >
                      수동으로 로그인 정보 입력하기
                    </button>
                  </>
                ) : (
                  /* === 수동 모드 === */
                  <>
                    {credentials.length > 0 && (
                      <button
                        onClick={() => setManualMode(false)}
                        className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                        등록된 계정으로 자동 수집하기
                      </button>
                    )}

                    {credentials.length === 0 && (
                      <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                        <div className="flex items-center gap-2">
                          <Settings className="w-4 h-4 text-white/30" />
                          <span className="text-xs text-white/40">
                            구매처 계정을 등록하면 원클릭 자동 수집이 가능합니다.
                          </span>
                          <Link
                            href="/workspace/settings"
                            className="text-xs text-blue-400 hover:text-blue-300 ml-auto shrink-0"
                            onClick={onClose}
                          >
                            설정
                          </Link>
                        </div>
                      </div>
                    )}

                    {/* 플랫폼 선택 */}
                    <div>
                      <label className="text-xs text-white/50 mb-1.5 block">구매처</label>
                      <div className="flex gap-2">
                        {SUPPORTED_PLATFORMS.map((p) => (
                          <button
                            key={p}
                            onClick={() => setPlatform(p)}
                            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                              platform === p
                                ? p === "gmarket"
                                  ? "bg-green-600/20 text-green-400 border border-green-500/30"
                                  : p === "auction"
                                    ? "bg-orange-600/20 text-orange-400 border border-orange-500/30"
                                    : "bg-cyan-600/20 text-cyan-400 border border-cyan-500/30"
                                : "bg-white/5 text-white/40 border border-white/10 hover:text-white/60"
                            }`}
                          >
                            {PLATFORM_LABELS[p]}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 로그인 정보 */}
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-white/50 mb-1.5 block">{PLATFORM_LABELS[platform]} 아이디</label>
                        <input
                          type="text"
                          value={loginId}
                          onChange={(e) => setLoginId(e.target.value)}
                          placeholder="아이디 입력"
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 outline-none focus:border-blue-500/50"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-white/50 mb-1.5 block">비밀번호</label>
                        <div className="relative">
                          <input
                            type={showPw ? "text" : "password"}
                            value={loginPw}
                            onChange={(e) => setLoginPw(e.target.value)}
                            placeholder="비밀번호 입력"
                            onKeyDown={(e) => e.key === "Enter" && handleManualCollect()}
                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 pr-10 text-sm text-white placeholder:text-white/20 outline-none focus:border-blue-500/50"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPw(!showPw)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                          >
                            {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* 수집 대상 */}
                    <div className="bg-white/5 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-white/50">수집 대상</span>
                        <span className="text-sm font-medium text-white">{manualTargets.length}건</span>
                      </div>
                      <p className="text-xs text-white/30">
                        구매처가 &quot;{PLATFORM_LABELS[platform]}&quot;이고 운송장이 비어있는 주문
                      </p>
                      {manualTargets.length > 0 && (
                        <div className="mt-2 max-h-28 overflow-y-auto space-y-1">
                          {manualTargets.slice(0, 10).map((o) => (
                            <div key={o.id} className="flex items-center gap-2 text-xs">
                              <span className="text-blue-400 font-mono">{o.purchase_order_no}</span>
                              <span className="text-white/30 truncate flex-1">{o.product_name}</span>
                            </div>
                          ))}
                          {manualTargets.length > 10 && (
                            <p className="text-xs text-white/20">외 {manualTargets.length - 10}건...</p>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {error && (
                  <div className="flex items-center gap-2 text-red-400 text-xs bg-red-500/10 rounded-lg px-3 py-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {error}
                  </div>
                )}
              </>
            )}

            {step === "collecting" && (
              <div className="flex flex-col items-center justify-center py-10 gap-4">
                <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
                <p className="text-sm text-white/60">{progress}</p>
                <p className="text-xs text-white/30">{progressDetail || "잠시만 기다려주세요..."}</p>
              </div>
            )}

            {step === "result" && mergedResult && (
              <>
                {/* 결과 요약 */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-green-500/10 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-green-400">{mergedResult.success.length}</p>
                    <p className="text-xs text-green-400/60">성공</p>
                  </div>
                  <div className="bg-red-500/10 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-red-400">{mergedResult.failed.length}</p>
                    <p className="text-xs text-red-400/60">실패</p>
                  </div>
                  <div className="bg-yellow-500/10 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-yellow-400">{mergedResult.notFound.length}</p>
                    <p className="text-xs text-yellow-400/60">미발견</p>
                  </div>
                </div>

                {/* 성공 목록 */}
                {mergedResult.success.length > 0 && (
                  <div>
                    <h3 className="text-xs font-medium text-white/50 mb-2">수집 완료</h3>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {mergedResult.success.map((t: TrackingInfo) => (
                        <div key={t.orderNo} className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                          <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
                          <span className="text-xs text-blue-400 font-mono">{t.orderNo}</span>
                          <span className="text-xs text-white/50">{t.courier}</span>
                          <span className="text-xs text-white/70 font-mono">{t.trackingNo}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 실패/미발견 목록 */}
                {(mergedResult.failed.length > 0 || mergedResult.notFound.length > 0) && (
                  <div>
                    <h3 className="text-xs font-medium text-white/50 mb-2">실패/미발견</h3>
                    <div className="space-y-1 max-h-28 overflow-y-auto">
                      {mergedResult.failed.map((f) => (
                        <div key={f.orderNo} className="flex items-center gap-2 text-xs">
                          <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          <span className="text-white/50 font-mono">{f.orderNo}</span>
                          <span className="text-red-400/60">{f.reason}</span>
                        </div>
                      ))}
                      {mergedResult.notFound.map((no) => (
                        <div key={no} className="flex items-center gap-2 text-xs">
                          <AlertCircle className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
                          <span className="text-white/50 font-mono">{no}</span>
                          <span className="text-yellow-400/60">구매처에서 찾을 수 없음</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 엑셀 내보내기 */}
                {collectedOrders.length > 0 && (
                  <div>
                    <h3 className="text-xs font-medium text-white/50 mb-2">엑셀 내보내기</h3>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleExport("order")}
                        disabled={exporting !== null}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-400 hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {exporting === "order" ? "저장 중..." : "발주서 양식"}
                      </button>
                      <button
                        onClick={() => handleExport("playauto")}
                        disabled={exporting !== null}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-500/10 border border-purple-500/20 rounded-lg text-xs text-purple-400 hover:bg-purple-500/20 disabled:opacity-50 transition-colors"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        {exporting === "playauto" ? "저장 중..." : "플레이오토 운송장"}
                      </button>
                    </div>
                    <p className="text-xs text-white/20 mt-1.5">다운로드와 동시에 보관함에 자동 저장됩니다</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-white/10 shrink-0 flex items-center gap-2">
            {step === "config" && (
              <>
                <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm text-white/50 bg-white/5 hover:bg-white/10 transition-colors">
                  취소
                </button>
                {!manualMode && autoCollectGroups.length > 0 ? (
                  <button
                    onClick={handleAutoCollect}
                    disabled={totalAutoTargets === 0}
                    className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-30 transition-colors"
                  >
                    자동 수집 ({totalAutoTargets}건)
                  </button>
                ) : (
                  <button
                    onClick={handleManualCollect}
                    disabled={!loginId || !loginPw || manualTargets.length === 0}
                    className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-30 transition-colors"
                  >
                    수집 시작 ({manualTargets.length}건)
                  </button>
                )}
              </>
            )}
            {step === "result" && (
              <>
                <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm text-white/50 bg-white/5 hover:bg-white/10 transition-colors">
                  닫기
                </button>
                {mergedResult && mergedResult.success.length > 0 && (
                  <button
                    onClick={handleApply}
                    disabled={applying}
                    className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    {applying ? "적용 중..." : `발주서에 적용 (${mergedResult.success.length}건)`}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
