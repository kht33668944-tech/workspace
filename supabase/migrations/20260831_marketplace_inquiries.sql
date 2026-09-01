-- 마켓 문의 통합 테이블 (쿠팡 상품문의/고객센터문의, 스마트스토어 상품Q&A/1:1문의)
-- 매시 크론이 동기화하고, 사이트 문의 탭에서 답변 전송. AI 자동답변 결과도 기록.

CREATE TABLE IF NOT EXISTS public.marketplace_inquiries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform         text NOT NULL CHECK (platform IN ('coupang', 'smartstore')),
  inquiry_type     text NOT NULL CHECK (inquiry_type IN ('coupang_product', 'coupang_cs', 'naver_qna', 'naver_inquiry')),
  inquiry_id       text NOT NULL,                          -- 마켓 문의 ID (쿠팡 inquiryId / 네이버 questionId·inquiryNo)
  content          text NOT NULL DEFAULT '',
  product_name     text,
  market_order_ids text[] NOT NULL DEFAULT '{}',           -- 문의에 딸린 마켓 주문번호 (매칭 근거)
  order_id         uuid REFERENCES public.orders(id) ON DELETE SET NULL,  -- 매칭된 발주서 행
  inquiry_at       timestamptz,
  status           text NOT NULL DEFAULT 'unanswered' CHECK (status IN ('unanswered', 'answered')),
  answer_content   text,
  answered_at      timestamptz,
  -- sync=마켓에서 이미 답변됨 / app=사이트에서 수동 전송 / auto=AI 자동 전송
  answer_source    text CHECK (answer_source IS NULL OR answer_source IN ('sync', 'app', 'auto')),
  ai_draft         text,
  ai_draft_at      timestamptz,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,     -- API 원본 (쿠팡 CS parentAnswerId 등 답변 조건 판정용)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, inquiry_type, inquiry_id)
);

CREATE INDEX IF NOT EXISTS idx_mi_user_status
  ON public.marketplace_inquiries (user_id, status);
CREATE INDEX IF NOT EXISTS idx_mi_user_inquiry_at
  ON public.marketplace_inquiries (user_id, inquiry_at DESC);
CREATE INDEX IF NOT EXISTS idx_mi_order
  ON public.marketplace_inquiries (order_id);

ALTER TABLE public.marketplace_inquiries ENABLE ROW LEVEL SECURITY;

CREATE POLICY mi_select ON public.marketplace_inquiries
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY mi_insert ON public.marketplace_inquiries
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY mi_update ON public.marketplace_inquiries
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY mi_delete ON public.marketplace_inquiries
  FOR DELETE TO authenticated USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS trg_marketplace_inquiries_updated_at ON public.marketplace_inquiries;
CREATE TRIGGER trg_marketplace_inquiries_updated_at
  BEFORE UPDATE ON public.marketplace_inquiries
  FOR EACH ROW EXECUTE FUNCTION public.touch_marketplace_api_credentials_updated_at();
