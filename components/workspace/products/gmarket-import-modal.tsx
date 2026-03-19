"use client";

import { useState, useRef } from "react";
import { X, Loader2, CheckCircle, AlertCircle, ExternalLink } from "lucide-react";
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
  const [urlText, setUrlText] = useState("");
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [loadingStatus, setLoadingStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const parseUrls = (): string[] => {
    return urlText
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter((u) => u.includes("gmarket.co.kr"));
  };

  const handleStart = async () => {
    const urls = parseUrls();
    if (urls.length === 0) {
      setError("유효한 지마켓 URL이 없습니다.\n(예: https://www.gmarket.co.kr/Item/...)");
      return;
    }
    setError(null);
    setStage("loading");
    setLoadingStatus(`${urls.length}개 상품 스크래핑 중...`);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/scrape/gmarket-product", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ urls, categories }),
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
  const validUrls = parseUrls();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              지마켓 상품 가져오기
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {stage === "input" && "URL을 한 줄에 하나씩 붙여넣으세요"}
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
            <div className="space-y-3">
              <textarea
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                placeholder={`https://www.gmarket.co.kr/Item/DetailView/Item.asp?goodscode=...\nhttps://item.gmarket.co.kr/Item?goodscode=...\n\n여러 URL을 줄바꿈으로 구분하여 입력`}
                className="w-full h-48 px-3 py-2.5 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-none outline-none focus:border-blue-400 font-mono"
              />
              {validUrls.length > 0 && (
                <p className="text-xs text-blue-400">
                  유효한 URL {validUrls.length}개 감지됨
                </p>
              )}
              {error && (
                <p className="text-xs text-red-400 whitespace-pre-wrap">{error}</p>
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
