"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { X, MessageSquare, Send, Plus, Pencil, Trash2, CheckCircle, AlertCircle, Loader2, Smartphone, Cloud } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import type { Order, SmsTemplate } from "@/types/database";
import { getByteLength, getMessageType, substituteTemplate } from "@/lib/sms-utils";

interface BulkSmsModalProps {
  orders: Order[];
  onClose: () => void;
}

type Step = "compose" | "sending" | "result";
type PhoneField = "recipient_phone" | "orderer_phone";
type Provider = "phone" | "solapi";

interface SendProgress {
  current: number;
  total: number;
  phone: string;
  status: string;
  message: string;
}

export default function BulkSmsModal({ orders, onClose }: BulkSmsModalProps) {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [step, setStep] = useState<Step>("compose");
  const [provider, setProvider] = useState<Provider>("phone");
  const [phoneField, setPhoneField] = useState<PhoneField>("recipient_phone");
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateContent, setTemplateContent] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(true);

  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [successCount, setSuccessCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const stepRef = useRef<Step>("compose");
  const initializedRef = useRef(false);

  const recipients = useMemo(() => {
    return orders.filter((o) => {
      const phone = o[phoneField];
      return phone && phone.replace(/[^0-9]/g, "").length >= 10;
    });
  }, [orders, phoneField]);

  const uniquePhoneCount = useMemo(() => {
    const phones = new Set(recipients.map((o) => (o[phoneField] as string).replace(/[^0-9]/g, "")));
    return phones.size;
  }, [recipients, phoneField]);

  const previewMessage = useMemo(() => {
    if (!templateContent || recipients.length === 0) return "";
    const order = recipients[0];
    const variables: Record<string, string> = {
      recipient_name: order.recipient_name || "",
      product_name: order.product_name || "",
      quantity: String(order.quantity || 1),
      marketplace: order.marketplace || "",
      courier: order.courier || "",
      tracking_no: order.tracking_no || "",
      order_date: order.order_date ? order.order_date.slice(0, 16).replace("T", " ") : "",
      address: [order.address, order.address_detail].filter(Boolean).join(" "),
      delivery_memo: order.delivery_memo || "",
    };
    return substituteTemplate(templateContent, variables);
  }, [templateContent, recipients]);

  const messageType = useMemo(() => getMessageType(previewMessage || templateContent), [previewMessage, templateContent]);
  const byteLength = useMemo(() => getByteLength(previewMessage || templateContent), [previewMessage, templateContent]);
  const costPerMessage = messageType === "LMS" ? 50 : 20;
  const estimatedCost = provider === "phone" ? 0 : recipients.length * costPerMessage;

  const fetchTemplates = useCallback(async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch("/api/sms/templates", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as SmsTemplate[];
        setTemplates(data);
        // 최초 로드 시에만 기본 템플릿 자동 선택 (이후 '새 템플릿' 클릭 등으로 재실행돼도 덮어쓰지 않음)
        if (!initializedRef.current && data.length > 0) {
          initializedRef.current = true;
          const defaultTpl = data.find((t) => t.is_default) || data[0];
          setSelectedTemplateId(defaultTpl.id);
          setTemplateContent(defaultTpl.content);
          setTemplateName(defaultTpl.name);
        }
      }
    } catch {
      // ignore
    } finally {
      setTemplatesLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  // 언마운트 시 진행 중 발송 중단 (post-unmount setState 방지)
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const handleTemplateChange = (id: string) => {
    const tpl = templates.find((t) => t.id === id);
    if (tpl) {
      setSelectedTemplateId(tpl.id);
      setTemplateContent(tpl.content);
      setTemplateName(tpl.name);
      setIsEditing(false);
    }
  };

  const handleSaveTemplate = async () => {
    if (!session?.access_token || !templateName.trim() || !templateContent.trim()) return;

    const method = selectedTemplateId && templates.some((t) => t.id === selectedTemplateId) ? "PUT" : "POST";
    const bodyData = method === "PUT"
      ? { id: selectedTemplateId, name: templateName.trim(), content: templateContent.trim() }
      : { name: templateName.trim(), content: templateContent.trim() };

    const res = await fetch("/api/sms/templates", {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(bodyData),
    });

    if (res.ok) {
      const saved = (await res.json()) as SmsTemplate;
      setSelectedTemplateId(saved.id);
      setIsEditing(false);
      showToast("템플릿 저장 완료", "success");
      fetchTemplates();
    } else {
      showToast("템플릿 저장 실패", "error");
    }
  };

  const handleDeleteTemplate = async () => {
    if (!session?.access_token || !selectedTemplateId) return;
    if (!confirm("이 템플릿을 삭제하시겠습니까?")) return;

    const res = await fetch(`/api/sms/templates?id=${selectedTemplateId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    if (res.ok) {
      showToast("템플릿 삭제됨", "success");
      setSelectedTemplateId(null);
      setTemplateContent("");
      setTemplateName("");
      fetchTemplates();
    }
  };

  const handleNewTemplate = () => {
    setSelectedTemplateId(null);
    setTemplateName("");
    setTemplateContent("");
    setIsEditing(true);
  };

  const handleSend = async () => {
    if (!session?.access_token || recipients.length === 0 || !templateContent.trim()) return;
    const confirmMsg =
      provider === "phone"
        ? `${recipients.length}건의 문자를 휴대폰(무료)으로 발송하시겠습니까?`
        : `${recipients.length}건의 문자를 SOLAPI로 발송하시겠습니까?\n예상 비용: 약 ${estimatedCost.toLocaleString()}원`;
    if (!confirm(confirmMsg)) return;

    // 미저장 템플릿이 있으면 자동 저장
    if (isEditing && templateName.trim() && templateContent.trim()) {
      await handleSaveTemplate();
    }

    setStep("sending");
    stepRef.current = "sending";
    setSuccessCount(0);
    setFailedCount(0);
    setProgress(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/sms/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          orderIds: recipients.map((o) => o.id),
          templateContent: templateContent.trim(),
          phoneField,
          provider,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || "발송 실패", "error");
        setStep("compose");
        stepRef.current = "compose";
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "progress") {
              setProgress({
                current: event.current,
                total: event.total,
                phone: event.phone,
                status: event.status,
                message: event.message,
              });
              if (event.status === "success") setSuccessCount((p) => p + 1);
              if (event.status === "failed") setFailedCount((p) => p + 1);
            } else if (event.type === "done") {
              setSuccessCount(event.success);
              setFailedCount(event.failed);
              setStep("result");
              stepRef.current = "result";
            } else if (event.type === "error") {
              showToast(event.message || "발송 오류", "error");
              setStep("result");
              stepRef.current = "result";
            }
          } catch {
            // ignore parse errors
          }
        }
      }

      if (stepRef.current !== "result") {
        setStep("result");
        stepRef.current = "result";
      }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        showToast("발송이 중단되었습니다.", "info");
      } else {
        showToast("발송 중 오류 발생", "error");
      }
      setStep("result");
      stepRef.current = "result";
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">단체문자 발송</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[var(--bg-hover)] rounded-lg">
            <X className="w-5 h-5 text-[var(--text-muted)]" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {step === "compose" && (
            <>
              {/* 발송 방식 선택 */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setProvider("phone")}
                  className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                    provider === "phone"
                      ? "bg-blue-600/20 border-blue-500 text-blue-300"
                      : "bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <Smartphone className="w-4 h-4" />휴대폰
                  </span>
                  <span className="text-xs opacity-80">무료 · [Web발신] 없음</span>
                </button>
                <button
                  type="button"
                  onClick={() => setProvider("solapi")}
                  className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                    provider === "solapi"
                      ? "bg-blue-600/20 border-blue-500 text-blue-300"
                      : "bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <Cloud className="w-4 h-4" />SOLAPI
                  </span>
                  <span className="text-xs opacity-80">건당 유료 · 항상 발송</span>
                </button>
              </div>

              {/* 수신자 정보 */}
              <div className="space-y-2">
                <div className="text-sm text-[var(--text-secondary)]">
                  수신자: <strong className="text-[var(--text-primary)]">{recipients.length}</strong>명
                  {recipients.length !== uniquePhoneCount && (
                    <span className="text-[var(--text-muted)]"> (고유번호: {uniquePhoneCount}명)</span>
                  )}
                  {recipients.length === 0 && (
                    <span className="text-red-400 ml-2">유효한 전화번호 없음</span>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="phoneField"
                      checked={phoneField === "recipient_phone"}
                      onChange={() => setPhoneField("recipient_phone")}
                      className="accent-blue-500"
                    />
                    <span className="text-[var(--text-secondary)]">수령자번호</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="phoneField"
                      checked={phoneField === "orderer_phone"}
                      onChange={() => setPhoneField("orderer_phone")}
                      className="accent-blue-500"
                    />
                    <span className="text-[var(--text-secondary)]">주문자번호</span>
                  </label>
                </div>
              </div>

              {/* 템플릿 선택 */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    value={selectedTemplateId || ""}
                    onChange={(e) => handleTemplateChange(e.target.value)}
                    className="flex-1 px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] outline-none"
                    disabled={templatesLoading}
                  >
                    <option value="" className="bg-[var(--bg-card)] text-[var(--text-primary)]">템플릿 선택...</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id} className="bg-[var(--bg-card)] text-[var(--text-primary)]">
                        {t.name}{t.is_default ? " (기본)" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleNewTemplate}
                    className="flex items-center gap-1 px-2.5 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">새 템플릿</span>
                  </button>
                  {selectedTemplateId && (
                    <>
                      <button
                        onClick={() => setIsEditing(!isEditing)}
                        className="p-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={handleDeleteTemplate}
                        className="p-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-[var(--text-muted)] hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>

                {isEditing && (
                  <input
                    type="text"
                    placeholder="템플릿 이름"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] outline-none"
                  />
                )}

                <textarea
                  value={templateContent}
                  onChange={(e) => { setTemplateContent(e.target.value); if (!isEditing) setIsEditing(true); }}
                  placeholder={"{recipient_name}님 안녕하세요.\n{product_name} 상품이 발송되었습니다.\n택배사: {courier}\n운송장: {tracking_no}"}
                  rows={5}
                  className="w-full px-3 py-2 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] outline-none resize-none font-mono"
                />

                <div className="flex flex-wrap gap-1">
                  {([
                    ["recipient_name", "수취인명"],
                    ["product_name", "상품명"],
                    ["quantity", "수량"],
                    ["marketplace", "판매처"],
                    ["courier", "택배사"],
                    ["tracking_no", "운송장번호"],
                    ["order_date", "주문일시"],
                    ["address", "주소"],
                    ["delivery_memo", "배송메모"],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setTemplateContent((prev) => prev + `{${key}}`)}
                      className="px-1.5 py-0.5 text-xs bg-blue-600/10 text-blue-400 rounded hover:bg-blue-600/20 transition-colors"
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {isEditing && templateName.trim() && templateContent.trim() && (
                  <button
                    onClick={handleSaveTemplate}
                    className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 bg-green-600/20 text-green-400 border border-green-600/30 text-sm font-medium rounded-lg hover:bg-green-600/30 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    템플릿 저장
                  </button>
                )}
              </div>

              {/* 미리보기 */}
              {previewMessage && (
                <div className="space-y-1.5">
                  <div className="text-xs text-[var(--text-muted)]">미리보기 (첫 번째 수신자 기준)</div>
                  <div className="px-3 py-2.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-secondary)] whitespace-pre-wrap font-mono">
                    {previewMessage}
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {messageType}({byteLength}바이트)
                    {" · "}
                    {provider === "phone"
                      ? "무료 (휴대폰 발송)"
                      : `예상 비용: 약 ${estimatedCost.toLocaleString()}원 (${recipients.length}건 x ${costPerMessage}원)`}
                  </div>
                </div>
              )}

              {/* 발송 버튼 */}
              <button
                onClick={handleSend}
                disabled={recipients.length === 0 || !templateContent.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                <Send className="w-4 h-4" />
                발송하기 ({recipients.length}건)
              </button>
            </>
          )}

          {step === "sending" && (
            <div className="space-y-4 py-4">
              <div className="text-center">
                <Loader2 className="w-8 h-8 text-blue-400 animate-spin mx-auto mb-3" />
                <div className="text-sm text-[var(--text-primary)] font-medium">문자 발송 중...</div>
              </div>
              {progress && (
                <>
                  <div className="w-full bg-[var(--bg-hover)] rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full transition-all"
                      style={{ width: `${(progress.current / progress.total) * 100}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-[var(--text-muted)]">
                    <span>{progress.current} / {progress.total}</span>
                    <span>
                      <span className="text-green-400">{successCount} 성공</span>
                      {failedCount > 0 && <span className="text-red-400 ml-2">{failedCount} 실패</span>}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {progress.phone} — {progress.message}
                  </div>
                </>
              )}
              <button
                onClick={handleCancel}
                className="w-full px-4 py-2 bg-red-600/20 text-red-400 text-sm rounded-lg hover:bg-red-600/30 transition-colors"
              >
                발송 중단
              </button>
            </div>
          )}

          {step === "result" && (
            <div className="space-y-4 py-4 text-center">
              {failedCount === 0 ? (
                <CheckCircle className="w-12 h-12 text-green-400 mx-auto" />
              ) : (
                <AlertCircle className="w-12 h-12 text-yellow-400 mx-auto" />
              )}
              <div className="text-lg font-semibold text-[var(--text-primary)]">발송 완료</div>
              <div className="flex justify-center gap-6 text-sm">
                <div>
                  <div className="text-2xl font-bold text-green-400">{successCount}</div>
                  <div className="text-[var(--text-muted)]">성공</div>
                </div>
                {failedCount > 0 && (
                  <div>
                    <div className="text-2xl font-bold text-red-400">{failedCount}</div>
                    <div className="text-[var(--text-muted)]">실패</div>
                  </div>
                )}
              </div>
              <button
                onClick={onClose}
                className="w-full px-4 py-2.5 bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-secondary)] text-sm rounded-lg hover:text-[var(--text-primary)] transition-colors"
              >
                닫기
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
