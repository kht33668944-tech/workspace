-- Gemini API 호출 사용량 추적
create table if not exists public.gemini_usage (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  call_source text not null default 'unknown',
  model text not null,
  prompt_tokens int not null default 0,
  candidate_tokens int not null default 0,
  total_tokens int generated always as (prompt_tokens + candidate_tokens) stored,
  is_image boolean not null default false,
  image_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists gemini_usage_user_created_idx
  on public.gemini_usage (user_id, created_at desc);

create index if not exists gemini_usage_user_source_created_idx
  on public.gemini_usage (user_id, call_source, created_at desc);

alter table public.gemini_usage enable row level security;

-- 본인 행만 SELECT
drop policy if exists "gemini_usage_select" on public.gemini_usage;
create policy "gemini_usage_select" on public.gemini_usage
  for select to authenticated using (auth.uid() = user_id);

-- INSERT는 service_role만 (서버 코드에서 기록)
-- service_role은 RLS를 자동 우회하므로 별도 정책 불필요
