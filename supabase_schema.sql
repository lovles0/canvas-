-- 在 Supabase SQL Editor 中执行一次。
-- 同步码是随机 UUID，相当于这条状态记录的密码；函数只允许按完整同步码读写。

create table if not exists public.canvas_state (
  id uuid primary key,
  payload jsonb not null default '{"version":3,"done":{},"hidden":{}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.canvas_state enable row level security;
revoke all on table public.canvas_state from anon, authenticated;

create or replace function public.canvas_event_updated_at(p_event jsonb)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  raw_value text;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return 0;
  end if;
  raw_value := p_event ->> 'updatedAt';
  if raw_value is null or raw_value !~ '^[0-9]+([.][0-9]+)?$' then
    return 0;
  end if;
  return raw_value::numeric;
exception when others then
  return 0;
end;
$$;

create or replace function public.merge_canvas_group(p_current jsonb, p_incoming jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  result jsonb := case when jsonb_typeof(p_current) = 'object' then p_current else '{}'::jsonb end;
  incoming_group jsonb := case when jsonb_typeof(p_incoming) = 'object' then p_incoming else '{}'::jsonb end;
  item record;
  current_event jsonb;
begin
  for item in select key, value from jsonb_each(incoming_group)
  loop
    current_event := result -> item.key;
    if current_event is null
       or public.canvas_event_updated_at(item.value) > public.canvas_event_updated_at(current_event) then
      result := jsonb_set(result, array[item.key], item.value, true);
    end if;
  end loop;
  return result;
end;
$$;

create or replace function public.merge_canvas_payload(p_current jsonb, p_incoming jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  current_payload jsonb := case when jsonb_typeof(p_current) = 'object' then p_current else '{}'::jsonb end;
  incoming_payload jsonb := case when jsonb_typeof(p_incoming) = 'object' then p_incoming else '{}'::jsonb end;
  result jsonb;
begin
  result := current_payload || incoming_payload;
  result := jsonb_set(result, '{version}', '3'::jsonb, true);
  result := jsonb_set(result, '{done}', public.merge_canvas_group(current_payload -> 'done', incoming_payload -> 'done'), true);
  result := jsonb_set(result, '{hidden}', public.merge_canvas_group(current_payload -> 'hidden', incoming_payload -> 'hidden'), true);
  return result;
end;
$$;

create or replace function public.merge_canvas_state(p_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_payload jsonb;
  merged_payload jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 262144 then
    raise exception 'invalid payload';
  end if;

  insert into public.canvas_state(id)
  values (p_id)
  on conflict (id) do nothing;

  select payload into current_payload
  from public.canvas_state
  where id = p_id
  for update;

  merged_payload := public.merge_canvas_payload(current_payload, p_payload);
  update public.canvas_state
  set payload = merged_payload, updated_at = now()
  where id = p_id;

  return merged_payload;
end;
$$;

create or replace function public.read_canvas_state(p_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select payload from public.canvas_state where id = p_id;
$$;

create or replace function public.write_canvas_state(p_id uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.merge_canvas_state(p_id, p_payload);
end;
$$;

revoke all on function public.canvas_event_updated_at(jsonb) from public;
revoke all on function public.merge_canvas_group(jsonb, jsonb) from public;
revoke all on function public.merge_canvas_payload(jsonb, jsonb) from public;
revoke all on function public.merge_canvas_state(uuid, jsonb) from public;
revoke all on function public.read_canvas_state(uuid) from public;
revoke all on function public.write_canvas_state(uuid, jsonb) from public;
grant execute on function public.merge_canvas_state(uuid, jsonb) to anon, authenticated;
grant execute on function public.read_canvas_state(uuid) to anon, authenticated;
grant execute on function public.write_canvas_state(uuid, jsonb) to anon, authenticated;
