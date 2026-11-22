-- «ВЕРЮ — НЕ ВЕРЮ»: колода «от … до …» — самоотменяющийся тест. Запускать одним запросом вместе с миграцией 02_range.sql
-- (на базе, где уже есть 01_bluff.sql). В конце тест падает — всё откатывается.
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;
create function pg_temp.uid_at(r bigint, s integer) returns uuid language sql as $$
  select user_id from public.bluff_players where room_id = r and seat = s $$;
create function pg_temp.st(r bigint) returns public.bluff_rooms language sql as $$ select * from public.bluff_rooms where id = r $$;
-- карт всего (руки + стопка + бита) = колода, повторов нет, и все карты — из отрезка колоды (или джокеры нужного числа)
create function pg_temp.cards_ok(r bigint) returns boolean language sql as $$
  with g as (select * from public.bluff_rooms where id = r),
       c as (select unnest(hand) x from public.bluff_players where room_id = r union all select unnest(pile) from public.bluff_rooms where id = r)
  select (select count(*) from c) + (select bita from g) = (select public.bluff_deck_n(low_rank, high_rank, jokers) from g)
     and (select count(*) from c) = (select count(distinct x) from c)
     and not exists (select 1 from c, g where (c.x < 52 and c.x / 4 + 2 not between g.low_rank and g.high_rank) or c.x >= 52 + g.jokers) $$;
-- случайный ход: в начале круга — случайный номинал отрезка
create function pg_temp.rnd_move(r bigint, u uuid) returns void language plpgsql as $$
declare g public.bluff_rooms%rowtype; me public.bluff_players%rowtype; k integer; roll double precision := random();
begin
  select * into g from public.bluff_rooms where id = r;
  select * into me from public.bluff_players where room_id = r and user_id = u;
  k := 1 + floor(random() * least(3, cardinality(me.hand)))::integer;
  if cardinality(me.hand) = 0 then                -- без карт (последние уже положены, круг ещё идёт): только «верю» / «не верю»
    perform public.bluff_move(r, u, case when roll < 0.5 then 'doubt' else 'trust' end, null, null, false);
  elsif g.claim_rank is null then
    perform public.bluff_move(r, u, 'put', array(select c from unnest(me.hand) c order by random() limit k),
                              g.low_rank + floor(random() * (g.high_rank - g.low_rank + 1))::integer, false);
  elsif roll < 0.4 then
    perform public.bluff_move(r, u, 'put', array(select c from unnest(me.hand) c order by random() limit k), null, false);
  elsif roll < 0.7 then
    perform public.bluff_move(r, u, 'doubt', null, null, false);
  else
    perform public.bluff_move(r, u, 'trust', null, null, false);
  end if;
end $$;

do $test$
declare
  u uuid[]; adm uuid; res text := ''; n integer; i integer; k integer; step integer; r bigint; r2 bigint; g public.bluff_rooms%rowtype;
  c0 numeric[]; v jsonb; bad integer := 0; games integer; finished integer := 0; steps_max integer := 0; note text := '';
  p public.bluff_players%rowtype; nb integer; lo integer; hi integer; jk integer; bot_games integer := 0; bot_fin integer := 0;
begin
  select array_agg(x.id order by x.created_at) into u from (
    select x.id, x.created_at from public.profiles x
     where not exists (select 1 from public.admins a where a.user_id = x.id)
       and not exists (select 1 from public.bluff_players b join public.bluff_rooms rr on rr.id = b.room_id
                        where b.user_id = x.id and b.place is null and rr.status in ('open', 'ready', 'play'))
     order by x.created_at limit 4) x;
  select a.user_id into adm from public.admins a limit 1;
  if cardinality(u) < 4 or adm is null then raise exception 'для теста нужно 4 участника и админ'; end if;
  for i in 1..4 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 100000, 'game', 'test:bluff'); end loop;
  c0 := array(select public.coins_of(y) from unnest(u) y);

  -- ===== 1. Старый вызов (без p_high) — колода до туза; новый — «от 5 до 10» =====
  n := 0;
  perform pg_temp.login(u[1]);
  r := public.bluff_create(10, 6, 2);
  v := public.bluff_view(r);
  if (v ->> 'high')::int = 14 and (v ->> 'deck_n')::int = 38 and (pg_temp.st(r)).high_rank = 14 then n := n + 1; end if;
  perform public.bluff_leave(r);
  r := public.bluff_create(10, 5, 1, false, 10);
  v := public.bluff_view(r);
  if (v ->> 'low')::int = 5 and (v ->> 'high')::int = 10 and (v ->> 'deck_n')::int = 25 and (v ->> 'max_seats')::int = 6 then n := n + 1; end if;
  if exists (select 1 from jsonb_array_elements(public.bluff_list()) e where (e ->> 'id')::bigint = r and (e ->> 'high')::int = 10 and (e ->> 'low')::int = 5) then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   1 без p_high — до туза (как раньше); «от 5 до 10» + джокер = 25 карт, в виде и в списке есть high\n'
                     else E'FAIL 1 (' || n || E'/3)\n' end;

  -- ===== 2. Неправильная колода; одна карта-номинал =====
  n := 0;
  perform pg_temp.login(u[4]);
  if pg_temp.try('select public.bluff_create(0, 10, 0, false, 5)') like '%bluff_bad_deck%' then n := n + 1; end if;   -- от 10 до 5
  if pg_temp.try('select public.bluff_create(0, 5, 0, false, 15)') like '%bluff_bad_deck%' then n := n + 1; end if;   -- до 15
  if pg_temp.try('select public.bluff_create(0, 1, 0, false, 5)') like '%bluff_bad_deck%' then n := n + 1; end if;    -- от 1
  k := public.bluff_create(0, 7, 0, false, 7);                                                                       -- только семёрки
  if public.bluff_max_seats(k) = 4 and (public.bluff_view(k) ->> 'deck_n')::int = 4 then n := n + 1; end if;
  perform public.bluff_leave(k);
  res := res || case when n = 4 then E'ok   2 «от 10 до 5», «до 15», «от 1» — нельзя; «только семёрки» — 4 карты, 4 места\n'
                     else E'FAIL 2 (' || n || E'/4)\n' end;

  -- ===== 3. Раздача и номинал внутри отрезка; «Ещё раз» с той же колодой =====
  n := 0;
  perform pg_temp.login(u[2]); perform public.bluff_join(r);
  perform pg_temp.login(u[3]); perform public.bluff_join(r);
  perform pg_temp.login(u[1]); perform public.bluff_start(r);
  perform pg_temp.login(u[2]); perform public.bluff_ready(r);
  perform pg_temp.login(u[3]); perform public.bluff_ready(r);
  g := pg_temp.st(r);
  if g.status = 'play' and pg_temp.cards_ok(r) then n := n + 1; end if;
  select * into p from public.bluff_players x where x.room_id = r and x.seat = g.turn_seat;
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, 11, false)', r, p.user_id, 'put', array[p.hand[1]])) like '%bluff_bad_rank%'
     and pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, 4, false)', r, p.user_id, 'put', array[p.hand[1]])) like '%bluff_bad_rank%' then n := n + 1; end if;
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, 10, false)', r, p.user_id, 'put', array[p.hand[1]])) = 'ok'
     and (pg_temp.st(r)).claim_rank = 10 then n := n + 1; end if;
  step := 0;
  while (pg_temp.st(r)).status = 'play' and step < 1500 loop
    step := step + 1;
    perform pg_temp.rnd_move(r, pg_temp.uid_at(r, (pg_temp.st(r)).turn_seat));
  end loop;
  if (pg_temp.st(r)).status = 'finished' and (select sum(payout) from public.bluff_players where room_id = r) = 30 then n := n + 1; end if;
  perform pg_temp.login(u[2]); r2 := public.bluff_rematch(r);
  g := pg_temp.st(r2);
  if g.low_rank = 5 and g.high_rank = 10 and g.jokers = 1 and g.stake = 10 then n := n + 1; end if;
  perform public.bluff_leave(r2);
  res := res || case when n = 5 then E'ok   3 раздаются только карты от 5 до 10; назвать валета или четвёрку нельзя, десятку — можно; итог; «Ещё раз» — та же колода\n'
                     else E'FAIL 3 (' || n || E'/5)\n' end;

  -- ===== 4. Тестовая комната админа: мест не больше, чем карт =====
  n := 0;
  perform pg_temp.login(adm); r := public.bluff_create(0, 14, 0, true, 14);       -- одни тузы: 4 карты
  for i in 1..3 loop perform public.bluff_add_bot(r); end loop;
  if pg_temp.try('select public.bluff_add_bot(' || r || ')') like '%bluff_full%' then n := n + 1; end if;
  perform public.bluff_start(r);
  step := 0;
  while (pg_temp.st(r)).status = 'play' and step < 200 loop
    step := step + 1;
    select * into p from public.bluff_players where room_id = r and seat = (pg_temp.st(r)).turn_seat;
    if p.bot_name is not null then perform public.bluff_bot_move(r, p.user_id); else perform pg_temp.rnd_move(r, p.user_id); end if;
    if not pg_temp.cards_ok(r) then bad := bad + 1; exit; end if;
  end loop;
  if (pg_temp.st(r)).status = 'finished' and bad = 0 then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   4 тестовая «одни тузы»: 4 места (пятого бота не посадить), партия доиграна\n'
                     else E'FAIL 4 (' || n || E'/2)\n' end;

  -- ===== 5. Случайные партии на случайных отрезках =====
  bad := 0;
  for games in 1..40 loop
    lo := 2 + floor(random() * 13)::integer; hi := lo + floor(random() * (15 - lo))::integer; jk := floor(random() * 5)::integer;
    nb := least(3 + floor(random() * 2)::integer, public.bluff_deck_n(lo, hi, jk));
    perform pg_temp.login(u[1]); r := public.bluff_create(7, lo, jk, false, hi);
    for i in 2..nb loop perform pg_temp.login(u[i]); perform public.bluff_join(r); end loop;
    perform pg_temp.login(u[1]); perform public.bluff_start(r);
    for i in 2..nb loop perform pg_temp.login(u[i]); perform public.bluff_ready(r); end loop;
    if not pg_temp.cards_ok(r) then bad := bad + 1; note := note || ' раздача ' || games; end if;
    step := 0;
    while (pg_temp.st(r)).status = 'play' and step < 1500 loop
      step := step + 1;
      perform pg_temp.rnd_move(r, pg_temp.uid_at(r, (pg_temp.st(r)).turn_seat));
      if not pg_temp.cards_ok(r) then bad := bad + 1; note := note || ' партия ' || games || ' ход ' || step; exit; end if;
    end loop;
    steps_max := greatest(steps_max, step);
    if (pg_temp.st(r)).status = 'finished' then
      finished := finished + 1;
      if (select sum(payout) from public.bluff_players where room_id = r) <> 7 * nb then bad := bad + 1; note := note || ' выплаты ' || games; end if;
    else
      for i in 1..nb loop perform pg_temp.login(u[i]); perform pg_temp.try('select public.bluff_leave(' || r || ')'); end loop;
    end if;
  end loop;
  if (select sum(public.coins_of(y)) from unnest(u) y) <> (select sum(z) from unnest(c0) z) then bad := bad + 1; note := note || ' монеты'; end if;
  res := res || case when bad = 0 and finished >= 30 then 'ok   5 случайные отрезки: ' || finished || E' из 40 партий закончились, карты только из отрезка и не терялись, выплаты = банк, монеты сошлись\n'
                     else 'FAIL 5 (закончились ' || finished || ' из 40, ошибок ' || bad || note || E')\n' end;

  -- ===== 6. Боты на случайных отрезках =====
  bad := 0; note := '';
  for games in 1..30 loop
    lo := 2 + floor(random() * 13)::integer; hi := lo + floor(random() * (15 - lo))::integer; jk := floor(random() * 5)::integer;
    perform pg_temp.login(adm); r := public.bluff_create(0, lo, jk, true, hi);
    nb := least(2 + floor(random() * 4)::integer, public.bluff_max_seats(r) - 1);
    for i in 1..nb loop perform public.bluff_add_bot(r); end loop;
    if nb < 2 then perform pg_temp.try('select public.bluff_leave(' || r || ')'); continue; end if;
    perform public.bluff_start(r);
    bot_games := bot_games + 1;
    step := 0;
    while (pg_temp.st(r)).status = 'play' and step < 1500 loop
      step := step + 1;
      select * into p from public.bluff_players where room_id = r and seat = (pg_temp.st(r)).turn_seat;
      if p.bot_name is not null then perform public.bluff_bot_move(r, p.user_id); else perform pg_temp.rnd_move(r, p.user_id); end if;
      if not pg_temp.cards_ok(r) then bad := bad + 1; note := note || ' бот-партия ' || games; exit; end if;
    end loop;
    if (pg_temp.st(r)).status = 'finished' then bot_fin := bot_fin + 1;
    else perform pg_temp.login(adm); perform public.bluff_leave(r);
      if (pg_temp.st(r)).status <> 'finished' then bad := bad + 1; note := note || ' не закончилась ' || games; end if;
    end if;
  end loop;
  res := res || case when bad = 0 and bot_fin >= bot_games * 0.8 then 'ok   6 боты на случайных отрезках: ' || bot_fin || ' из ' || bot_games || E' партий доиграли сами, карты не терялись\n'
                     else 'FAIL 6 (доиграли ' || bot_fin || ' из ' || bot_games || ', ошибок ' || bad || note || E')\n' end;

  raise exception E'\n%', res;
end $test$;
