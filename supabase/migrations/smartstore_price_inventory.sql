-- 스마트스토어 가격수정 v2: 인벤토리 테이블
-- 다운로드한 엑셀 양식 자체가 업로드 양식이라 raw_row 94컬럼을 JSONB로 통째 보존.
-- F열(판매가)만 우리 시스템 가격으로 교체해서 재출력한다.

CREATE TABLE IF NOT EXISTS public.smartstore_price_inventory (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id              uuid REFERENCES public.products(id) ON DELETE SET NULL,
  smartstore_product_id   text NOT NULL,
  seller_product_code     text,
  category_code           text,
  product_name            text,
  product_status          text,
  sale_price              integer,
  option_type             text,
  raw_row                 jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_spi_user_product
  ON public.smartstore_price_inventory (user_id, smartstore_product_id);
CREATE INDEX IF NOT EXISTS idx_spi_user    ON public.smartstore_price_inventory (user_id);
CREATE INDEX IF NOT EXISTS idx_spi_product ON public.smartstore_price_inventory (product_id);

ALTER TABLE public.smartstore_price_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY spi_select ON public.smartstore_price_inventory
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY spi_insert ON public.smartstore_price_inventory
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY spi_update ON public.smartstore_price_inventory
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY spi_delete ON public.smartstore_price_inventory
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_spi_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_spi_updated_at ON public.smartstore_price_inventory;
CREATE TRIGGER trg_spi_updated_at BEFORE UPDATE ON public.smartstore_price_inventory
  FOR EACH ROW EXECUTE FUNCTION public.touch_spi_updated_at();
