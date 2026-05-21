-- 옥션·지마켓(ESM) 가격수정 v2: 인벤토리 테이블
-- 양식 = 사이트 상품번호 + 판매가. 한 상품(product_id)에 보통 옥션 1행 + 지마켓 1행.

CREATE TABLE IF NOT EXISTS public.esm_price_inventory (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id          uuid REFERENCES public.products(id) ON DELETE SET NULL,
  master_product_id   text,          -- 마스터상품번호 (옥션+지마켓 공통 키)
  site_product_id     text NOT NULL, -- 사이트 상품번호 (B열 — 양식에 들어가는 값)
  site                text,          -- '옥션' | '지마켓'
  product_name        text,
  seller_code         text,
  seller_id           text,
  sale_status         text,
  sale_price          integer,
  stock               integer,
  category            text,
  site_category       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_epi_user_site_product
  ON public.esm_price_inventory (user_id, site_product_id);
CREATE INDEX IF NOT EXISTS idx_epi_user    ON public.esm_price_inventory (user_id);
CREATE INDEX IF NOT EXISTS idx_epi_product ON public.esm_price_inventory (product_id);

ALTER TABLE public.esm_price_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY epi_select ON public.esm_price_inventory
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY epi_insert ON public.esm_price_inventory
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY epi_update ON public.esm_price_inventory
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY epi_delete ON public.esm_price_inventory
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_epi_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_epi_updated_at ON public.esm_price_inventory;
CREATE TRIGGER trg_epi_updated_at BEFORE UPDATE ON public.esm_price_inventory
  FOR EACH ROW EXECUTE FUNCTION public.touch_epi_updated_at();
