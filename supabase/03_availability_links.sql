-- Run once in Supabase → SQL Editor. Adds the weekly group chat availability link.
-- Anyone with a valid link can see member names and set availability for that
-- Sunday only. Links expire the day after their Sunday. Armed status is never exposed.

create table if not exists public.avail_links (
  token text primary key check (length(token) >= 16),
  week text not null check (week ~ '^\d{4}-\d{2}-\d{2}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by text
);
create index if not exists avail_links_week_idx on public.avail_links (week);
alter table public.avail_links enable row level security;
drop policy if exists "approved manage links" on public.avail_links;
create policy "approved manage links" on public.avail_links for all to authenticated
  using (public.is_allowed()) with check (public.is_allowed());

-- Read: week date, active member names, and who has answered.
create or replace function public.avail_get(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  l public.avail_links;
  w jsonb;
  ms jsonb;
  av jsonb;
begin
  select * into l from public.avail_links where token = p_token and expires_at > now();
  if not found then return null; end if;

  select data into w from public.docs where path = 'weeks/' || l.week;

  select coalesce(jsonb_agg(jsonb_build_object('id', doc_id, 'name', data->>'name') order by lower(data->>'name')), '[]'::jsonb)
    into ms
    from public.docs
   where coll = 'members' and coalesce((data->>'active')::boolean, true);

  select coalesce(jsonb_object_agg(k, jsonb_build_object(
           'AM', coalesce((v->>'AM')::boolean, false),
           'PM', coalesce((v->>'PM')::boolean, false),
           'answered', v ? 'answeredAt')), '{}'::jsonb)
    into av
    from jsonb_each(coalesce(w->'avail', '{}'::jsonb)) as e(k, v);

  return jsonb_build_object('week', l.week, 'members', ms, 'avail', av);
end $$;

-- Write: set one member's AM/PM for the link's Sunday.
create or replace function public.avail_set(p_token text, p_member text, p_am boolean, p_pm boolean) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  l public.avail_links;
  p text;
  cur jsonb;
begin
  select * into l from public.avail_links where token = p_token and expires_at > now();
  if not found then return false; end if;
  if not exists (select 1 from public.docs where path = 'members/' || p_member and coalesce((data->>'active')::boolean, true)) then
    return false;
  end if;

  p := 'weeks/' || l.week;
  insert into public.docs (path, coll, doc_id, data, updated_at, updated_by)
  values (p, 'weeks', l.week,
          jsonb_build_object('date', l.week, 'avail', '{}'::jsonb,
                             'sched', jsonb_build_object('AM', '{}'::jsonb, 'PM', '{}'::jsonb),
                             'locks', jsonb_build_object('AM', '{}'::jsonb, 'PM', '{}'::jsonb)),
          now(), 'availability link')
  on conflict (path) do nothing;

  select data into cur from public.docs where path = p for update;
  if cur->'avail' is null or jsonb_typeof(cur->'avail') <> 'object' then
    cur := jsonb_set(cur, '{avail}', '{}'::jsonb, true);
  end if;
  cur := jsonb_set(cur, array['avail', p_member],
           coalesce(cur->'avail'->p_member, '{}'::jsonb)
             || jsonb_build_object('AM', coalesce(p_am, false), 'PM', coalesce(p_pm, false),
                                   'answeredAt', floor(extract(epoch from now()) * 1000)),
           true);
  update public.docs set data = cur, updated_at = now(), updated_by = 'availability link' where path = p;
  return true;
end $$;

revoke all on function public.avail_get(text) from public;
revoke all on function public.avail_set(text, text, boolean, boolean) from public;
grant execute on function public.avail_get(text) to anon, authenticated;
grant execute on function public.avail_set(text, text, boolean, boolean) to anon, authenticated;
