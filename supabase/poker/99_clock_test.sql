-- ПОКЕР: ход — 1 минута, один за столом минуту — стол закрывается (04_clock_alone.sql). Самоотменяющийся тест:
-- запускать одним запросом вместе с миграцией; в конце тест падает — всё откатывается (и уведомления тоже не уходят).
-- Правила «время вышло — чек или пас, второй пропуск — встаёшь» проверяет ещё и 99_test.sql (проверка 9).
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
create function pg_temp.st(t bigint) returns text language sql as $$ select status from public.poker_tables where id = t $$;
-- вид стола от имени участника (как телефон: вид сам трогает часы стола)
create function pg_temp.view(t bigint, u uuid) returns jsonb language plpgsql as $$
begin perform pg_temp.login(u); return public.poker_view(t); end $$;

do $test$
declare
  u uuid[]; adm uuid; t bigint; n integer; res text := ''; g public.poker_tables%rowtype; v0 integer; cur uuid; i integer;
  c numeric[]; c0 numeric[]; me public.poker_seats%rowtype; v jsonb; at timestamptz;
begin
  select array_agg(p.id order by p.created_at) into u from (
    select x.id, x.created_at from public.profiles x where not public.poker_busy(x.id, null)
       and not exists (select 1 from public.admins a where a.user_id = x.id) order by x.created_at limit 3) p;
  select a.user_id into adm from public.admins a where not public.poker_busy(a.user_id, null) limit 1;
  if cardinality(u) < 3 or adm is null then raise exception 'для теста нужно 3 участника и админ'; end if;
  for i in 1..3 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 1000, 'game', 'test:poker-clock'); end loop;
  c := array(select public.coins_of(y) from unnest(u) y); c0 := c;

  -- ===== 1. На ход 60 секунд: прошло 59 — ничего; вышло — база ходит за игрока (пас, если должен доставить) =====
  n := 0;
  perform pg_temp.login(u[1]); t := public.poker_create(1, 2);
  perform pg_temp.login(u[2]); perform public.poker_sit(t, 2);
  perform pg_temp.login(u[3]); perform public.poker_sit(t, 2);
  perform public.poker_deal(t);
  select * into g from public.poker_tables where id = t;
  if g.deadline = now() + interval '60 seconds' then n := n + 1; end if;
  cur := pg_temp.turn(t);
  update public.poker_tables set deadline = now() + interval '1 second' where id = t;   -- прошло 59 секунд
  v0 := g.version;
  if not public.poker_due(t) then n := n + 1; end if;
  perform public.poker_tick(t);
  if pg_temp.turn(t) = cur and (select version from public.poker_tables where id = t) = v0 then n := n + 1; end if;
  update public.poker_tables set deadline = now() - interval '2 seconds' where id = t;  -- прошла минута с хвостиком
  if public.poker_due(t) then n := n + 1; end if;
  perform public.poker_tick(t);
  if (select folded and misses = 1 and last_act = 'fold' from public.poker_seats where table_id = t and user_id = cur and left_at is null)
     and pg_temp.turn(t) <> cur then n := n + 1; end if;
  -- следующий ходит сам — у него снова ровно минута
  if (select deadline from public.poker_tables where id = t) = now() + interval '60 seconds'
     and pg_temp.act(t, pg_temp.turn(t), pg_temp.need(t)) = 'ok' then n := n + 1; end if;
  v := pg_temp.view(t, u[1]);
  if (v ->> 'deadline_ms') is not null and (v ->> 'alone_ms') is null then n := n + 1; end if;
  res := res || case when n = 7 then E'ok   1 на ход ровно 60 с; через 59 с ничего; через минуту — пас за игрока; следующему — снова минута\n'
                     else E'FAIL 1 (' || n || E'/7)\n' end;
  for i in 1..3 loop perform pg_temp.login(u[i]); perform public.poker_leave(t); end loop;

  -- ===== 2. Бот ходит через 1,5 секунды (через 1 — рано); стол с ботами одиночество не закрывает =====
  n := 0;
  perform pg_temp.login(adm); t := public.poker_create(1, null, true);
  update public.poker_tables set created_at = now() - interval '5 minutes' where id = t;   -- админ один уже 5 минут
  if public.poker_alone_at(t) is null and not public.poker_due(t) then n := n + 1; end if;
  perform public.poker_tick(t);
  if pg_temp.st(t) = 'open' then n := n + 1; end if;
  perform public.poker_add_bot(t);
  perform public.poker_deal(t);
  for i in 1..12 loop
    exit when pg_temp.st(t) <> 'play';
    select * into g from public.poker_tables where id = t;
    select * into me from public.poker_seats where table_id = t and left_at is null and seat = g.turn_seat;
    if me.bot_name is null then perform pg_temp.act(t, adm, pg_temp.need(t)); continue; end if;
    update public.poker_tables set deadline = now() + interval '59 seconds' where id = t;   -- прошла 1 секунда — рано
    if not public.poker_due(t) then n := n + 1; end if;
    update public.poker_tables set deadline = now() + interval '58 seconds' where id = t;   -- прошло 2 секунды — бот ходит
    if public.poker_due(t) then n := n + 1; end if;
    perform public.poker_tick(t);
    if (select version from public.poker_tables where id = t) > g.version then n := n + 1; end if;
    exit;
  end loop;
  res := res || case when n = 5 then E'ok   2 бот ходит через 1,5 с (через 1 с — рано); админ один за столом с ботами 5 минут — стол открыт\n'
                     else E'FAIL 2 (' || n || E'/5)\n' end;
  perform pg_temp.login(adm); perform public.poker_leave(t);

  -- ===== 3. Открыл стол и сидит один: 59 секунд — открыт; минута — закрыт, фишки на баланс, телефону — почему =====
  c := array(select public.coins_of(y) from unnest(u) y);
  n := 0;
  perform pg_temp.login(u[1]); t := public.poker_create(1, 2);
  v := pg_temp.view(t, u[1]);
  if (v ->> 'alone_ms')::bigint = (extract(epoch from now() + interval '1 minute') * 1000)::bigint then n := n + 1; end if;
  if public.coins_of(u[1]) = c[1] - 2 then n := n + 1; end if;
  update public.poker_tables set created_at = now() - interval '59 seconds' where id = t;
  if not public.poker_due(t) then n := n + 1; end if;
  v := pg_temp.view(t, u[1]);
  if v ->> 'status' = 'open' and v -> 'my' is not null and v -> 'my' <> 'null'::jsonb then n := n + 1; end if;
  update public.poker_tables set created_at = now() - interval '61 seconds' where id = t;
  if public.poker_due(t) then n := n + 1; end if;
  v := pg_temp.view(t, u[1]);                                     -- телефон спросил стол — часы стола его закрыли
  if v ->> 'status' = 'closed' and (v -> 'gone' ->> 'kind') = 'closed' and (v -> 'log' -> -1 ->> 'kind') = 'alone' then n := n + 1; end if;
  if public.coins_of(u[1]) = c[1] and (select cashout from public.poker_seats where table_id = t and user_id = u[1]) = 2 then n := n + 1; end if;
  res := res || case when n = 7 then E'ok   3 один за новым столом: 59 с — открыт, минута — закрыт (в журнале «alone»), фишки вернулись\n'
                     else E'FAIL 3 (' || n || E'/7)\n' end;

  -- ===== 4. Сидели двое, один ушёл посреди раздачи: отсчёт — с его ухода; через минуту стол закрыт, монеты сошлись =====
  c := array(select public.coins_of(y) from unnest(u) y);
  n := 0;
  perform pg_temp.login(u[1]); t := public.poker_create(1, 2);
  perform pg_temp.login(u[2]); perform public.poker_sit(t, 1.5);
  update public.poker_tables set created_at = now() - interval '5 minutes' where id = t;
  if public.poker_alone_at(t) is null and (pg_temp.view(t, u[1]) ->> 'alone_ms') is null then n := n + 1; end if;
  perform public.poker_deal(t);
  if public.poker_alone_at(t) is null then n := n + 1; end if;      -- идёт раздача — отсчёта нет
  perform pg_temp.login(u[2]); perform public.poker_leave(t);        -- ушёл посреди раздачи: пас, банк — первому
  select * into g from public.poker_tables where id = t;
  at := (select left_at from public.poker_seats where table_id = t and user_id = u[2]);
  if g.status = 'open' and public.poker_alone_at(t) = at + interval '1 minute' then n := n + 1; end if;
  update public.poker_seats set left_at = now() - interval '30 seconds' where table_id = t and user_id = u[2];
  if not public.poker_due(t) and pg_temp.st(t) = 'open' then n := n + 1; end if;
  update public.poker_seats set left_at = now() - interval '61 seconds' where table_id = t and user_id = u[2];
  if public.poker_due(t) then n := n + 1; end if;
  perform public.poker_tick_all();                                   -- как расписание раз в минуту (приложение закрыто)
  if pg_temp.st(t) = 'closed' and not exists (select 1 from public.poker_seats where table_id = t and left_at is null) then n := n + 1; end if;
  if public.coins_of(u[1]) + public.coins_of(u[2]) = c[1] + c[2] and public.coins_of(u[1]) > c[1] then n := n + 1; end if;
  res := res || case when n = 7 then E'ok   4 двое → один ушёл посреди раздачи: 30 с — открыт, минута — закрыт по расписанию; монеты двоих сошлись\n'
                     else E'FAIL 4 (' || n || E'/7)\n' end;

  -- ===== 5. Пришёл второй до конца минуты — стол не закрывается; ушёл — новая минута с его ухода =====
  c := array(select public.coins_of(y) from unnest(u) y);
  n := 0;
  perform pg_temp.login(u[1]); t := public.poker_create(1, 2);
  update public.poker_tables set created_at = now() - interval '50 seconds' where id = t;
  perform pg_temp.login(u[3]); perform public.poker_sit(t, 2);
  update public.poker_tables set created_at = now() - interval '10 minutes' where id = t;
  if not public.poker_due(t) and public.poker_alone_at(t) is null and (pg_temp.view(t, u[3]) ->> 'alone_ms') is null then n := n + 1; end if;
  perform pg_temp.login(u[3]); perform public.poker_leave(t);
  if public.poker_alone_at(t) > now() and not public.poker_due(t) and pg_temp.st(t) = 'open' then n := n + 1; end if;
  -- кто не сидит за столом, тоже видит отсчёт (может успеть сесть)
  v := pg_temp.view(t, u[2]);
  if (v ->> 'alone_ms') is not null and (v -> 'my' is null or v -> 'my' = 'null'::jsonb) then n := n + 1; end if;
  perform pg_temp.login(u[1]); perform public.poker_leave(t);
  if pg_temp.st(t) = 'closed' then n := n + 1; end if;
  if public.coins_of(u[3]) = c[3] then n := n + 1; end if;
  res := res || case when n = 5 then E'ok   5 второй сел за 50 с — отсчёт пропал (и через 10 минут стол открыт); ушёл — новая минута; видно и не сидящим\n'
                     else E'FAIL 5 (' || n || E'/5)\n' end;

  -- ===== 6. Монеты: у всех троих вместе — как было (покер без комиссии) =====
  if (select sum(z) from unnest(array(select public.coins_of(y) from unnest(u) y)) z) = (select sum(z) from unnest(c0) z)
     and not exists (select 1 from public.poker_seats x join public.poker_tables tb on tb.id = x.table_id
                      where x.user_id = any(u) and x.left_at is null and tb.status <> 'closed') then
    res := res || E'ok   6 монеты троих вместе сошлись до копейки, никто не остался сидеть\n';
  else res := res || E'FAIL 6\n'; end if;

  raise exception E'\n%', res;
end $test$;
