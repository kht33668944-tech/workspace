"use client";

import { useState, useMemo } from "react";
import { X, Truck, CheckCircle, AlertCircle, Loader2, Eye, EyeOff } from "lucide-react";
import type { Order } from "@/types/database";
import type { ScrapeResult, TrackingInfo } from "@/lib/scrapers/types";

interface TrackingCollectModalProps {
  orders: Order[];
  onClose: () => void;
  onApply: (updates: { purchase_order_no: string; courier: string; tracking_no: string }[]) => Promise<void>;
}

type Step = "config" | "collecting" | "result";

export default function TrackingCollectModal({ orders, onClose, onApply }: TrackingCollectModalProps) {
  const [step, setStep] = useState<Step>("config");
  const [platform, setPlatform] = useState<"gmarket" | "auction">("gmarket");
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<ScrapeResult | null>(null);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);

  // 수집 대상: 해당 플랫폼의 주문 중 운송장이 비어있는 건
  const targets = useMemo(() => {
    const platformName = platform === "gmarket" ? "지마켓" : "옥션";
    return orders.filter(
      (o) =>
        o.purchase_source === platformName &&
        o.purchase_order_no &&
        (!o.tracking_no || o.tracking_no.trim() === "")
    );
  }, [orders, platform]);

  const handleCollect = async () => {
    if (!loginId || !loginPw) {
      setError("아이디와 비밀번호를 입력해주세요.");
      return;
    }
    if (targets.length === 0) {
      setError("수집할 대상이 없습니다.");
      return;
    }

    setError("");
    setStep("collecting");
    setProgress("로그인 중...");

    try {
      const orderNos = targets.map((o) => o.purchase_order_no!);
      setProgress(`${orderNos.length}건 배송정보 수집 중...`);

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

      setResult(data as ScrapeResult);
      setStep("result");
    } catch (err) {
      setError(`오류: ${err instanceof Error ? err.message : String(err)}`);
      setStep("config");
    }
  };

  const handleApply = async () => {
    if (!result?.success.length) return;
    setApplying(true);

    const updates = result.success
      .filter((t: TrackingInfo) => t.trackingNo)
      .map((t: TrackingInfo) => ({
        purchase_order_no: t.orderNo,
        courier: t.courier,
        tracking_no: t.trackingNo,
      }));

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
                {/* 플랫폼 선택 */}
                <div>
                  <label className="text-xs text-white/50 mb-1.5 block">구매처</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setPlatform("gmarket")}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        platform === "gmarket"
                          ? "bg-green-600/20 text-green-400 border border-green-500/30"
                          : "bg-white/5 text-white/40 border border-white/10 hover:text-white/60"
                      }`}
                    >
                      지마켓
                    </button>
                    <button
                      onClick={() => setPlatform("auction")}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        platform === "auction"
                          ? "bg-orange-600/20 text-orange-400 border border-orange-500/30"
                          : "bg-white/5 text-white/40 border border-white/10 hover:text-white/60"
                      }`}
                    >
                      옥션
                    </button>
                  </div>
                </div>

                {/* 로그인 정보 */}
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-white/50 mb-1.5 block">{platform === "gmarket" ? "지마켓" : "옥션"} 아이디</label>
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
                        onKeyDown={(e) => e.key === "Enter" && handleCollect()}
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
                    <p className="text-xs text-white/20 mt-1">비밀번호는 서버에 저장되지 않습니다.</p>
                  </div>
                </div>

                {/* 수집 대상 */}
                <div className="bg-white/5 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-white/50">수집 대상</span>
                    <span className="text-sm font-medium text-white">{targets.length}건</span>
                  </div>
                  <p className="text-xs text-white/30">
                    구매처가 &quot;{platform === "gmarket" ? "지마켓" : "옥션"}&quot;이고 운송장이 비어있는 주문
                  </p>
                  {targets.length > 0 && (
                    <div className="mt-2 max-h-28 overflow-y-auto space-y-1">
                      {targets.slice(0, 10).map((o) => (
                        <div key={o.id} className="flex items-center gap-2 text-xs">
                          <span className="text-blue-400 font-mono">{o.purchase_order_no}</span>
                          <span className="text-white/30 truncate flex-1">{o.product_name}</span>
                        </div>
                      ))}
                      {targets.length > 10 && (
                        <p className="text-xs text-white/20">외 {targets.length - 10}건...</p>
                      )}
                    </div>
                  )}
                </div>

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
                <p className="text-xs text-white/30">잠시만 기다려주세요...</p>
              </div>
            )}

            {step === "result" && result && (
              <>
                {/* 결과 요약 */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-green-500/10 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-green-400">{result.success.length}</p>
                    <p className="text-xs text-green-400/60">성공</p>
                  </div>
                  <div className="bg-red-500/10 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-red-400">{result.failed.length}</p>
                    <p className="text-xs text-red-400/60">실패</p>
                  </div>
                  <div className="bg-yellow-500/10 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-yellow-400">{result.notFound.length}</p>
                    <p className="text-xs text-yellow-400/60">미발견</p>
                  </div>
                </div>

                {/* 성공 목록 */}
                {result.success.length > 0 && (
                  <div>
                    <h3 className="text-xs font-medium text-white/50 mb-2">수집 완료</h3>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {result.success.map((t: TrackingInfo) => (
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
                {(result.failed.length > 0 || result.notFound.length > 0) && (
                  <div>
                    <h3 className="text-xs font-medium text-white/50 mb-2">실패/미발견</h3>
                    <div className="space-y-1 max-h-28 overflow-y-auto">
                      {result.failed.map((f) => (
                        <div key={f.orderNo} className="flex items-center gap-2 text-xs">
                          <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          <span className="text-white/50 font-mono">{f.orderNo}</span>
                          <span className="text-red-400/60">{f.reason}</span>
                        </div>
                      ))}
                      {result.notFound.map((no) => (
                        <div key={no} className="flex items-center gap-2 text-xs">
                          <AlertCircle className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
                          <span className="text-white/50 font-mono">{no}</span>
                          <span className="text-yellow-400/60">{platform === "gmarket" ? "지마켓" : "옥션"}에서 찾을 수 없음</span>
                        </div>
                      ))}
                    </div>
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
                <button
                  onClick={handleCollect}
                  disabled={!loginId || !loginPw || targets.length === 0}
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-30 transition-colors"
                >
                  수집 시작 ({targets.length}건)
                </button>
              </>
            )}
            {step === "result" && (
              <>
                <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm text-white/50 bg-white/5 hover:bg-white/10 transition-colors">
                  닫기
                </button>
                {result && result.success.length > 0 && (
                  <button
                    onClick={handleApply}
                    disabled={applying}
                    className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    {applying ? "적용 중..." : `발주서에 적용 (${result.success.length}건)`}
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
