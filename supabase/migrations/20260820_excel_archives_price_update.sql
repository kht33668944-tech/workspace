-- 보관함(excel_archives)에 가격수정 엑셀(price_update) 유형 추가
-- 원가 갱신 → 가격수정 v2 엑셀 다운로드 시 보관함에 자동 저장하기 위함
ALTER TABLE excel_archives DROP CONSTRAINT excel_archives_file_type_check;
ALTER TABLE excel_archives ADD CONSTRAINT excel_archives_file_type_check
  CHECK (file_type IN ('order_export', 'playauto_tracking', 'playauto_product', 'price_update'));
