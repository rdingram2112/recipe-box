-- Our Recipe Box, update 3: named pantries (each household's recipe collection).
-- Run update 2 first if you haven't. Then run this once in Supabase → SQL Editor → New query → Run.

create table if not exists public.households (
  household text primary key,
  label     text not null
);
-- Start every household with a plain name; rename yours in the app (tap "Rename" next to it).
insert into public.households (household, label)
  select distinct household, initcap(household) from public.household_members
on conflict (household) do nothing;

alter table public.households enable row level security;
grant select, insert, update on public.households to authenticated;
drop policy if exists "members read names" on public.households;
drop policy if exists "rename own household" on public.households;
drop policy if exists "name own household" on public.households;
create policy "members read names" on public.households for select to authenticated using (public.is_household());
create policy "name own household" on public.households for insert to authenticated with check (household = public.my_household());
create policy "rename own household" on public.households for update to authenticated
  using (household = public.my_household()) with check (household = public.my_household());

do $$
begin
  begin alter publication supabase_realtime add table public.households; exception when duplicate_object then null; end;
end $$;
