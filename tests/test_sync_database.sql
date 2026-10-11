-- 在 SQL Editor / MCP 执行；所有测试修改由最后的 rollback 撤销。
begin;
do $$
begin
  if to_regprocedure('public.merge_canvas_state(uuid,jsonb)') is null then
    raise exception 'state sync RPC is not configured';
  end if;
  if has_table_privilege('anon', 'public.canvas_state', 'select')
     or has_table_privilege('authenticated', 'public.canvas_state', 'update') then
    raise exception 'clients must not have direct table access';
  end if;
end;
$$;
set local role anon;
do $$
declare
  key_one uuid := 'febfce16-2697-4e55-b394-935539ab6420';
  key_two uuid := 'f0d36221-a6c0-4c69-8a15-c015b6b09d4c';
  result jsonb;
begin
  result := public.merge_canvas_state(key_one, '{"version":3,"done":{"a":{"value":true,"updatedAt":100}},"hidden":{}}');
  result := public.merge_canvas_state(key_one, '{"version":3,"done":{"b":{"value":true,"updatedAt":200}},"hidden":{"ignored":{"value":true,"updatedAt":300}}}');
  if result #>> '{done,a,value}' <> 'true' or result #>> '{done,b,value}' <> 'true'
     or result #>> '{hidden,ignored,value}' <> 'true' then
    raise exception 'different task changes were lost';
  end if;
  result := public.merge_canvas_state(key_one, '{"done":{"a":{"value":false,"updatedAt":400}}}');
  result := public.merge_canvas_state(key_one, '{"done":{"a":{"value":true,"updatedAt":100}}}');
  if result #>> '{done,a,value}' <> 'false' then raise exception 'older state overwrote newer state'; end if;
  result := public.merge_canvas_state(key_one, '{"done":{"a":{"value":true,"updatedAt":"invalid"},"legacy":true}}');
  if result #>> '{done,a,value}' <> 'false' or result #>> '{done,legacy}' <> 'true' then
    raise exception 'legacy timestamps are not compatible';
  end if;
  if public.read_canvas_state(key_one) is distinct from result then raise exception 'read RPC did not return merged state'; end if;
  if public.read_canvas_state(key_two) is not null then raise exception 'sync spaces are not isolated'; end if;
  perform public.write_canvas_state(key_one, '{"done":{"c":{"value":true,"updatedAt":500}}}');
  if public.read_canvas_state(key_one) #>> '{done,a,value}' <> 'false'
     or public.read_canvas_state(key_one) #>> '{done,c,value}' <> 'true' then
    raise exception 'legacy write RPC did not merge atomically';
  end if;
  begin
    perform public.read_canvas_state(null);
    raise exception 'missing sync key was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.merge_canvas_state(key_one, '[]');
    raise exception 'invalid payload was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    execute 'select payload from public.canvas_state';
    raise exception 'anonymous table enumeration was allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;
