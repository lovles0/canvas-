-- 在 Supabase SQL Editor 中执行一次。
-- 同步码是随机 UUID，相当于这条状态记录的密码；函数只允许按完整同步码读写。

create table if not exists public.canvas_state (
  id uuid primary key,
  payload jsonb not null default '{"version":3,"done":{},"hidden":{}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.canvas_state enable row level security;
revoke all on table public.canvas_state from anon, authenticated;

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
  if p_payload is null or pg_column_size(p_payload) > 262144 then
    raise exception 'invalid payload';
  end if;
  insert into public.canvas_state(id, payload, updated_at)
  values (p_id, p_payload, now())
  on conflict (id) do update set payload = excluded.payload, updated_at = now();
end;
$$;

revoke all on function public.read_canvas_state(uuid) from public;
revoke all on function public.write_canvas_state(uuid, jsonb) from public;
grant execute on function public.read_canvas_state(uuid) to anon, authenticated;
grant execute on function public.write_canvas_state(uuid, jsonb) to anon, authenticated;
