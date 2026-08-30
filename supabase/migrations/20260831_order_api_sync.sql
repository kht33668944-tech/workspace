-- 마켓 API 주문 수집·동기화용 (컬럼 추가 + 실행 이력 테이블). 기존 컬럼 변경 없음.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source text,                       -- 'excel' | 'api'
  ADD COLUMN IF NOT EXISTS marketplace_status text,           -- 마켓 원본 상태 (ACCEPT/INSTRUCT/PAYED ...)
  ADD COLUMN IF NOT EXISTS claim_type text,                   -- CANCEL | RETURN | EXCHANGE
  ADD COLUMN IF NOT EXISTS claim_status text,                 -- 마켓 클레임 상태 원문
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,          -- 발주확인(상품준비중) 처리 시각
  ADD COLUMN IF NOT EXISTS ship_by_date date,                 -- 발송기한
  ADD COLUMN IF NOT EXISTS marketplace_synced_at timestamptz, -- 마지막 동기화 시각
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_orders_user_claim_status
  ON orders (user_id, delivery_status)
  WHERE delivery_status = '취소요청';

CREATE TABLE IF NOT EXISTS marketplace_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  trigger text NOT NULL DEFAULT 'manual',      -- manual | scheduler
  dry_run boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',      -- running | success | partial | failed
  remote_count integer NOT NULL DEFAULT 0,
  new_orders integer NOT NULL DEFAULT 0,
  confirmed integer NOT NULL DEFAULT 0,
  confirm_failed integer NOT NULL DEFAULT 0,
  claims jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  detail jsonb
);

CREATE INDEX IF NOT EXISTS idx_msr_user_started ON marketplace_sync_runs (user_id, started_at DESC);

ALTER TABLE marketplace_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS msr_select ON marketplace_sync_runs;
DROP POLICY IF EXISTS msr_insert ON marketplace_sync_runs;
DROP POLICY IF EXISTS msr_update ON marketplace_sync_runs;
CREATE POLICY msr_select ON marketplace_sync_runs FOR SELECT USING (user_id = auth.uid());
CREATE POLICY msr_insert ON marketplace_sync_runs FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY msr_update ON marketplace_sync_runs FOR UPDATE USING (user_id = auth.uid());
