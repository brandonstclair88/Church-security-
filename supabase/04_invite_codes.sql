-- Run once in Supabase → SQL Editor. One-time invite codes: an admin creates a
-- code in the app; the first person to use it is approved with that role.
-- Each code works once and expires after 7 days.

create table if not exists public.invite_codes (
  code text primary key check (code ~ '^[A-Z0-9]{8,}$'),
  role text not null default 'editor' check (role in ('admin', 'editor')),
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by text,
  used_at timestamptz
);
alter table public.invite_codes enable row level security;
drop policy if exists "admins manage invites" on public.invite_codes;
create policy "admins manage invites" on public.invite_codes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.redeem_invite(p_code text, p_email text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  e text := lower(trim(coalesce(p_email, '')));
  inv public.invite_codes;
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return false; end if;
  select * into inv from public.invite_codes
   where code = c and used_at is null and expires_at > now()
   for update;
  if not found then return false; end if;
  insert into public.allowed_emails (email, role) values (e, inv.role)
  on conflict (email) do nothing;
  update public.invite_codes set used_by = e, used_at = now() where code = c;
  return true;
end $$;

revoke all on function public.redeem_invite(text, text) from public;
grant execute on function public.redeem_invite(text, text) to anon, authenticated;
