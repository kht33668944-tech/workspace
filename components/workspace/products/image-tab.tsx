"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Search, X, Copy, Check, ImageOff, Upload, Trash2, Loader2,
  Sparkles, FileText, ExternalLink, Play, ChevronDown, ChevronUp,
  Star, Link2, Code2, Layers, ShieldAlert,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { useAiTask } from "@/context/AiTaskContext";
import type { Product, ProductUpdate } from "@/types/database";
import BatchDetailModal from "./batch-detail-modal";
import ForbiddenWordsModal from "./forbidden-words-modal";

interface Props {
  products: Product[];
  onUpdate: (id: string, updates: ProductUpdate, skipUndo?: boolean) => void;
  onDelete: (ids: string[]) => Promise<{ error: string | null } | undefined>;
}

function urlToStoragePath(publicUrl: string): string {
  const marker = "/product-images/";
  const idx = publicUrl.indexOf(marker);
  return idx >= 0 ? publicUrl.slice(idx + marker.length) : publicUrl;
}

type CopyState = "idle" | "copied";

function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  const copy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => null);
    setState("copied");
    setTimeout(() => setState("idle"), 1500);
  }, []);
  return { state, copy };
}

function HtmlCopyButton({ html }: { html: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(html).catch(() => null);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      title="HTML 복사"
      className={`p-1.5 rounded transition-colors ${
        copied
          ? "text-amber-400"
          : "text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-400/10"
      }`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

interface ImageCellProps {
  url: string;
  isThumb: boolean;
  onDelete: () => void;
  onSetThumbAndKeepOnly: () => void;
  onSetThumbOnly: () => void;
}

function ImageCell({ url, isThumb, onDelete, onSetThumbAndKeepOnly, onSetThumbOnly }: ImageCellProps) {
  const urlCopy = useCopy();
  const htmlCopy = useCopy();

  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      {/* 이미지 */}
      <div
        className={`relative w-24 h-24 rounded-lg overflow-hidden border-2 ${
          isThumb ? "border-blue-500" : "border-[var(--border)]"
        }`}
      >
        <img
          src={url}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover cursor-pointer"
          onClick={() => window.open(url, "_blank")}
        />
        {isThumb && (
          <div className="absolute top-0.5 left-0.5 bg-blue-500 rounded text-[8px] text-white px-1 leading-4 pointer-events-none">
            대표
          </div>
        )}
      </div>

      {/* 버튼 행 */}
      <div className="flex items-center justify-center gap-0">
        {!isThumb && (
          <button
            onClick={onSetThumbOnly}
            title="대표 설정"
            className="p-1 rounded text-[var(--text-muted)] hover:text-blue-400 hover:bg-blue-400/10 transition-colors"
          >
            <Star className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={onSetThumbAndKeepOnly}
          title="이것만 남기기"
          className="p-1 rounded text-[var(--text-muted)] hover:text-emerald-400 hover:bg-emerald-400/10 transition-colors"
        >
          <Layers className="w-3 h-3" />
        </button>
        <button
          onClick={() => urlCopy.copy(url)}
          title={urlCopy.state === "copied" ? "복사됨" : "URL 복사"}
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border)] transition-colors"
        >
          {urlCopy.state === "copied" ? <Check className="w-3 h-3 text-emerald-400" /> : <Link2 className="w-3 h-3" />}
        </button>
        <button
          onClick={() => htmlCopy.copy(`<img src='${url}' />`)}
          title={htmlCopy.state === "copied" ? "복사됨" : "HTML 복사"}
          className="p-1 rounded text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-400/10 transition-colors"
        >
          {htmlCopy.state === "copied" ? <Check className="w-3 h-3 text-emerald-400" /> : <Code2 className="w-3 h-3" />}
        </button>
        <button
          onClick={onDelete}
          title="삭제"
          className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function DetailImageCell({ url, onClear }: { url: string; onClear: () => void }) {
  const htmlCopy = useCopy();

  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <div className="relative w-24 h-24 rounded-lg overflow-hidden border-2 border-amber-500">
        <img
          src={url}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover cursor-pointer"
          onClick={() => window.open(url, "_blank")}
        />
        <div className="absolute top-0.5 left-0.5 bg-amber-500 rounded text-[8px] text-white px-1 leading-4 pointer-events-none">
          상세
        </div>
      </div>
      <div className="flex items-center justify-center gap-0">
        <button
          onClick={() => htmlCopy.copy(`<img src='${url}' />`)}
          title={htmlCopy.state === "copied" ? "복사됨" : "HTML 복사"}
          className="p-1 rounded text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-400/10 transition-colors"
        >
          {htmlCopy.state === "copied" ? <Check className="w-3 h-3 text-emerald-400" /> : <Code2 className="w-3 h-3" />}
        </button>
        <button
          onClick={onClear}
          title="상세이미지 삭제"
          className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

const MAX_IMAGES_DEFAULT = 8;

function formatDateGroup(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "날짜 미상";
  }
}

export default function ImageTab({ products, onUpdate, onDelete }: Props) {
  const { user, session } = useAuth();
  const {
    tasks,
    setThumbStatus,
    setDetailStatus,
    setThumbSummary,
    batchItems,
    batchActive,
    batchVisible,
    startBatch,
    dismissBatch,
    clearBatch,
    registerOnUpdate,
    unregisterOnUpdate,
  } = useAiTask();

  const [search, setSearch] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedImages, setExpandedImages] = useState<Set<string>>(new Set());
  const [forbiddenOpen, setForbiddenOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const authHeaders = {
    Authorization: `Bearer ${session?.access_token ?? ""}`,
    "Content-Type": "application/json",
  };

  useEffect(() => {
    mountedRef.current = true;
    registerOnUpdate(onUpdate);
    return () => {
      mountedRef.current = false;
      unregisterOnUpdate();
    };
  }, [onUpdate, registerOnUpdate, unregisterOnUpdate]);

  const handleOptimizeThumbnail = async (product: Product) => {
    if (!product.image_urls.length) return;
    setThumbStatus(product.id, "loading");
    try {
      const res = await fetch("/api/ai/thumbnail", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ productId: product.id, imageUrls: product.image_urls }),
      });
      const data = await res.json() as { thumbnailUrl?: string; summary?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "실패");
      if (mountedRef.current) onUpdate(product.id, { thumbnail_url: data.thumbnailUrl ?? null }, true);
      setThumbSummary(product.id, data.summary ?? "완료");
      setThumbStatus(product.id, "done");
    } catch (e) {
      console.error("[image-tab] 썸네일 생성 실패:", e instanceof Error ? e.message : String(e));
      setThumbStatus(product.id, "error");
    }
  };

  const handleGenerateDetail = async (product: Product) => {
    setDetailStatus(product.id, "loading");
    try {
      const res = await fetch("/api/ai/detail", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          productId: product.id,
          productName: product.product_name,
          purchaseUrl: product.purchase_url,
          thumbnailUrl: product.thumbnail_url,
        }),
      });
      const data = await res.json() as { detailHtml?: string; detailImageUrl?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "실패");
      if (mountedRef.current)
        onUpdate(product.id, { detail_html: data.detailHtml ?? null, detail_image_url: data.detailImageUrl ?? null }, true);
      setDetailStatus(product.id, "done");
    } catch (e) {
      console.error("[image-tab] 상세페이지 생성 실패:", e instanceof Error ? e.message : String(e));
      setDetailStatus(product.id, "error");
    }
  };

  const filtered = products.filter((p) => {
    const hasImages = p.image_urls && p.image_urls.length > 0;
    if (!showEmpty && !hasImages) return false;
    if (search) return p.product_name.toLowerCase().includes(search.toLowerCase());
    return true;
  });

  // 날짜별 그룹화 (최신순)
  const groupedByDate = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of filtered) {
      const key = p.created_at ? formatDateGroup(p.created_at) : "날짜 미상";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return [...map.entries()].sort(([, a], [, b]) => {
      const aDate = a[0]?.created_at ?? "";
      const bDate = b[0]?.created_at ?? "";
      return bDate.localeCompare(aDate);
    });
  }, [filtered]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleExpandImages = (productId: string) => {
    setExpandedImages((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const handleStartBatchDetail = () => {
    const selected = filtered.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) return;
    startBatch(
      selected.map((p) => ({
        productId: p.id,
        productName: p.product_name,
        purchaseUrl: p.purchase_url,
        thumbnailUrl: p.thumbnail_url,
      })),
      session?.access_token ?? ""
    );
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map((p) => p.id))
    );
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size}개 상품을 삭제하시겠습니까?\n(이미지 파일도 함께 삭제됩니다)`)) return;
    setDeleting(true);
    // Storage 이미지 삭제 + DB 삭제는 onDelete(deleteProducts)에서 일괄 처리
    const result = await onDelete([...selectedIds]);
    if (result?.error) {
      console.error("[image-tab] 상품 삭제 실패:", result.error);
    }
    setSelectedIds(new Set());
    setDeleting(false);
  };

  const handleDeleteImage = async (product: Product, imageUrl: string) => {
    const newUrls = product.image_urls.filter((u) => u !== imageUrl);
    const newThumb =
      product.thumbnail_url === imageUrl ? (newUrls[0] ?? null) : product.thumbnail_url;
    await supabase.storage.from("product-images").remove([urlToStoragePath(imageUrl)]);
    onUpdate(product.id, { image_urls: newUrls, thumbnail_url: newThumb }, true);
  };

  const handleSetThumbOnly = (product: Product, imageUrl: string) => {
    onUpdate(product.id, { thumbnail_url: imageUrl }, true);
  };

  const handleSetThumbAndKeepOnly = async (product: Product, imageUrl: string) => {
    const toDelete = product.image_urls.filter((u) => u !== imageUrl);
    if (toDelete.length > 0)
      await supabase.storage.from("product-images").remove(toDelete.map(urlToStoragePath));
    onUpdate(product.id, { image_urls: [imageUrl], thumbnail_url: imageUrl }, true);
  };

  const handleClearDetailImage = async (product: Product) => {
    if (product.detail_image_url) {
      await supabase.storage.from("product-images").remove([urlToStoragePath(product.detail_image_url)]);
    }
    onUpdate(product.id, { detail_image_url: null }, true);
  };

  const handleDeleteAll = async (product: Product) => {
    if (!confirm(`"${product.product_name}" 의 이미지 ${product.image_urls.length}장을 모두 삭제하시겠습니까?`)) return;
    await supabase.storage.from("product-images").remove(product.image_urls.map(urlToStoragePath));
    onUpdate(product.id, { image_urls: [], thumbnail_url: null }, true);
  };

  const handleUploadClick = (productId: string) => {
    uploadTargetRef.current = productId;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const productId = uploadTargetRef.current;
    if (!file || !productId || !user) return;
    e.target.value = "";
    setUploading(productId);
    try {
      const product = products.find((p) => p.id === productId);
      if (!product) return;
      const ext = file.name.split(".").pop() || "jpg";
      const path = `products/${user.id}/${Date.now()}_manual.${ext}`;
      const { error } = await supabase.storage
        .from("product-images")
        .upload(path, file, { contentType: file.type, upsert: true });
      if (error) { console.error("[image-tab] 업로드 실패:", error.message); return; }
      const { data } = supabase.storage.from("product-images").getPublicUrl(path);
      const newUrls = [...(product.image_urls || []), data.publicUrl];
      const newThumb = product.thumbnail_url ?? data.publicUrl;
      onUpdate(productId, { image_urls: newUrls, thumbnail_url: newThumb }, true);
    } finally {
      setUploading(null);
    }
  };

  const withImages = products.filter((p) => p.image_urls && p.image_urls.length > 0).length;

  return (
    <div className="space-y-3">
      {batchVisible && (
        <BatchDetailModal items={batchItems} onClose={dismissBatch} onClear={clearBatch} />
      )}
      <ForbiddenWordsModal open={forbiddenOpen} onClose={() => setForbiddenOpen(false)} />
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* 툴바 */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="checkbox"
          checked={filtered.length > 0 && selectedIds.size === filtered.length}
          ref={(el) => {
            if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < filtered.length;
          }}
          onChange={toggleSelectAll}
          className="w-4 h-4 rounded cursor-pointer"
          title="전체 선택"
        />
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="상품명 검색..."
            className="w-full pl-10 pr-3 py-2 text-sm bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-400"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--text-muted)] cursor-pointer select-none">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} className="rounded" />
          이미지 없는 상품 포함
        </label>
        <button
          onClick={() => setForbiddenOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-zinc-700/40 text-zinc-300 hover:bg-zinc-700/60 rounded-lg transition-colors"
          title="상세페이지 생성 시 제외할 단어 관리"
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          금지어 관리
        </button>
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleStartBatchDetail}
              disabled={batchActive}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 rounded-lg transition-colors disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              {batchActive ? "생성 중..." : `${selectedIds.size}개 상세페이지 일괄 생성`}
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? "삭제 중..." : `${selectedIds.size}개 삭제`}
            </button>
          </div>
        )}
        <span className="text-xs text-[var(--text-muted)] ml-auto">
          이미지 있는 상품 <strong className="text-[var(--text-primary)]">{withImages}</strong>건
        </span>
      </div>

      {/* 목록 */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-[var(--text-muted)]">
          <ImageOff className="w-10 h-10 opacity-40" />
          <p className="text-sm">
            {search ? "검색 결과가 없습니다." : "이미지가 있는 상품이 없습니다."}
          </p>
          {!search && (
            <p className="text-xs opacity-60">
              지마켓 가져오기로 상품을 등록하면 이미지가 자동으로 저장됩니다.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {groupedByDate.map(([dateLabel, groupProducts]) => {
            const isCollapsed = collapsedGroups.has(dateLabel);
            return (
              <div key={dateLabel}>
                {/* 날짜 그룹 헤더 */}
                <button
                  onClick={() => toggleGroup(dateLabel)}
                  className="w-full flex items-center gap-2 px-1 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors group"
                >
                  <span className="font-medium text-[var(--text-secondary)]">{dateLabel}</span>
                  <span className="text-[var(--text-disabled)]">· {groupProducts.length}건</span>
                  <span className="flex-1 h-px bg-[var(--border)] mx-1" />
                  {isCollapsed
                    ? <ChevronDown className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100" />
                    : <ChevronUp className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100" />}
                </button>

                {/* 상품 목록 */}
                {!isCollapsed && (
                  <div className="space-y-1.5 mt-1">
                    {groupProducts.map((product) => {
                      const hasImages = product.image_urls && product.image_urls.length > 0;
                      const isSelected = selectedIds.has(product.id);
                      const isUploading = uploading === product.id;
                      const isExpanded = expandedImages.has(product.id);
                      const thumbTask = tasks[product.id];
                      // 썸네일을 맨 앞으로 정렬
                      const thumbUrl = product.thumbnail_url;
                      const sortedImages = thumbUrl && product.image_urls.includes(thumbUrl)
                        ? [thumbUrl, ...product.image_urls.filter((u) => u !== thumbUrl)]
                        : product.image_urls;
                      const visibleImages = isExpanded
                        ? sortedImages
                        : sortedImages.slice(0, MAX_IMAGES_DEFAULT);
                      const hiddenCount = sortedImages.length - MAX_IMAGES_DEFAULT;

                      return (
                        <div
                          key={product.id}
                          className={`rounded-xl border px-2 py-2 transition-colors ${
                            isSelected
                              ? "border-blue-500/50 bg-blue-500/5"
                              : "border-[var(--border)] bg-[var(--bg-main)]"
                          }`}
                        >
                          {/* 상단 행: 체크박스 + 상품정보 + 액션버튼 */}
                          <div className="flex items-center gap-2.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelect(product.id)}
                              className="w-4 h-4 rounded cursor-pointer shrink-0"
                            />

                            {/* 상품 정보 */}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-[var(--text-primary)] font-medium truncate leading-snug">
                                {product.product_name || "(이름 없음)"}
                              </p>
                              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                {product.source_platform && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">
                                    {product.source_platform}
                                  </span>
                                )}
                                {product.source_category && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
                                    {product.source_category}
                                  </span>
                                )}
                                {product.lowest_price > 0 && (
                                  <span className="text-[10px] text-[var(--text-muted)]">
                                    {product.lowest_price.toLocaleString()}원
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* 액션 버튼 (아이콘) */}
                            <div className="flex items-center gap-0.5 shrink-0">
                              {/* 이미지 추가 */}
                              <button
                                onClick={() => handleUploadClick(product.id)}
                                disabled={isUploading}
                                title={isUploading ? "업로드 중..." : "이미지 추가"}
                                className="p-1.5 rounded text-[var(--text-muted)] hover:text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-50"
                              >
                                {isUploading
                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : <Upload className="w-3.5 h-3.5" />}
                              </button>

                              {/* 전체 삭제 */}
                              {hasImages && (
                                <button
                                  onClick={() => handleDeleteAll(product)}
                                  title="전체 삭제"
                                  className="p-1.5 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {hasImages && (
                                <>
                                  {/* 최적 썸네일 */}
                                  <button
                                    onClick={() => handleOptimizeThumbnail(product)}
                                    disabled={thumbTask?.thumbStatus === "loading"}
                                    title={
                                      thumbTask?.thumbStatus === "loading" ? "분석 중..." :
                                      thumbTask?.thumbStatus === "done" ? `완료: ${thumbTask.thumbSummary}` :
                                      "최적 썸네일 선택"
                                    }
                                    className={`p-1.5 rounded transition-colors disabled:opacity-50 ${
                                      thumbTask?.thumbStatus === "done"
                                        ? "text-emerald-400"
                                        : thumbTask?.thumbStatus === "error"
                                        ? "text-red-400"
                                        : "text-[var(--text-muted)] hover:text-emerald-400 hover:bg-emerald-400/10"
                                    }`}
                                  >
                                    {thumbTask?.thumbStatus === "loading"
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <Sparkles className="w-3.5 h-3.5" />}
                                  </button>

                                  {/* 상세페이지 생성 */}
                                  <button
                                    onClick={() => handleGenerateDetail(product)}
                                    disabled={thumbTask?.detailStatus === "loading"}
                                    title={
                                      thumbTask?.detailStatus === "loading" ? "생성 중..." :
                                      thumbTask?.detailStatus === "done" ? "상세페이지 완료" :
                                      thumbTask?.detailStatus === "error" ? "생성 실패 (재시도)" :
                                      "상세페이지 생성"
                                    }
                                    className={`p-1.5 rounded transition-colors disabled:opacity-50 ${
                                      thumbTask?.detailStatus === "done"
                                        ? "text-amber-400"
                                        : thumbTask?.detailStatus === "error"
                                        ? "text-red-400"
                                        : "text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-400/10"
                                    }`}
                                  >
                                    {thumbTask?.detailStatus === "loading"
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <FileText className="w-3.5 h-3.5" />}
                                  </button>

                                  {/* 상세이미지 보기 */}
                                  {product.detail_image_url && (
                                    <a
                                      href={product.detail_image_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="상세이미지 보기"
                                      className="p-1.5 rounded text-amber-400 hover:bg-amber-400/10 transition-colors"
                                    >
                                      <ExternalLink className="w-3.5 h-3.5" />
                                    </a>
                                  )}

                                  {/* HTML 복사 */}
                                  {product.detail_html && (
                                    <HtmlCopyButton html={product.detail_html} />
                                  )}
                                </>
                              )}
                            </div>
                          </div>

                          {/* 이미지 행 */}
                          {hasImages || product.detail_image_url ? (
                            <div className="flex gap-1 flex-wrap mt-1.5 pl-5">
                              {/* 썸네일 (첫 번째) */}
                              {visibleImages.slice(0, 1).map((url) => (
                                <ImageCell
                                  key={url}
                                  url={url}
                                  isThumb={product.thumbnail_url === url}
                                  onDelete={() => handleDeleteImage(product, url)}
                                  onSetThumbOnly={() => handleSetThumbOnly(product, url)}
                                  onSetThumbAndKeepOnly={() => handleSetThumbAndKeepOnly(product, url)}
                                />
                              ))}
                              {/* 상세이미지: 썸네일 바로 옆 */}
                              {product.detail_image_url && (
                                <DetailImageCell
                                  url={product.detail_image_url}
                                  onClear={() => handleClearDetailImage(product)}
                                />
                              )}
                              {/* 나머지 이미지들 */}
                              {visibleImages.slice(1).map((url) => (
                                <ImageCell
                                  key={url}
                                  url={url}
                                  isThumb={product.thumbnail_url === url}
                                  onDelete={() => handleDeleteImage(product, url)}
                                  onSetThumbOnly={() => handleSetThumbOnly(product, url)}
                                  onSetThumbAndKeepOnly={() => handleSetThumbAndKeepOnly(product, url)}
                                />
                              ))}
                              {!isExpanded && hiddenCount > 0 && (
                                <button
                                  onClick={() => toggleExpandImages(product.id)}
                                  className="w-24 h-24 rounded-lg border-2 border-dashed border-[var(--border)] text-[var(--text-muted)] hover:border-blue-400 hover:text-blue-400 text-xs font-medium transition-colors flex items-center justify-center"
                                >
                                  +{hiddenCount}
                                </button>
                              )}
                              {isExpanded && hiddenCount > 0 && (
                                <button
                                  onClick={() => toggleExpandImages(product.id)}
                                  className="self-start mt-9 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors px-1"
                                >
                                  접기
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 text-xs text-[var(--text-disabled)] mt-1.5 pl-5">
                              <ImageOff className="w-3.5 h-3.5" />
                              이미지 없음
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
