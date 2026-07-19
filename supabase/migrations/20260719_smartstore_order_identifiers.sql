-- 스마트스토어 주문·정산을 이름이 아닌 상품주문번호로 연결하기 위한 식별자
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS marketplace_order_no text,
  ADD COLUMN IF NOT EXISTS marketplace_product_order_no text,
  ADD COLUMN IF NOT EXISTS marketplace_orderer_name text;

CREATE INDEX IF NOT EXISTS idx_orders_user_marketplace_order_no
  ON public.orders (user_id, marketplace, marketplace_order_no)
  WHERE marketplace_order_no IS NOT NULL AND btrim(marketplace_order_no) <> '';

CREATE INDEX IF NOT EXISTS idx_orders_user_marketplace_product_order_no
  ON public.orders (user_id, marketplace, marketplace_product_order_no)
  WHERE marketplace_product_order_no IS NOT NULL AND btrim(marketplace_product_order_no) <> '';
