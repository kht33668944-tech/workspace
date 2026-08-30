-- 상품 필수정보·이미지 전면 재정비 작업 전 백업 (2026-08-22)
-- products 전체(1,173행)를 그대로 복사해 보관한다. 원본은 변경하지 않는다.
-- 복구가 필요하면 이 테이블에서 해당 행을 다시 복사한다.

create table if not exists public.products_backup_20260822 as
select * from public.products;

-- 백업 테이블은 조회 전용이다. RLS를 켜고 정책을 만들지 않아
-- service_role 외에는 접근할 수 없게 잠근다.
alter table public.products_backup_20260822 enable row level security;
