-- Church security scheduler: run once in Supabase → SQL Editor → New query → Run.
-- Safe to run again.

-- 1. Who may sign in. The first admin is added at the bottom.
create table if not exists public.allowed_emails (
  email text primary key check (email = lower(email)),
  role text not null default 'editor' check (role in ('admin', 'editor')),
  added_at timestamptz not null default now()
);

-- 2. All app data (roster, posts, schedules, map) as small JSON documents.
create table if not exists public.docs (
  path text primary key,
  coll text not null,
  doc_id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists docs_coll_idx on public.docs (coll);

-- 3. Helpers used by the access rules.
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.allowed_emails where email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;
create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$ select public.my_role() is not null; $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select public.my_role() = 'admin'; $$;
grant execute on function public.my_role() to authenticated;

-- 4. Access rules: only approved emails can read or change anything.
alter table public.docs enable row level security;
alter table public.allowed_emails enable row level security;

drop policy if exists "approved read docs" on public.docs;
drop policy if exists "approved write docs" on public.docs;
create policy "approved read docs" on public.docs for select to authenticated using (public.is_allowed());
create policy "approved write docs" on public.docs for all to authenticated using (public.is_allowed()) with check (public.is_allowed());

drop policy if exists "approved see access list" on public.allowed_emails;
drop policy if exists "admins manage access" on public.allowed_emails;
create policy "approved see access list" on public.allowed_emails for select to authenticated using (public.is_allowed());
create policy "admins manage access" on public.allowed_emails for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 5. Live updates between phones.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 6. First admin (you).
insert into public.allowed_emails (email, role) values ('brandonst.clair88@gmail.com', 'admin')
on conflict (email) do update set role = 'admin';

-- 7. Only approved emails can create an account.
create or replace function public.only_approved_signups() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowed_emails where email = lower(new.email)) then
    raise exception 'Email not approved for this app';
  end if;
  return new;
end $$;

drop trigger if exists only_approved_signups on auth.users;
create trigger only_approved_signups before insert on auth.users
for each row execute function public.only_approved_signups();

-- 8. Weekly group chat availability link: see 03_availability_links.sql (run it too).
