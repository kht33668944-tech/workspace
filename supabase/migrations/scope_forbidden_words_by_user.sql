-- Scope forbidden words to each authenticated user.
-- Existing shared words are copied to every current user so the feature keeps working.

alter table public.forbidden_words
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

create temporary table _forbidden_word_seed on commit drop as
select
  (array_agg(trim(word) order by created_at asc))[1] as word,
  min(created_at) as created_at
from public.forbidden_words
where trim(word) <> ''
group by lower(trim(word));

alter table public.forbidden_words drop constraint if exists forbidden_words_word_key;

with ranked as (
  select
    id,
    row_number() over (partition by lower(trim(word)) order by created_at asc, id asc) as rn
  from public.forbidden_words
)
delete from public.forbidden_words fw
using ranked
where fw.id = ranked.id
  and ranked.rn > 1;

with first_user as (
  select id
  from auth.users
  order by created_at asc
  limit 1
)
update public.forbidden_words fw
set user_id = first_user.id
from first_user
where fw.user_id is null;

insert into public.forbidden_words (user_id, word, created_at)
select users.id, seed.word, seed.created_at
from auth.users as users
cross join _forbidden_word_seed as seed
where not exists (
  select 1
  from public.forbidden_words fw
  where fw.user_id = users.id
    and lower(trim(fw.word)) = lower(seed.word)
);

alter table public.forbidden_words
  alter column user_id set not null;

drop index if exists public.forbidden_words_user_word_unique;
create unique index forbidden_words_user_word_unique
  on public.forbidden_words (user_id, lower(trim(word)));

drop policy if exists "forbidden_words_select" on public.forbidden_words;
create policy "forbidden_words_select" on public.forbidden_words
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "forbidden_words_insert" on public.forbidden_words;
create policy "forbidden_words_insert" on public.forbidden_words
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "forbidden_words_update" on public.forbidden_words;
create policy "forbidden_words_update" on public.forbidden_words
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "forbidden_words_delete" on public.forbidden_words;
create policy "forbidden_words_delete" on public.forbidden_words
  for delete to authenticated
  using (user_id = (select auth.uid()));
