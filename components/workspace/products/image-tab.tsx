"use client";

import { useState, useCallback, useRef } from "react";
import { Search, X, Copy, Check, ImageOff, Upload, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import type { Product, ProductUpdate } from "@/types/database";

interface Props {
  products: Product[];
  onUpdate: (id: string, updates: ProductUpdate, skipUndo?: boolean) => void;
  onDelete: (ids: string[]) => Promise<{ error: string | null } | undefined>;
}

/** Supabase Storage 경로 추출 (publicUrl → path) */
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

interface ImageCellProps {
  url: string;
  isThumb: boolean;
  onDelete: () => void;
  onSetThumbAndKeepOnly: () => void;
  onSetThumbOnly: () => void;
}

function ImageCell({ url, isThumb, onDelete, onSetThumbAndKeepOnly, onSetThumbOnly }: ImageCellProps) {
  const [hovered, setHovered] = useState(false);
  const urlCopy = useCopy();
  const htmlCopy = useCopy();

  return (
    <div
      className={`relative w-20 h-20 rounded-lg overflow-hidden border-2 shrink-0 ${
        isThumb ? "border-blue-500" : "border-[var(--border)]"
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        src={url}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover cursor-pointer"
        onClick={() => window.open(url, "_blank")}
      />

      {/* 호버 오버레이 */}
      {hovered && (
        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-0.5 p-1">
          {/* 대표 설정 */}
          {!isThumb && (
            <button
              onClick={(e) => { e.stopPropagation(); onSetThumbOnly(); }}
              className="text-[9px] bg-blue-600 hover:bg-blue-700 text-white px-1 py-0.5 rounded w-full text-center leading-tight"
            >
              대표설정
            </button>
          )}
          {/* 이것만 남기기 */}
          <button
            onClick={(e) => { e.stopPropagation(); onSetThumbAndKeepOnly(); }}
            className="text-[9px] bg-emerald-600 hover:bg-emerald-700 text-white px-1 py-0.5 rounded w-full text-center leading-tight"
          >
            이것만남기기
          </button>
          {/* URL 복사 */}
          <button
            onClick={(e) => { e.stopPropagation(); urlCopy.copy(url); }}
            className="text-[9px] bg-[var(--bg-card)]/80 hover:bg-[var(--border)] text-[var(--text-primary)] px-1 py-0.5 rounded flex items-center gap-0.5 w-full justify-center leading-tight"
          >
            {urlCopy.state === "copied" ? <Check className="w-2 h-2" /> : <Copy className="w-2 h-2" />}
            URL복사
          </button>
          {/* HTML 복사 */}
          <button
            onClick={(e) => { e.stopPropagation(); htmlCopy.copy(`<img src='${url}' />`); }}
            className="text-[9px] bg-[var(--bg-card)]/80 hover:bg-[var(--border)] text-[var(--text-primary)] px-1 py-0.5 rounded flex items-center gap-0.5 w-full justify-center leading-tight"
          >
            {htmlCopy.state === "copied" ? <Check className="w-2 h-2" /> : <Copy className="w-2 h-2" />}
            HTML복사
          </button>
          {/* 삭제 */}
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="text-[9px] bg-red-600/80 hover:bg-red-600 text-white px-1 py-0.5 rounded w-full text-center leading-tight"
          >
            삭제
          </button>
        </div>
      )}

      {isThumb && (
        <div className="absolute top-1 left-1 bg-blue-500 rounded text-[9px] text-white px-1 leading-4 pointer-events-none">
          대표
        </div>
      )}
    </div>
  );
}

export default function ImageTab({ products, onUpdate, onDelete }: Props) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null); // productId
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null); // productId

  const filtered = products.filter((p) => {
    const hasImages = p.image_urls && p.image_urls.length > 0;
    if (!showEmpty && !hasImages) return false;
    if (search) return p.product_name.toLowerCase().includes(search.toLowerCase());
    return true;
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) =>
      prev.size === filtered.length
        ? new Set()
        : new Set(filtered.map((p) => p.id))
    );
  };

  /** 선택된 상품들 — 이미지 Storage 삭제 후 DB에서도 삭제 */
  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size}개 상품을 삭제하시겠습니까?\n(이미지 파일도 함께 삭제됩니다)`)) return;

    setDeleting(true);
    // Storage에서 이미지 일괄 삭제
    const allImagePaths: string[] = [];
    for (const id of selectedIds) {
      const p = products.find((x) => x.id === id);
      if (p?.image_urls?.length) {
        allImagePaths.push(...p.image_urls.map(urlToStoragePath));
      }
    }
    if (allImagePaths.length > 0) {
      await supabase.storage.from("product-images").remove(allImagePaths);
    }

    // DB에서 상품 삭제
    await onDelete([...selectedIds]);
    setSelectedIds(new Set());
    setDeleting(false);
  };

  /** 단일 이미지 삭제 */
  const handleDeleteImage = async (product: Product, imageUrl: string) => {
    const newUrls = product.image_urls.filter((u) => u !== imageUrl);
    const newThumb =
      product.thumbnail_url === imageUrl ? (newUrls[0] ?? null) : product.thumbnail_url;

    await supabase.storage.from("product-images").remove([urlToStoragePath(imageUrl)]);
    onUpdate(product.id, { image_urls: newUrls, thumbnail_url: newThumb }, true);
  };

  /** 대표만 설정 (나머지 유지) */
  const handleSetThumbOnly = (product: Product, imageUrl: string) => {
    onUpdate(product.id, { thumbnail_url: imageUrl }, true);
  };

  /** 이 이미지만 남기고 나머지 전부 삭제 */
  const handleSetThumbAndKeepOnly = async (product: Product, imageUrl: string) => {
    const toDelete = product.image_urls.filter((u) => u !== imageUrl);
    if (toDelete.length > 0) {
      await supabase.storage
        .from("product-images")
        .remove(toDelete.map(urlToStoragePath));
    }
    onUpdate(product.id, { image_urls: [imageUrl], thumbnail_url: imageUrl }, true);
  };

  /** 전체 이미지 삭제 */
  const handleDeleteAll = async (product: Product) => {
    if (!confirm(`"${product.product_name}" 의 이미지 ${product.image_urls.length}장을 모두 삭제하시겠습니까?`)) return;
    await supabase.storage
      .from("product-images")
      .remove(product.image_urls.map(urlToStoragePath));
    onUpdate(product.id, { image_urls: [], thumbnail_url: null }, true);
  };

  /** 수동 이미지 업로드 */
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

      if (error) { console.error("업로드 실패:", error); return; }

      const { data } = supabase.storage.from("product-images").getPublicUrl(path);
      const newUrl = data.publicUrl;

      const newUrls = [...(product.image_urls || []), newUrl];
      const newThumb = product.thumbnail_url ?? newUrl;
      onUpdate(productId, { image_urls: newUrls, thumbnail_url: newThumb }, true);
    } finally {
      setUploading(null);
    }
  };

  const withImages = products.filter((p) => p.image_urls && p.image_urls.length > 0).length;

  return (
    <div className="space-y-4">
      {/* 숨겨진 파일 입력 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* 툴바 */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* 전체선택 */}
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

        {/* 검색 */}
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
          <input
            type="checkbox"
            checked={showEmpty}
            onChange={(e) => setShowEmpty(e.target.checked)}
            className="rounded"
          />
          이미지 없는 상품 포함
        </label>

        {/* 선택 삭제 버튼 */}
        {selectedIds.size > 0 && (
          <button
            onClick={handleDeleteSelected}
            disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? "삭제 중..." : `${selectedIds.size}개 상품 삭제`}
          </button>
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
        <div className="space-y-2">
          {filtered.map((product) => {
            const hasImages = product.image_urls && product.image_urls.length > 0;
            const isUploading = uploading === product.id;
            return (
              <div
                key={product.id}
                className={`bg-[var(--bg-main)] border rounded-xl p-4 flex items-start gap-4 transition-colors ${
                  selectedIds.has(product.id)
                    ? "border-blue-500/50 bg-blue-500/5"
                    : "border-[var(--border)]"
                }`}
              >
                {/* 체크박스 */}
                <input
                  type="checkbox"
                  checked={selectedIds.has(product.id)}
                  onChange={() => toggleSelect(product.id)}
                  className="w-4 h-4 rounded cursor-pointer mt-0.5 shrink-0"
                />

                {/* 상품 정보 */}
                <div className="w-44 shrink-0">
                  <p className="text-sm text-[var(--text-primary)] font-medium leading-snug line-clamp-2">
                    {product.product_name || "(이름 없음)"}
                  </p>
                  {product.source_platform && (
                    <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">
                      {product.source_platform}
                    </span>
                  )}
                  {product.lowest_price > 0 && (
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                      {product.lowest_price.toLocaleString()}원
                    </p>
                  )}
                  {/* 액션 버튼 */}
                  <div className="flex flex-col gap-1 mt-2">
                    <button
                      onClick={() => handleUploadClick(product.id)}
                      disabled={isUploading}
                      className="flex items-center gap-1 text-[10px] px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] hover:border-blue-400 text-[var(--text-muted)] hover:text-blue-400 rounded transition-colors disabled:opacity-50"
                    >
                      <Upload className="w-3 h-3" />
                      {isUploading ? "업로드 중..." : "이미지 추가"}
                    </button>
                    {hasImages && (
                      <button
                        onClick={() => handleDeleteAll(product)}
                        className="flex items-center gap-1 text-[10px] px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] hover:border-red-400 text-[var(--text-muted)] hover:text-red-400 rounded transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        전체 삭제
                      </button>
                    )}
                  </div>
                </div>

                {/* 이미지 목록 */}
                <div className="flex-1 min-w-0">
                  {hasImages ? (
                    <div className="flex gap-2 flex-wrap">
                      {product.image_urls.map((url, idx) => (
                        <ImageCell
                          key={idx}
                          url={url}
                          isThumb={product.thumbnail_url === url}
                          onDelete={() => handleDeleteImage(product, url)}
                          onSetThumbOnly={() => handleSetThumbOnly(product, url)}
                          onSetThumbAndKeepOnly={() => handleSetThumbAndKeepOnly(product, url)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-[var(--text-disabled)] py-6">
                      <ImageOff className="w-4 h-4" />
                      이미지 없음 — 왼쪽 "이미지 추가"로 업로드하세요
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
