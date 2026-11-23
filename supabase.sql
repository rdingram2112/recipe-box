-- Our Recipe Box: run this once in Supabase → SQL Editor → New query → Run.
-- Everything is shared by the people listed in household_members (you and your wife).
-- Anyone else who signs up sees nothing and can change nothing.

-- 1) Who is in the household. CHANGE THESE TWO EMAILS, then run.
create table if not exists public.household_members (email text primary key);
insert into public.household_members (email) values
  ('you@example.com'),
  ('wife@example.com')
on conflict do nothing;
alter table public.household_members enable row level security;   -- no policies: not readable from the app

create or replace function public.is_household() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.household_members m
                 where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
grant execute on function public.is_household() to authenticated;

-- 2) Recipes: one row each, the recipe itself is JSON.
create table if not exists public.recipes (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) Price book: your corrections to the built-in H-E-B estimates, keyed by item.
create table if not exists public.prices (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- 4) This week's shopping list: a single shared row (id = 1).
create table if not exists public.shopping_list (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.shopping_list (id, data) values (1, '{}'::jsonb) on conflict do nothing;

-- Access: household members only, for every table.
do $$
declare t text;
begin
  foreach t in array array['recipes', 'prices', 'shopping_list'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists "household only" on public.%I', t);
    execute format('create policy "household only" on public.%I for all to authenticated using (public.is_household()) with check (public.is_household())', t);
  end loop;
end $$;

-- Live updates, so a check-off on one phone shows up on the other.
do $$
begin
  begin alter publication supabase_realtime add table public.recipes;       exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.prices;        exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.shopping_list; exception when duplicate_object then null; end;
end $$;
