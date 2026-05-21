-- 쿠팡 가격수정 v2 — 셀러센터에서 다운로드한 "엑셀 일괄변경" 양식 캐시 테이블
-- 사용자가 양식을 임포트하면 옵션ID 기준 upsert되고, 가격수정 v2 내보내기 시 P열에 우리 시스템 쿠팡 판매가를 채워서 재생성한다.
-- product_id는 G열(쿠팡 노출 상품명)과 products.product_name 정확 일치로 연결되며, 미매칭 시 NULL.

CREATE TABLE IF NOT EXISTS public.coupang_price_inventory (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id              uuid REFERENCES public.products(id) ON DELETE SET NULL,
  vendor_item_id          text,
  coupang_product_id      text,
  option_id               text NOT NULL,
  product_status          text,
  barcode                 text,
  vendor_item_code        text,
  coupang_display_name    text,
  registered_name         text,
  option_name             text,
  sale_price              integer,
  discount_base_price     integer,
  sale_status             text,
  stock                   integer,
  sales_count             integer,
  approval_status         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cpi_user_option
  ON public.coupang_price_inventory (user_id, option_id);
CREATE INDEX IF NOT EXISTS idx_cpi_user
  ON public.coupang_price_inventory (user_id);
CREATE INDEX IF NOT EXISTS idx_cpi_product
  ON public.coupang_price_inventory (product_id);

ALTER TABLE public.coupang_price_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY cpi_select ON public.coupang_price_inventory
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY cpi_insert ON public.coupang_price_inventory
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY cpi_update ON public.coupang_price_inventory
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY cpi_delete ON public.coupang_price_inventory
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_cpi_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cpi_updated_at ON public.coupang_price_inventory;
CREATE TRIGGER trg_cpi_updated_at
  BEFORE UPDATE ON public.coupang_price_inventory
  FOR EACH ROW EXECUTE FUNCTION public.touch_cpi_updated_at();
