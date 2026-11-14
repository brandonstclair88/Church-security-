-- Run once in Supabase → SQL Editor. Lets people request a specific post from the
-- group chat availability link. Safe to run again.

-- Read: now also returns the post list (code and name only) and each person's requests.
create or replace function public.avail_get(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  l public.avail_links;
  w jsonb; ms jsonb; av jsonb; ps jsonb;
begin
  select * into l from public.avail_links where token = p_token and expires_at > now();
  if not found then return null; end if;
  select data into w from public.docs where path = 'weeks/' || l.week;

  select coalesce(jsonb_agg(jsonb_build_object('id', doc_id, 'name', data->>'name') order by lower(data->>'name')), '[]'::jsonb)
    into ms from public.docs
   where coll = 'members' and coalesce((data->>'active')::boolean, true);

  select coalesce(jsonb_agg(jsonb_build_object('id', doc_id, 'code', data->>'code', 'name', coalesce(data->>'name', ''),
                                               'services', coalesce(data->'services', '[]'::jsonb))
                            order by coalesce((data->>'order')::numeric, 99)), '[]'::jsonb)
    into ps from public.docs where coll = 'posts';

  select coalesce(jsonb_object_agg(k, jsonb_build_object(
           'AM', coalesce((v->>'AM')::boolean, false),
           'PM', coalesce((v->>'PM')::boolean, false),
           'reqAM', v->>'reqAM', 'reqPM', v->>'reqPM',
           'answered', v ? 'answeredAt')), '{}'::jsonb)
    into av from jsonb_each(coalesce(w->'avail', '{}'::jsonb)) as e(k, v);

  return jsonb_build_object('week', l.week, 'members', ms, 'posts', ps, 'avail', av);
end $$;

-- Write availability: unchanged, except a request is cleared for a service they can't make.
create or replace function public.avail_set(p_token text, p_member text, p_am boolean, p_pm boolean) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  l public.avail_links; p text; cur jsonb; me jsonb;
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
  me := coalesce(cur->'avail'->p_member, '{}'::jsonb)
        || jsonb_build_object('AM', coalesce(p_am, false), 'PM', coalesce(p_pm, false),
                              'answeredAt', floor(extract(epoch from now()) * 1000));
  if not coalesce(p_am, false) then me := me - 'reqAM'; end if;
  if not coalesce(p_pm, false) then me := me - 'reqPM'; end if;
  cur := jsonb_set(cur, array['avail', p_member], me, true);
  update public.docs set data = cur, updated_at = now(), updated_by = 'availability link' where path = p;
  return true;
end $$;

-- Write a request: one post per service, or null to clear it.
create or replace function public.avail_request(p_token text, p_member text, p_svc text, p_post text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  l public.avail_links; p text; cur jsonb; me jsonb; k text;
begin
  if p_svc not in ('AM', 'PM') then return false; end if;
  select * into l from public.avail_links where token = p_token and expires_at > now();
  if not found then return false; end if;
  p := 'weeks/' || l.week;
  select data into cur from public.docs where path = p for update;
  if cur is null then return false; end if;
  me := cur->'avail'->p_member;
  if me is null or not coalesce((me->>p_svc)::boolean, false) then return false; end if; -- must be available first
  k := 'req' || p_svc;
  if p_post is null or p_post = '' then
    me := me - k;
  else
    if not exists (select 1 from public.docs where path = 'posts/' || p_post and coalesce(data->'services', '[]'::jsonb) ? p_svc) then
      return false;
    end if;
    me := me || jsonb_build_object(k, p_post);
  end if;
  cur := jsonb_set(cur, array['avail', p_member], me, true);
  update public.docs set data = cur, updated_at = now(), updated_by = 'availability link' where path = p;
  return true;
end $$;

revoke all on function public.avail_request(text, text, text, text) from public;
grant execute on function public.avail_request(text, text, text, text) to anon, authenticated;
grant execute on function public.avail_get(text) to anon, authenticated;
grant execute on function public.avail_set(text, text, boolean, boolean) to anon, authenticated;
