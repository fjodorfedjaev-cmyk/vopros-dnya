-- ПОКЕР: время на ход не ограничено (03_no_clock.sql) — самоотменяющийся тест. Запускать одним запросом вместе с миграцией;
-- в конце тест падает — всё откатывается (и уведомления тоже не уходят).
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.act(t bigint, u uuid, k text, x numeric default null) returns text language plpgsql as $$
begin perform pg_temp.login(u); perform public.poker_act(t, k, x); return 'ok'; exception when others then return sqlerrm; end $$;
create function pg_temp.turn(t bigint) returns uuid language sql as $$
  select x.user_id from public.poker_seats x join public.poker_tables g on g.id = x.table_id
   where x.table_id = t and x.left_at is null and x.seat = g.turn_seat and g.status = 'play' $$;
create function pg_temp.need(t bigint) returns text language sql as $$
  select case when g.cur_bet > x.bet then 'call' else 'check' end from public.poker_tables g
    join public.poker_seats x on x.table_id = g.id and x.seat = g.turn_seat and x.left_at is null where g.id = t $$;

do $test$
declare
  u uuid[]; adm uuid; t bigint; n integer; res text := ''; g public.poker_tables%rowtype; v0 integer; cur uuid; i integer;
  c numeric[]; left_u uuid; me public.poker_seats%rowtype;
begin
  select array_agg(p.id order by p.created_at) into u from (
    select x.id, x.created_at from public.profiles x where not public.poker_busy(x.id, null) order by x.created_at limit 3) p;
  select a.user_id into adm from public.admins a where not public.poker_busy(a.user_id, null) limit 1;
  if cardinality(u) < 3 or adm is null then raise exception 'для теста нужно 3 участника и админ'; end if;
  for i in 1..3 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 1000, 'game', 'test:poker-clock'); end loop;
  c := array(select public.coins_of(y) from unnest(u) y);

  -- ===== 1. Человек думает час — ничего не происходит; потом ходит как обычно =====
  n := 0;
  perform pg_temp.login(u[1]); t := public.poker_create(1, 2);
  perform pg_temp.login(u[2]); perform public.poker_sit(t, 2);
  perform pg_temp.login(u[3]); perform public.poker_sit(t, 2);
  perform public.poker_deal(t);
  cur := pg_temp.turn(t);
  update public.poker_tables set deadline = now() - interval '1 hour' where id = t;
  select * into g from public.poker_tables where id = t; v0 := g.version;
  if not public.poker_due(t) then n := n + 1; end if;
  perform public.poker_tick(t);
  if pg_temp.turn(t) = cur and (select version from public.poker_tables where id = t) = v0
     and (select not folded and misses = 0 and last_act is distinct from 'fold' from public.poker_seats where table_id = t and user_id = cur and left_at is null) then n := n + 1; end if;
  if pg_temp.act(t, cur, pg_temp.need(t)) = 'ok' and pg_temp.turn(t) <> cur then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   1 человек думает час: не пас, не встал, ход тот же; потом ходит как обычно\n'
                     else E'FAIL 1 (' || n || E'/3)\n' end;

  -- ===== 2. Сутки никто не ходил: раздача отменяется, поставленное возвращается, стол закрыт, монеты как были =====
  n := 0;
  -- до хода ещё один уходит посреди раздачи (его ставка в банке должна вернуться ему)
  perform pg_temp.act(t, pg_temp.turn(t), pg_temp.need(t));
  left_u := (select x.user_id from public.poker_seats x where x.table_id = t and x.left_at is null and x.put > 0 and x.user_id <> pg_temp.turn(t) limit 1);
  perform pg_temp.login(left_u); perform public.poker_leave(t);
  if (select status from public.poker_tables where id = t) = 'play' then n := n + 1; end if;
  update public.poker_tables set deadline = now() - interval '23 hours' where id = t;
  if not public.poker_due(t) then n := n + 1; end if;
  update public.poker_tables set deadline = now() - interval '24 hours 1 minute' where id = t;
  if public.poker_due(t) then n := n + 1; end if;
  if public.poker_due(t) then perform public.poker_tick(t); end if;   -- как часы стола (poker_tick_all), но только этот стол
  if (select status from public.poker_tables where id = t) = 'closed'
     and not exists (select 1 from public.poker_seats where table_id = t and left_at is null) then n := n + 1; end if;
  if (select sum(cashout) = sum(buyin) from public.poker_seats where table_id = t) then n := n + 1; end if;
  if array(select public.coins_of(y) from unnest(u) y) = c then n := n + 1; end if;
  res := res || case when n = 6 then E'ok   2 сутки без хода (23 ч — ещё ждём): раздача отменена, поставленное вернулось и ушедшему, стол закрыт, монеты всех как были\n'
                     else E'FAIL 2 (' || n || E'/6)\n' end;

  -- ===== 3. Боты ходят через 1,5 секунды, как раньше; ход админа ждёт сколько угодно =====
  n := 0;
  perform pg_temp.login(adm); t := public.poker_create(1, null, true);
  perform public.poker_add_bot(t); perform public.poker_add_bot(t);
  perform public.poker_deal(t);
  for i in 1..12 loop
    exit when (select status from public.poker_tables where id = t) <> 'play';
    select * into g from public.poker_tables where id = t;
    select * into me from public.poker_seats where table_id = t and left_at is null and seat = g.turn_seat;
    if me.bot_name is null then perform pg_temp.act(t, adm, pg_temp.need(t)); continue; end if;
    update public.poker_tables set deadline = now() + interval '29 seconds' where id = t;   -- прошла 1 секунда — рано
    if not public.poker_due(t) then n := n + 1; end if;
    update public.poker_tables set deadline = now() + interval '28 seconds' where id = t;   -- прошло 2 секунды — бот ходит
    if public.poker_due(t) then n := n + 1; end if;
    perform public.poker_tick(t);
    if (select version from public.poker_tables where id = t) > g.version then n := n + 1; end if;
    exit;
  end loop;
  -- дойти до хода админа (боты ходят) и проверить, что его час ничего не меняет
  for i in 1..20 loop
    exit when (select status from public.poker_tables where id = t) <> 'play' or pg_temp.turn(t) = adm;
    update public.poker_tables set deadline = now() + interval '28 seconds' where id = t;
    perform public.poker_tick(t);
  end loop;
  if pg_temp.turn(t) = adm then
    update public.poker_tables set deadline = now() - interval '2 hours' where id = t;
    select * into g from public.poker_tables where id = t;
    perform public.poker_tick(t);
    if pg_temp.turn(t) = adm and (select version from public.poker_tables where id = t) = g.version then n := n + 1; end if;
  else n := n + 1;   -- раздача кончилась раньше (все боты спасовали) — проверять нечего
  end if;
  res := res || case when n = 4 then E'ok   3 бот ходит через 1,5 с (через 1 с — рано); ход админа два часа ничего не меняет\n'
                     else E'FAIL 3 (' || n || E'/4)\n' end;
  perform pg_temp.login(adm); perform public.poker_leave(t);

  raise exception E'\n%', res;
end $test$;
