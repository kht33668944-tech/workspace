-- 플랫폼별 고정 판매가 (null = 자동계산 사용, 값 = 고정값 우선)
alter table public.products
  add column if not exists fixed_price_smartstore integer,
  add column if not exists fixed_price_esm integer,
  add column if not exists fixed_price_coupang integer;

-- 양수만 허용 (0/음수 방지)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fixed_price_smartstore_positive') then
    alter table public.products add constraint fixed_price_smartstore_positive
      check (fixed_price_smartstore is null or fixed_price_smartstore > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fixed_price_esm_positive') then
    alter table public.products add constraint fixed_price_esm_positive
      check (fixed_price_esm is null or fixed_price_esm > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fixed_price_coupang_positive') then
    alter table public.products add constraint fixed_price_coupang_positive
      check (fixed_price_coupang is null or fixed_price_coupang > 0);
  end if;
end $$;
