-- 상세페이지 생성 시 제외할 금지어 (전체 공통)
create table if not exists public.forbidden_words (
  id uuid primary key default gen_random_uuid(),
  word text not null unique,
  created_at timestamptz not null default now()
);

alter table public.forbidden_words enable row level security;

-- 로그인 사용자는 조회/추가/삭제 모두 가능 (전체 공통 관리)
drop policy if exists "forbidden_words_select" on public.forbidden_words;
create policy "forbidden_words_select" on public.forbidden_words
  for select to authenticated using (true);

drop policy if exists "forbidden_words_insert" on public.forbidden_words;
create policy "forbidden_words_insert" on public.forbidden_words
  for insert to authenticated with check (true);

drop policy if exists "forbidden_words_delete" on public.forbidden_words;
create policy "forbidden_words_delete" on public.forbidden_words
  for delete to authenticated using (true);

-- 초기값
insert into public.forbidden_words (word) values ('알레르기'), ('화상')
on conflict (word) do nothing;
