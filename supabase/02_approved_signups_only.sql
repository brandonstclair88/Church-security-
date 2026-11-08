-- Run once in Supabase → SQL Editor. Blocks account creation for any email
-- that isn't on the approved list (Roster → App access).
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
