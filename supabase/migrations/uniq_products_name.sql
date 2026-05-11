-- 사용자별 상품명 중복 방지
-- 가격수정 엑셀에 같은 sellerCode가 여러 행으로 출력되는 문제를 근본 차단
-- 빈 product_name은 새 상품 추가 직후 임시 상태이므로 제외 (partial index)

CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_user_product_name
  ON products (user_id, product_name)
  WHERE product_name IS NOT NULL AND product_name <> '';
