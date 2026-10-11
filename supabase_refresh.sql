-- 仅云端 Edge Function 可调用；刷新码校验在函数中先完成。
create schema if not exists private;
create table if not exists private.canvas_refresh_limit (
  singleton boolean primary key default true check (singleton),
  next_allowed_at timestamptz not null default '-infinity',
  request_id uuid
);
alter table private.canvas_refresh_limit enable row level security;
revoke all on private.canvas_refresh_limit from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update on private.canvas_refresh_limit to service_role;

create or replace function public.claim_canvas_refresh(p_request_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_time timestamptz;
  request_time timestamptz;
begin
  if p_request_id is null then raise exception 'request id required'; end if;
  insert into private.canvas_refresh_limit(singleton) values (true) on conflict do nothing;
  select next_allowed_at into next_time from private.canvas_refresh_limit where singleton = true for update;
  request_time := clock_timestamp();
  if next_time > request_time then
    return jsonb_build_object('allowed', false, 'retry_after', ceil(extract(epoch from next_time - request_time))::integer);
  end if;
  update private.canvas_refresh_limit set next_allowed_at = request_time + interval '120 seconds', request_id = p_request_id where singleton = true;
  return jsonb_build_object('allowed', true);
end;
$$;
revoke all on function public.claim_canvas_refresh(uuid) from public, anon, authenticated;
grant execute on function public.claim_canvas_refresh(uuid) to service_role;

-- Dashboard 自动开启 RLS 时创建的事件触发函数无需作为 RPC 对外开放。
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'rls_auto_enable'
               and p.pronargs = 0 and p.prorettype = 'event_trigger'::regtype) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;
