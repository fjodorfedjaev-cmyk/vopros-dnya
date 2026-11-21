-- УВЕДОМЛЕНИЯ: карточные игры молчат (01_no_card_games.sql). Самоотменяющийся тест: запускать одним запросом вместе
-- с миграцией; в конце тест падает — всё откатывается (запросы в очереди отправки тоже, никто ничего не получит).
-- Смотрит очередь pg_net (net.http_request_queue): что база попросила отправить функции push.
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
-- сколько уведомлений этого вида встало в очередь после отметки q0
create function pg_temp.sent(q0 bigint, k text) returns bigint language sql as $$
  select count(*) from net.http_request_queue r where r.id > q0 and convert_from(r.body, 'utf8')::jsonb ->> 'type' = k $$;

do $test$
declare u uuid[]; q0 bigint; n integer; res text := ''; r bigint; t bigint; i integer;
begin
  select array_agg(p.id order by p.created_at) into u from (
    select x.id, x.created_at from public.profiles x
     where not public.poker_busy(x.id, null)
       and not exists (select 1 from public.durak_players d join public.durak_rooms g on g.id = d.room_id
                        where d.user_id = x.id and d.place is null and g.status in ('open', 'ready', 'choose', 'play'))
     order by x.created_at limit 3) p;
  if cardinality(u) < 3 then raise exception 'для теста нужно 3 свободных участника'; end if;
  for i in 1..3 loop
    insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 1000, 'game', 'test:push-cards');
    -- у каждого подписка на уведомления (раньше в этих местах база звала push)
    -- (ненастоящая, но по правилам формата рабочей базы: https-адрес, ключи нужной длины; откатится вместе с тестом)
    insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
    values ('https://test.invalid/push-cards/' || u[i], u[i], repeat('k', 60), repeat('a', 16));
  end loop;
  select coalesce(max(id), 0) into q0 from net.http_request_queue;

  -- ===== 1. Дурак: новая комната и «жми Готов» — ничего не уходит =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.durak_create(10);
  if pg_temp.sent(q0, 'durak') = 0 then n := n + 1; end if;
  perform pg_temp.login(u[2]); perform public.durak_join(r);
  perform pg_temp.login(u[3]); perform public.durak_join(r);
  perform pg_temp.login(u[1]); perform public.durak_start(r);       -- двое не готовы — раньше им уходило «жми Готов»
  if (select status from public.durak_rooms where id = r) = 'ready' and pg_temp.sent(q0, 'durak') = 0 then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   1 Дурак: новая комната и «Дурак начинается, жми Готов» — в очереди отправки пусто\n'
                     else E'FAIL 1 (' || n || E'/2)\n' end;

  -- ===== 2. Покер: новый стол — ничего не уходит =====
  perform pg_temp.login(u[2]); t := public.poker_create(1, 2);
  res := res || case when t is not null and pg_temp.sent(q0, 'poker') = 0 then E'ok   2 Покер: новый стол — в очереди отправки пусто\n'
                     else E'FAIL 2\n' end;

  -- ===== 3. Прямой вызов с видом durak / poker — тоже ничего; другие виды уходят как раньше =====
  perform public.push_call(jsonb_build_object('type', 'durak', 'room_id', r, 'event', 'room'));
  perform public.push_call(jsonb_build_object('type', 'poker', 'table_id', t, 'event', 'table'));
  perform public.push_call(jsonb_build_object('type', 'test-push-cards'));
  res := res || case when pg_temp.sent(q0, 'durak') + pg_temp.sent(q0, 'poker') = 0 and pg_temp.sent(q0, 'test-push-cards') = 1
                     then E'ok   3 push_call: durak и poker отсекаются, остальные уведомления встают в очередь как раньше\n'
                     else E'FAIL 3 (durak ' || pg_temp.sent(q0, 'durak') || ', poker ' || pg_temp.sent(q0, 'poker')
                          || ', другое ' || pg_temp.sent(q0, 'test-push-cards') || E')\n' end;

  raise exception E'\n%', res;
end $test$;
