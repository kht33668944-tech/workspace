"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { X, Loader2, CheckCircle, AlertCircle, ExternalLink, Plus } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import type { GmarketProductResult } from "@/app/api/scrape/gmarket-product/route";
import type { ProductInsert } from "@/types/database";

interface Props {
  onClose: () => void;
  onImport: (rows: Omit<ProductInsert, "user_id">[]) => Promise<{ error: string | null }>;
  productCount: number;
  categories: string[];
}

type Stage = "input" | "loading" | "preview";

interface PreviewItem extends GmarketProductResult {
  editedName: string;
  selectedCategory: string;
}

export default function GmarketImportModal({ onClose, onImport, productCount, categories }: Props) {
  const { session } = useAuth();
  const [stage, setStage] = useState<Stage>("input");
  const [urlFields, setUrlFields] = useState<string[]>([""]);
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [loadingStatus, setLoadingStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const validUrls = useMemo(
    () => urlFields.map((u) => u.trim()).filter((u) => u.includes("gmarket.co.kr")),
    [urlFields]
  );
  const invalidCount = useMemo(
    () => urlFields.filter((u) => u.trim() && !u.includes("gmarket.co.kr")).length,
    [urlFields]
  );

  // 필드 변경: 마지막 칸이 채워지면 빈 칸 자동 추가
  const handleChange = useCallback((index: number, value: string) => {
    setUrlFields((prev) => {
      const next = [...prev];
      next[index] = value;
      // 마지막 칸에 내용이 생기면 새 빈 칸 추가
      if (value.trim() && index === next.length - 1) {
        next.push("");
      }
      return next;
    });
  }, []);

  // 붙여넣기: 줄바꿈 감지 → 자동 분리
  const handlePaste = useCallback((index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted.includes("\n")) return; // 단일 줄이면 기본 동작 유지

    e.preventDefault();
    const lines = pasted
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    setUrlFields((prev) => {
      const next = [...prev];
      // 현재 인덱스부터 lines로 채우기
      lines.forEach((line, i) => {
        next[index + i] = line;
      });
      // 항상 마지막에 빈 칸 보장
      if (next[next.length - 1].trim()) next.push("");
      return next;
    });

    // 포커스를 마지막 채워진 칸 다음으로
    setTimeout(() => {
      const nextIdx = index + lines.length;
      inputRefs.current[nextIdx]?.focus();
    }, 0);
  }, []);

  // 개별 삭제
  const handleDelete = useCallback((index: number) => {
    setUrlFields((prev) => {
      if (prev.length === 1) return [""];
      const next = prev.filter((_, i) => i !== index);
      // 마지막 칸이 비어있지 않으면 빈 칸 추가
      if (next[next.length - 1].trim()) next.push("");
      return next;
    });
  }, []);

  const handleStart = async () => {
    if (validUrls.length === 0) {
      setError("유효한 지마켓 URL이 없습니다.\n(예: https://www.gmarket.co.kr/Item/...)");
      return;
    }
    setError(null);
    setStage("loading");
    setLoadingStatus(`${validUrls.length}개 상품 스크래핑 중...`);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/scrape/gmarket-product", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ urls: validUrls, categories }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `서버 오류 (${res.status})`);
      }

      const data = (await res.json()) as { results: GmarketProductResult[] };
      const preview: PreviewItem[] = data.results.map((r) => ({
        ...r,
        editedName: r.product_name,
        selectedCategory: r.matched_category ?? "",
      }));
      setItems(preview);
      setStage("preview");
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        onClose();
        return;
      }
      setError(e instanceof Error ? e.message : "스크래핑 실패");
      setStage("input");
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    onClose();
  };

  const handleImport = async () => {
    const successItems = items.filter((i) => !i.error);
    if (successItems.length === 0) return;

    setSaving(true);
    setError(null);

    const rows: Omit<ProductInsert, "user_id">[] = successItems.map((item, idx) => ({
      product_name: item.editedName || item.product_name,
      lowest_price: item.price ?? 0,
      margin_rate: 0,
      category: item.selectedCategory,
      source_category: item.category,
      purchase_url: item.url,
      memo: "",
      sort_order: productCount + idx,
      thumbnail_url: item.thumbnail_url,
      image_urls: item.image_urls,
      source_platform: "gmarket",
      detail_html: null,
      detail_image_url: null,
    }));

    const { error: importError } = await onImport(rows);
    if (importError) {
      setError(importError);
      setSaving(false);
      return;
    }
    onClose();
  };

  const successCount = items.filter((i) => !i.error).length;
  const failCount = items.filter((i) => !!i.error).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                지마켓 상품 가져오기
              </h2>
              {stage === "input" && validUrls.length > 0 && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
                  {validUrls.length}개
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {stage === "input" && "URL을 하나씩 입력하거나 여러 개를 한 번에 붙여넣으세요"}
              {stage === "loading" && loadingStatus}
              {stage === "preview" && `성공 ${successCount}개${failCount > 0 ? ` / 실패 ${failCount}개` : ""}`}
            </p>
          </div>
          <button
            onClick={stage === "loading" ? handleCancel : onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* ── INPUT 단계 ── */}
          {stage === "input" && (
            <div className="space-y-2">
              {/* 카운트 배너 */}
              <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-3">
                <span>
                  현재 등록된 상품:{" "}
                  <strong className={validUrls.length > 0 ? "text-blue-400" : "text-[var(--text-primary)]"}>
                    {validUrls.length}개
                  </strong>
                </span>
                {invalidCount > 0 && (
                  <span className="text-amber-400">
                    지마켓 URL이 아닌 항목 {invalidCount}개 제외됨
                  </span>
                )}
              </div>

              {/* URL 입력 리스트 */}
              <div className="space-y-1.5">
                {urlFields.map((url, idx) => {
                  const isValid = url.trim().includes("gmarket.co.kr");
                  const isInvalid = url.trim().length > 0 && !isValid;
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-xs text-[var(--text-disabled)] w-5 text-right shrink-0 select-none">
                        {url.trim() ? idx + 1 : ""}
                      </span>
                      <div className="relative flex-1">
                        <input
                          ref={(el) => { inputRefs.current[idx] = el; }}
                          type="text"
                          value={url}
                          onChange={(e) => handleChange(idx, e.target.value)}
                          onPaste={(e) => handlePaste(idx, e)}
                          placeholder={idx === 0 ? "https://www.gmarket.co.kr/Item/..." : ""}
                          className={`w-full px-3 py-1.5 text-sm rounded-lg border bg-[var(--bg-main)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none transition-colors font-mono ${
                            isValid
                              ? "border-blue-500/50 focus:border-blue-400"
                              : isInvalid
                              ? "border-amber-500/50 focus:border-amber-400"
                              : "border-[var(--border)] focus:border-blue-400"
                          }`}
                        />
                        {isValid && (
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-400 pointer-events-none" />
                        )}
                      </div>
                      {url.trim() ? (
                        <button
                          onClick={() => handleDelete(idx)}
                          className="shrink-0 p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
                          title="삭제"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <span className="w-6 shrink-0" />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 직접 추가 버튼 */}
              <button
                onClick={() => setUrlFields((prev) => [...prev, ""])}
                className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-blue-400 transition-colors mt-1 pl-7"
              >
                <Plus className="w-3.5 h-3.5" />
                칸 추가
              </button>

              {error && (
                <p className="text-xs text-red-400 whitespace-pre-wrap pt-1">{error}</p>
              )}
            </div>
          )}

          {/* ── LOADING 단계 ── */}
          {stage === "loading" && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 className="w-10 h-10 text-blue-400 animate-spin" />
              <div className="text-center">
                <p className="text-sm text-[var(--text-primary)]">{loadingStatus}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  이미지 업로드 포함 — 상품당 15~30초 소요될 수 있습니다
                </p>
              </div>
            </div>
          )}

          {/* ── PREVIEW 단계 ── */}
          {stage === "preview" && (
            <div className="space-y-3">
              {error && (
                <p className="text-xs text-red-400 mb-2">{error}</p>
              )}
              {items.map((item, idx) => (
                <div
                  key={idx}
                  className={`rounded-xl border p-4 flex gap-4 ${
                    item.error
                      ? "border-red-500/40 bg-red-500/5"
                      : "border-[var(--border)] bg-[var(--bg-main)]"
                  }`}
                >
                  {/* 썸네일 */}
                  <div className="w-16 h-16 rounded-lg overflow-hidden bg-[var(--bg-card)] shrink-0 border border-[var(--border)]">
                    {item.thumbnail_url ? (
                      <img
                        src={item.thumbnail_url}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[var(--text-disabled)] text-xs">
                        없음
                      </div>
                    )}
                  </div>

                  {/* 내용 */}
                  <div className="flex-1 min-w-0 space-y-2">
                    {item.error ? (
                      <div className="flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                        <span className="text-xs text-red-400 truncate">{item.error}</span>
                      </div>
                    ) : (
                      <>
                        <input
                          value={item.editedName}
                          onChange={(e) => {
                            const val = e.target.value;
                            setItems((prev) =>
                              prev.map((p, i) =>
                                i === idx ? { ...p, editedName: val } : p
                              )
                            );
                          }}
                          className="w-full px-2 py-1 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] outline-none focus:border-blue-400"
                          placeholder="상품명"
                        />
                        {/* 카테고리 행 */}
                        <div className="flex items-center gap-2">
                          {item.category && (
                            <span className="text-xs text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded shrink-0">
                              G마켓: {item.category}
                            </span>
                          )}
                          <select
                            value={item.selectedCategory}
                            onChange={(e) => {
                              const val = e.target.value;
                              setItems((prev) =>
                                prev.map((p, i) =>
                                  i === idx ? { ...p, selectedCategory: val } : p
                                )
                              );
                            }}
                            className="flex-1 min-w-0 px-2 py-0.5 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] outline-none focus:border-blue-400"
                          >
                            <option value="">카테고리 선택 (선택사항)</option>
                            {categories.map((cat) => (
                              <option key={cat} value={cat}>{cat}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                          <span className="text-green-400 font-medium">
                            {item.price > 0
                              ? `${item.price.toLocaleString()}원`
                              : "가격 미확인"}
                          </span>
                          <span>이미지 {item.image_urls.length}장</span>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-blue-400 hover:underline"
                          >
                            <ExternalLink className="w-3 h-3" />
                            원본 링크
                          </a>
                        </div>
                      </>
                    )}
                  </div>

                  {/* 상태 아이콘 */}
                  <div className="shrink-0">
                    {item.error ? (
                      <AlertCircle className="w-5 h-5 text-red-400" />
                    ) : (
                      <CheckCircle className="w-5 h-5 text-green-400" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--border)] shrink-0">
          {stage === "input" && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleStart}
                disabled={validUrls.length === 0}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
              >
                스크래핑 시작 ({validUrls.length}개)
              </button>
            </>
          )}

          {stage === "loading" && (
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              취소
            </button>
          )}

          {stage === "preview" && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                닫기
              </button>
              <button
                onClick={handleImport}
                disabled={successCount === 0 || saving}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                전체 등록 ({successCount}건)
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
