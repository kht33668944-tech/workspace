-- 스마트스토어 커머스API 직접 연동용 컬럼 추가 (컬럼 추가만, 기존 컬럼 변경 없음)

-- 네이버 상품 수정 API는 원상품번호(originProductNo) 기준이라 채널상품번호와 별도로 보관한다.
ALTER TABLE smartstore_price_inventory
  ADD COLUMN IF NOT EXISTS origin_product_no text,
  ADD COLUMN IF NOT EXISTS channel_product_no text,
  ADD COLUMN IF NOT EXISTS stock integer,
  ADD COLUMN IF NOT EXISTS api_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_spi_user_origin_product_no
  ON smartstore_price_inventory (user_id, origin_product_no)
  WHERE origin_product_no IS NOT NULL;

-- 로그의 대상 식별자를 플랫폼 중립으로 (쿠팡 vendorItemId / 네이버 originProductNo·productOrderId / 주문 취소 orderId)
ALTER TABLE marketplace_api_logs
  ADD COLUMN IF NOT EXISTS target_id text;

-- 취소 API 매칭 결과를 발주서에 되돌려 저장할 때 사용하는 인덱스는 20260719 마이그레이션에 이미 존재
