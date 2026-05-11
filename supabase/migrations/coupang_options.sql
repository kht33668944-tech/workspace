-- 쿠팡 가격수정 양식에 사용되는 옵션조합/옵션 캐시 컬럼
-- 상품명으로부터 한 번 추출되면 변하지 않으므로 DB에 저장하여 Gemini 재호출 회피
-- 구조: { hasOption: boolean, optionName: string, optionValue: string } 또는 NULL

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS coupang_options JSONB;

COMMENT ON COLUMN products.coupang_options IS
  'Cached coupang option metadata for price-update export: { hasOption, optionName, optionValue }. NULL = not yet extracted.';
