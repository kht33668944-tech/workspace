-- 공식 판매처 API 연동 키와 실행 로그.
-- 쿠팡을 먼저 사용하고, 같은 구조로 스마트스토어/ESM 확장 가능하게 둔다.

CREATE TABLE IF NOT EXISTS public.marketplace_api_credentials (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform              text NOT NULL CHECK (platform IN ('coupang', 'smartstore', 'esm')),
  label                 text,
  account_id            text NOT NULL,
  access_key_encrypted  text,
  secret_key_encrypted  text,
  client_id_encrypted   text,
  client_secret_encrypted text,
  meta                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at        timestamptz,
  last_test_status      text CHECK (last_test_status IS NULL OR last_test_status IN ('success', 'failed')),
  last_test_message     text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_api_credentials_user
  ON public.marketplace_api_credentials (user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_api_credentials_platform
  ON public.marketplace_api_credentials (user_id, platform);

ALTER TABLE public.marketplace_api_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY mac_select ON public.marketplace_api_credentials
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY mac_insert ON public.marketplace_api_credentials
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY mac_update ON public.marketplace_api_credentials
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY mac_delete ON public.marketplace_api_credentials
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.marketplace_api_logs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id         uuid REFERENCES public.marketplace_api_credentials(id) ON DELETE SET NULL,
  platform              text NOT NULL,
  action                text NOT NULL,
  status                text NOT NULL CHECK (status IN ('success', 'failed')),
  product_id            uuid REFERENCES public.products(id) ON DELETE SET NULL,
  product_name          text,
  vendor_item_id        text,
  previous_value        text,
  new_value             text,
  error_message         text,
  response_payload      jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_api_logs_user_created
  ON public.marketplace_api_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_api_logs_product
  ON public.marketplace_api_logs (product_id);

ALTER TABLE public.marketplace_api_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY mal_select ON public.marketplace_api_logs
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY mal_insert ON public.marketplace_api_logs
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_marketplace_api_credentials_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketplace_api_credentials_updated_at ON public.marketplace_api_credentials;
CREATE TRIGGER trg_marketplace_api_credentials_updated_at
  BEFORE UPDATE ON public.marketplace_api_credentials
  FOR EACH ROW EXECUTE FUNCTION public.touch_marketplace_api_credentials_updated_at();
