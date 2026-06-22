-- 쿠팡 필수 구매옵션 생성 로직 개편(필수옵션 전체 채움 + 사이즈/길이 등 서술형 추가)에 따른
-- 기존 캐시 무효화. 이전 캐시는 "수량+개당단위" 2개만 담긴 옛 형식이라 사이즈 등 필수옵션이 누락됨.
-- NULL로 비우면 다음 가격수정 내보내기 때 새 로직으로 재추출되어 다시 채워진다.
-- 구조: { hasOption, optionName, optionValue, missingRequired } 또는 NULL

UPDATE products
SET coupang_options = NULL
WHERE coupang_options IS NOT NULL;

COMMENT ON COLUMN products.coupang_options IS
  'Cached coupang option metadata for price-update export: { hasOption, optionName, optionValue, missingRequired }. NULL = not yet extracted.';
