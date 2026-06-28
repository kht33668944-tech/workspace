-- Dashboard profit/date tracking.
-- These timestamps store the first business event date independently from updated_at.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS purchased_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz;

-- Best-effort backfill for existing data. Existing rows do not have historical event
-- timestamps, so order_date is the safest month/day anchor for dashboard grouping.
UPDATE public.orders
SET purchased_at = COALESCE(order_date, created_at)
WHERE purchased_at IS NULL
  AND purchase_order_no IS NOT NULL
  AND btrim(purchase_order_no) <> '';

UPDATE public.orders
SET delivered_at = COALESCE(order_date, created_at)
WHERE delivered_at IS NULL
  AND tracking_no IS NOT NULL
  AND btrim(tracking_no) <> '';

UPDATE public.orders
SET returned_at = COALESCE(order_date, created_at)
WHERE returned_at IS NULL
  AND delivery_status = '반품완료';

CREATE INDEX IF NOT EXISTS idx_orders_user_purchased_at
  ON public.orders (user_id, purchased_at)
  WHERE purchased_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_user_delivered_at
  ON public.orders (user_id, delivered_at)
  WHERE delivered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_user_returned_at
  ON public.orders (user_id, returned_at)
  WHERE returned_at IS NOT NULL;
