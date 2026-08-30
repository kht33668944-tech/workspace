-- 2단계: 필수정보·진행상태·신규이미지 컬럼 추가 (2026-08-22, 적용 완료)
-- 기존 컬럼은 건드리지 않고 새 컬럼만 추가한다.

alter table public.products
  add column if not exists item_info jsonb,
  add column if not exists rebuild_status text not null default '대기',
  add column if not exists new_thumbnail_url text,
  add column if not exists new_image_urls jsonb,
  add column if not exists new_detail_image_url text;

alter table public.products
  add constraint products_rebuild_status_check
  check (rebuild_status in ('대기', '조사완료', '이미지완료', '재등록완료'));

create index if not exists idx_products_rebuild_status
  on public.products (rebuild_status);
