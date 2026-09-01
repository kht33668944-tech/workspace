-- 마켓 API 2단계: 송장 전송 · 반품/교환 · 정산 · 자동승인 설정
-- (Supabase SQL 에디터에서 수동 적용)

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipped_to_marketplace_at timestamptz,   -- 마켓 발송처리(송장 전송) 성공 시각
  ADD COLUMN IF NOT EXISTS ship_error text,                         -- 마지막 송장 전송 실패 사유
  ADD COLUMN IF NOT EXISTS tracking_exported_at timestamptz,        -- ESM 운송장 엑셀에 담은 시각
  ADD COLUMN IF NOT EXISTS settlement_actual numeric,               -- 마켓 정산 API 실정산액
  ADD COLUMN IF NOT EXISTS settlement_source text,                  -- estimate | api | excel
  ADD COLUMN IF NOT EXISTS settlement_confirmed_at timestamptz,     -- 정산(예정)일
  ADD COLUMN IF NOT EXISTS claim_receipt_id text;                   -- 쿠팡 receiptId/exchangeId, 스토어 claim 식별

CREATE INDEX IF NOT EXISTS idx_orders_ship_pending
  ON orders (user_id, marketplace)
  WHERE tracking_no IS NOT NULL AND shipped_to_marketplace_at IS NULL;

ALTER TABLE marketplace_sync_runs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'orders';     -- orders | shipping | settlement

-- 사용자 설정 (자동 승인 on/off 등)
CREATE TABLE IF NOT EXISTS app_settings (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_settings_all ON app_settings;
CREATE POLICY app_settings_all ON app_settings FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
