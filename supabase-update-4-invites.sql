-- Pantry Prep, update 4: invite links.
-- Anyone who signs up through your invite link can join without you adding their email.
-- Run updates 2 and 3 first if you haven't. Then run this once in Supabase → SQL Editor → New query → Run.

-- 1) The current invite code. Only the database functions below can read it.
create table if not exists public.app_settings (key text primary key, value text not null);
alter table public.app_settings enable row level security;          -- no policies: not readable from the app
insert into public.app_settings (key, value)
  values ('invite_code', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
on conflict (key) do nothing;

-- 2) Your household ('home') can see the invite code…
create or replace function public.get_invite_code() returns text
language sql stable security definer set search_path = public as $$
  select case when public.my_household() = 'home'
    then (select value from public.app_settings where key = 'invite_code') end;
$$;

-- …and replace it with a new one (the old link stops working; people already in keep access).
create or replace function public.reset_invite_code() returns text
language plpgsql security definer set search_path = public as $$
declare v text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
begin
  if public.my_household() is distinct from 'home' then raise exception 'not_allowed'; end if;
  update public.app_settings set value = v where key = 'invite_code';
  return v;
end $$;

-- 3) With a valid code, a newcomer can see the households they could join…
create or replace function public.households_for_invite(p_code text)
returns table (household text, label text)
language sql stable security definer set search_path = public as $$
  select h.household, h.label from public.households h
  where exists (select 1 from public.app_settings s where s.key = 'invite_code' and s.value = p_code)
  order by h.label;
$$;

-- …and join: either an existing household, or a new one with a name they choose.
create or replace function public.join_with_invite(p_code text, p_household text, p_label text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_house text;
begin
  if v_email = '' then raise exception 'not_signed_in'; end if;
  if not exists (select 1 from public.app_settings where key = 'invite_code' and value = p_code) then
    raise exception 'bad_code';
  end if;
  select household into v_house from public.household_members where lower(email) = v_email;
  if v_house is not null then return v_house; end if;                 -- already in

  if coalesce(p_household, '') <> '' then
    if not exists (select 1 from public.households where household = p_household) then raise exception 'no_household'; end if;
    v_house := p_household;
  else
    v_house := 'h_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    insert into public.households (household, label)
      values (v_house, left(coalesce(nullif(trim(p_label), ''), 'My pantry'), 40));
  end if;
  insert into public.household_members (email, household) values (v_email, v_house);
  return v_house;
end $$;

revoke all on function public.get_invite_code(), public.reset_invite_code(),
  public.households_for_invite(text), public.join_with_invite(text, text, text) from public, anon;
grant execute on function public.get_invite_code(), public.reset_invite_code(),
  public.households_for_invite(text), public.join_with_invite(text, text, text) to authenticated;
