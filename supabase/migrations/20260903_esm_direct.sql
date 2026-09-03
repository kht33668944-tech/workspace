-- 플레이오토 폐기: ESM 직접 연동 (2026-09-03 운영 적용 완료)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketplace_account text; -- 지마켓/옥션 판매자 계정 (현재 미사용, 향후 계정별 분리용)
ALTER TABLE excel_archives DROP CONSTRAINT IF EXISTS excel_archives_file_type_check;
ALTER TABLE excel_archives ADD CONSTRAINT excel_archives_file_type_check
  CHECK (file_type IN ('order_export', 'playauto_tracking', 'playauto_product', 'price_update', 'esm_tracking'));
