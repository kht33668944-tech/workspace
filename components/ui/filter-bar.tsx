"use client";

import { Search } from "lucide-react";

interface FilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  onSearchSubmit: () => void;
  onSearchClear?: () => void;
  placeholder?: string;
  /** 검색 우측 필터 요소들 (셀렉트/날짜 등) */
  children?: React.ReactNode;
}

/**
 * 반응형 필터 바.
 * - 모바일(<640px): 1행 검색 (full width) + 2행 자식들(flex-wrap)
 * - 데스크톱: 모두 한 줄에 가로 배치
 *
 * 돋보기 아이콘은 실제 <button type="submit">로 동작하며,
 * form onSubmit 으로 감싸 모바일 가상 키보드의 "이동/완료" 버튼 대응.
 */
export default function FilterBar({
  search,
  onSearchChange,
  onSearchSubmit,
  onSearchClear,
  placeholder = "검색어 입력",
  children,
}: FilterBarProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearchSubmit();
      }}
      className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3"
    >
      <div className="relative flex-1 min-w-0 sm:min-w-48 sm:max-w-sm">
        <button
          type="submit"
          aria-label="검색"
          className="absolute left-0 top-0 h-full w-10 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          <Search className="w-4 h-4" />
        </button>
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder}
          enterKeyHint="search"
          className="w-full pl-10 pr-9 py-2 min-h-[44px] sm:min-h-0 bg-[var(--bg-hover)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50"
        />
        {search && onSearchClear && (
          <button
            type="button"
            onClick={onSearchClear}
            aria-label="검색어 지우기"
            className="absolute right-0 top-0 h-full w-9 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <span className="text-xs">✕</span>
          </button>
        )}
      </div>
      {children && (
        <div className="flex items-center gap-2 flex-wrap">
          {children}
        </div>
      )}
    </form>
  );
}
