-- Our Recipe Box, update 2: separate shopping lists per household.
-- Recipes and prices stay shared by everyone on the member list;
-- each household (yours, your sister's) gets its own weekly list.
-- Run once in Supabase → SQL Editor → New query → Run.

-- 1) Members now belong to a household. Everyone already listed goes in 'home'.
alter table public.household_members add column if not exists household text not null default 'home';

-- 2) ADD YOUR SISTER: change the email, keep 'sister' (any name works; it just groups people).
insert into public.household_members (email, household) values
  ('sister@example.com', 'sister')
on conflict (email) do update set household = excluded.household;

-- 3) Which household is the signed-in person in?
create or replace function public.my_household() returns text
language sql stable security definer set search_path = public as $$
  select m.household from public.household_members m
  where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', '')) limit 1;
$$;
grant execute on function public.my_household() to authenticated;

-- 4) One shopping list per household; carry over your current list.
create table if not exists public.lists (
  household  text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.lists (household, data)
  select 'home', data from public.shopping_list where id = 1
on conflict (household) do nothing;

alter table public.lists enable row level security;
grant select, insert, update, delete on public.lists to authenticated;
drop policy if exists "own household list" on public.lists;
create policy "own household list" on public.lists for all to authenticated
  using (household = public.my_household()) with check (household = public.my_household());

do $$
begin
  begin alter publication supabase_realtime add table public.lists; exception when duplicate_object then null; end;
end $$;
