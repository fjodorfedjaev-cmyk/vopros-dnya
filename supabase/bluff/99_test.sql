-- «ВЕРЮ — НЕ ВЕРЮ»: самоотменяющийся тест. Запускать одним запросом вместе с миграциями (01_bluff.sql, 02_range.sql — колода «от … до …»,
-- 04_last_cards.sql — последние карты: в игре до конца круга).
-- Часть 1 — правила по одному (карты раскладываем вручную), часть 2 — много партий: случайные ходы людей и боты;
-- после каждого хода проверяем, что карты не потерялись и не задвоились, в конце — что монеты сходятся.
-- В конце тест падает — всё откатывается.
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;
create function pg_temp.uid_at(r bigint, s integer) returns uuid language sql as $$
  select user_id from public.bluff_players where room_id = r and seat = s $$;
create function pg_temp.hand(r bigint, s integer) returns integer[] language sql as $$
  select hand from public.bluff_players where room_id = r and seat = s $$;
-- карт всего (руки + стопка + бита) и нет ли повторов среди тех, что на руках и в стопке
create function pg_temp.cards_ok(r bigint) returns boolean language sql as $$
  with c as (select unnest(hand) x from public.bluff_players where room_id = r union all select unnest(pile) from public.bluff_rooms where id = r)
  select (select count(*) from c) + (select bita from public.bluff_rooms where id = r)
           = (select public.bluff_deck_n(low_rank, high_rank, jokers) from public.bluff_rooms where id = r)
     and (select count(*) from c) = (select count(distinct x) from c) $$;
-- разложить карты вручную: руки по местам, ход, пустой стол
create function pg_temp.setup(r bigint, h0 integer[], h1 integer[], h2 integer[], t integer) returns void language plpgsql as $$
begin
  update public.bluff_players set hand = case seat when 0 then h0 when 1 then h1 when 2 then h2 else hand end, place = null, out_kind = null, misses = 0
   where room_id = r;
  update public.bluff_rooms set pile = '{}', claim_rank = null, last_seat = null, last_n = 0, turn_seat = t, status = 'play',
         bita = public.bluff_deck_n(low_rank, high_rank, jokers) - cardinality(h0) - cardinality(h1) - cardinality(h2), deadline = now() + interval '30 seconds'
   where id = r;
end $$;
create function pg_temp.st(r bigint) returns public.bluff_rooms language sql as $$ select * from public.bluff_rooms where id = r $$;
create function pg_temp.lastlog(r bigint, k text) returns jsonb language sql as $$
  select e from public.bluff_rooms g, jsonb_array_elements(g.log) e where g.id = r and e ->> 'kind' = k order by (e ->> 'i')::int desc limit 1 $$;
-- случайный ход (для партий): в начале круга — 1–3 случайные карты и случайный номинал; в ответ — доложить / не верю / верю
create function pg_temp.rnd_move(r bigint, u uuid) returns void language plpgsql as $$
declare g public.bluff_rooms%rowtype; me public.bluff_players%rowtype; k integer; roll double precision := random();
begin
  select * into g from public.bluff_rooms where id = r;
  select * into me from public.bluff_players where room_id = r and user_id = u;
  k := 1 + floor(random() * least(3, cardinality(me.hand)))::integer;
  if cardinality(me.hand) = 0 then                -- без карт (последние уже положены, круг ещё идёт): только «верю» / «не верю»
    perform public.bluff_move(r, u, case when roll < 0.5 then 'doubt' else 'trust' end, null, null, false);
  elsif g.claim_rank is null then
    perform public.bluff_move(r, u, 'put', array(select c from unnest(me.hand) c order by random() limit k), g.low_rank + floor(random() * (15 - g.low_rank))::integer, false);
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
  u uuid[]; adm uuid; res text := ''; n integer; i integer; k integer; step integer; r bigint; g public.bluff_rooms%rowtype;
  c0 numeric[]; e jsonb; s0 uuid; s1 uuid; s2 uuid; v jsonb; bad integer := 0; games integer := 0; finished integer := 0;
  steps_max integer := 0; reveals integer := 0; fours integer := 0; outs integer := 0; bank numeric; paid numeric; cur uuid;
  p public.bluff_players%rowtype; nb integer; lo integer; jk integer; bot_games integer := 0; bot_fin integer := 0; note text := '';
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

  -- ===== 1. Комната: колода, места, старт от 3, «Готов», раздача =====
  n := 0;
  perform pg_temp.login(u[1]);
  if pg_temp.try('select public.bluff_create(10, 15, 0)') like '%bluff_bad_deck%' and pg_temp.try('select public.bluff_create(10, 6, 5)') like '%bluff_bad_deck%' then n := n + 1; end if;
  r := public.bluff_create(10, 6, 2);                                   -- от шестёрки до туза + 2 джокера = 38 карт
  if (select public.bluff_view(r) ->> 'deck_n') = '38' and (select public.bluff_view(r) ->> 'max_seats') = '6' then n := n + 1; end if;
  if pg_temp.try('select public.bluff_create(10, 2, 0)') like '%bluff_busy%' then n := n + 1; end if;
  perform pg_temp.login(u[2]); perform public.bluff_join(r);
  perform pg_temp.login(u[1]);
  if pg_temp.try('select public.bluff_start(' || r || ')') like '%bluff_few%' then n := n + 1; end if;   -- двоих мало
  perform pg_temp.login(u[3]); perform public.bluff_join(r);
  perform pg_temp.login(u[1]); perform public.bluff_start(r);
  if (pg_temp.st(r)).status = 'ready' then n := n + 1; end if;
  perform pg_temp.login(u[2]); perform public.bluff_ready(r);
  perform pg_temp.login(u[3]); perform public.bluff_ready(r);
  g := pg_temp.st(r);
  if g.status = 'play' and g.turn_seat is not null and pg_temp.cards_ok(r) and g.claim_rank is null then n := n + 1; end if;
  if public.coins_of(u[1]) = c0[1] - 10 and public.coins_of(u[2]) = c0[2] - 10 then n := n + 1; end if;
  -- колода «одни тузы» без джокеров — мест 4
  perform pg_temp.login(u[4]); k := public.bluff_create(0, 14, 0);
  if public.bluff_max_seats(k) = 4 and public.bluff_deck_n(14, 14, 0) = 4 and public.bluff_deck_n(2, 14, 4) = 56 then n := n + 1; end if;
  perform public.bluff_leave(k);
  if (pg_temp.st(k)).status = 'cancelled' then n := n + 1; end if;
  -- чужие карты телефон не получает: у игрока — своя рука, у остальных — только число
  perform pg_temp.login(u[2]); v := public.bluff_view(r);
  if jsonb_array_length(v -> 'my' -> 'hand') = cardinality(pg_temp.hand(r, (v -> 'my' ->> 'seat')::int))
     and not exists (select 1 from jsonb_array_elements(v -> 'players') pl where pl ? 'hand') and not (v ? 'pile') then n := n + 1; end if;
  res := res || case when n = 10 then E'ok   1 комната: колода «от … до туза» + джокеры, мест не больше карт, старт от 3, «Готов», раздача, чужих карт не видно\n'
                     else E'FAIL 1 (' || n || E'/10)\n' end;

  -- места: u1 — 0, u2 — 1, u3 — 2 (заходили по порядку)
  s0 := pg_temp.uid_at(r, 0); s1 := pg_temp.uid_at(r, 1); s2 := pg_temp.uid_at(r, 2);
  -- карты (колода от 6): номинал r, масть m → (r − 2) × 4 + m; 7♠ 20, 7♥ 21, 7♦ 22, 7♣ 23, 8♠ 24, 8♥ 25, 9♠ 28, 10♠ 32, 10♥ 33,
  -- Q♠ 40, K♠ 44, A♠ 48, джокеры 52, 53

  -- ===== 2. «Не верю» + правда: стопку забирает проверявший и пропускает ход =====
  n := 0;
  perform pg_temp.setup(r, '{20,21,28,29,44,52}', '{22,24,32,40}', '{23,25,33,48,53}', 0);
  perform public.bluff_move(r, s0, 'put', '{20,21}', 7, false);
  g := pg_temp.st(r);
  if g.claim_rank = 7 and g.last_seat = 0 and g.last_n = 2 and g.turn_seat = 1 and cardinality(g.pile) = 2 then n := n + 1; end if;
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, 7, false)', r, s2, 'put', '{23}')) like '%bluff_not_turn%' then n := n + 1; end if;
  perform public.bluff_move(r, s1, 'doubt', null, null, false);
  g := pg_temp.st(r); e := pg_temp.lastlog(r, 'reveal');
  if (e ->> 'truth')::boolean and (e ->> 'taker')::int = 1 and e -> 'cards' = '[20,21]'::jsonb and g.turn_seat = 2 and g.claim_rank is null
     and pg_temp.hand(r, 1) @> '{20,21,22}' and cardinality(g.pile) = 0 and pg_temp.cards_ok(r) then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   2 «не верю» + правда: стопку забрал проверявший, ход через него, всем показаны открытые карты\n'
                     else E'FAIL 2 (' || n || E'/3)\n' end;

  -- ===== 3. «Не верю» + враньё: стопку забирает соврвший, новый круг начинает проверявший =====
  n := 0;
  perform public.bluff_move(r, s2, 'put', '{25}', 7, false);           -- 8♥ под видом семёрки
  perform public.bluff_move(r, s0, 'doubt', null, null, false);
  g := pg_temp.st(r); e := pg_temp.lastlog(r, 'reveal');
  if not (e ->> 'truth')::boolean and (e ->> 'taker')::int = 2 and 25 = any (pg_temp.hand(r, 2)) and g.turn_seat = 0 and g.claim_rank is null
     and pg_temp.cards_ok(r) then n := n + 1; end if;
  res := res || case when n = 1 then E'ok   3 «не верю» + враньё: карты вернулись соврвшему, новый круг начинает проверявший\n'
                     else E'FAIL 3 (' || n || E'/1)\n' end;

  -- ===== 4. «Верю» + правда: стопка в биту, новый круг начинает поверивший; «верю» + враньё: забирает поверивший =====
  n := 0;
  k := (pg_temp.st(r)).bita;
  perform public.bluff_move(r, s0, 'put', '{28}', 9, false);
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, null, null, false)', r, s0, 'trust')) like '%bluff_not_turn%' then n := n + 1; end if;
  perform public.bluff_move(r, s1, 'trust', null, null, false);
  g := pg_temp.st(r);
  if g.bita = k + 1 and g.turn_seat = 1 and g.claim_rank is null and (pg_temp.lastlog(r, 'reveal') ->> 'taker') is null and pg_temp.cards_ok(r) then n := n + 1; end if;
  perform public.bluff_move(r, s1, 'put', '{24}', 12, false);          -- 8♠ под видом дамы
  perform public.bluff_move(r, s2, 'trust', null, null, false);
  g := pg_temp.st(r);
  if 24 = any (pg_temp.hand(r, 2)) and g.turn_seat = 0 and (pg_temp.lastlog(r, 'reveal') ->> 'taker')::int = 2 and pg_temp.cards_ok(r) then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   4 «верю» + правда — стопка в биту, начинает поверивший; «верю» + враньё — забрал поверивший, ход через него\n'
                     else E'FAIL 4 (' || n || E'/3)\n' end;

  -- ===== 5. Доложить и джокеры: номинал круга тот же, проверяются только последние карты; джокер — правда =====
  n := 0;
  perform public.bluff_move(r, s0, 'put', '{52}', 10, false);          -- джокер под видом десятки
  perform public.bluff_move(r, s1, 'put', '{32}', 6, false);           -- доложил 10♠ (номинал, который он назвал, не важен — круг «десятки»)
  g := pg_temp.st(r);
  if g.claim_rank = 10 and g.last_seat = 1 and g.last_n = 1 and cardinality(g.pile) = 2 then n := n + 1; end if;
  perform public.bluff_move(r, s2, 'doubt', null, null, false);
  g := pg_temp.st(r); e := pg_temp.lastlog(r, 'reveal');
  if (e ->> 'truth')::boolean and e -> 'cards' = '[32]'::jsonb and pg_temp.hand(r, 2) @> '{52,32}' and g.turn_seat = 0 and pg_temp.cards_ok(r) then n := n + 1; end if;
  -- джокер в «верю»: правда, стопка в биту
  perform public.bluff_move(r, s0, 'put', '{44}', 13, false);
  perform public.bluff_move(r, s1, 'put', '{40}', null, false);        -- доложил даму к «королям» — враньё
  perform public.bluff_move(r, s2, 'put', '{53}', null, false);        -- доложил джокера к «королям» — правда
  perform public.bluff_move(r, s0, 'trust', null, null, false);
  e := pg_temp.lastlog(r, 'reveal');
  if (e ->> 'truth')::boolean and (e ->> 'n')::int = 3 and (e ->> 'taker') is null and pg_temp.cards_ok(r) then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   5 доложить: номинал круга тот же, проверяются только последние карты; джокер — всегда правда\n'
                     else E'FAIL 5 (' || n || E'/3)\n' end;

  -- ===== 6. Ошибки хода =====
  n := 0;
  perform pg_temp.setup(r, '{20,21,28}', '{22,24}', '{23,25}', 0);
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, 7, false)', r, s0, 'put', '{22}')) like '%bluff_bad_move%' then n := n + 1; end if;   -- чужая карта
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, 7, false)', r, s0, 'put', '{}')) like '%bluff_bad_move%' then n := n + 1; end if;     -- пусто
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, 5, false)', r, s0, 'put', '{20}')) like '%bluff_bad_rank%' then n := n + 1; end if;   -- 5 нет в колоде от 6
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, 7, false)', r, s0, 'put', '{20,20}')) like '%bluff_bad_move%' then n := n + 1; end if; -- повтор
  if pg_temp.try(format('select public.bluff_move(%s, %L, %L, null, null, false)', r, s0, 'doubt')) like '%bluff_bad_move%' then n := n + 1; end if;   -- проверять нечего
  res := res || case when n = 5 then E'ok   6 ошибки: чужая карта, пусто, номинала нет в колоде, повтор карты, «не верю» на пустом столе\n'
                     else E'FAIL 6 (' || n || E'/5)\n' end;

  -- ===== 7. Четыре одного номинала на руках — в биту =====
  n := 0;
  perform pg_temp.setup(r, '{23,28}', '{20,21,22,24}', '{25,33}', 0);
  k := (pg_temp.st(r)).bita;
  perform public.bluff_move(r, s0, 'put', '{23}', 7, false);           -- 7♣, правда
  perform public.bluff_move(r, s1, 'doubt', null, null, false);        -- проверил — правда, забрал: четыре семёрки
  e := pg_temp.lastlog(r, 'four');
  if e -> 'cards' = '[20,21,22,23]'::jsonb and (e ->> 'seat')::int = 1 and pg_temp.hand(r, 1) = '{24}' and (pg_temp.st(r)).bita = k + 4 and pg_temp.cards_ok(r) then n := n + 1; end if;
  res := res || case when n = 1 then E'ok   7 забрал стопку и собрал четыре семёрки — они ушли в биту (видно всем)\n'
                     else E'FAIL 7 (' || n || E'/1)\n' end;

  -- ===== 8. Последние карты: в игре до конца круга; итог и выплаты =====
  n := 0;
  perform pg_temp.setup(r, '{28}', '{24,32}', '{33,48}', 0);
  update public.bluff_rooms set log = '[]' where id = r;
  perform public.bluff_move(r, s0, 'put', '{28}', 9, false);           -- последняя карта, правда — ждёт ответа
  if (select place from public.bluff_players where room_id = r and seat = 0) is null then n := n + 1; end if;
  perform public.bluff_move(r, s1, 'put', '{24}', null, false);        -- доложил (враньё) — нулевой без карт, но ещё в игре
  perform public.bluff_move(r, s2, 'put', '{33}', null, false);        -- доложил (враньё) — круг дошёл до нулевого
  g := pg_temp.st(r);
  if (select place from public.bluff_players where room_id = r and seat = 0) is null and pg_temp.lastlog(r, 'out') is null
     and g.turn_seat = 0 and g.last_seat = 2 then n := n + 1; end if;
  perform pg_temp.login(s0); v := public.bluff_view(r);
  if (v -> 'my' ->> 'can_call')::boolean and jsonb_array_length(v -> 'my' -> 'hand') = 0
     and pg_temp.try(format('select public.bluff_move(%s, %L, %L, %L, null, false)', r, s0, 'put', '{28}')) like '%bluff_bad_move%' then n := n + 1; end if;
  perform public.bluff_move(r, s0, 'doubt', null, null, false);        -- враньё: второй забрал [28, 24, 33], нулевой — первое место
  if (select place from public.bluff_players where room_id = r and seat = 0) = 1 and (pg_temp.lastlog(r, 'out') ->> 'seat')::int = 0
     and pg_temp.hand(r, 2) @> '{24,28,33,48}' and (pg_temp.st(r)).turn_seat = 1 then n := n + 1; end if;   -- угадавший уже вне круга — начинает следующий
  perform public.bluff_move(r, s1, 'put', '{32}', 10, false);          -- первый: последняя, правда
  perform public.bluff_move(r, s2, 'put', '{33}', null, false);        -- второй доложил (правда) — круг дошёл до первого
  if (pg_temp.st(r)).turn_seat = 1 then n := n + 1; end if;          -- занявший место (0) пропускается
  perform public.bluff_move(r, s1, 'trust', null, null, false);        -- поверил правде: стопка в биту — первый без карт, второй последний
  g := pg_temp.st(r);
  if g.status = 'finished' and (select string_agg(seat || ':' || place || ':' || out_kind || ':' || payout, ',' order by seat) from public.bluff_players where room_id = r)
       = '0:1:done:20.00,1:2:done:10.00,2:3:last:0.00' then n := n + 1; end if;
  if public.coins_of(s0) = c0[1] + 10 and public.coins_of(s1) = c0[2] and public.coins_of(s2) = c0[3] - 10 then n := n + 1; end if;
  perform pg_temp.login(u[1]);
  if pg_temp.try('select public.bluff_create(0, 2, 0)') = 'ok' then n := n + 1; end if;   -- закончилась — можно открыть новую
  res := res || case when n = 8 then E'ok   8 последние карты: после «доложить» — ещё в игре, круг дошёл — только «верю» / «не верю»; круг кончился — место; итог 20/10/0, монеты сошлись\n'
                     else E'FAIL 8 (' || n || E'/8)\n' end;
  perform public.bluff_leave((select max(id) from public.bluff_rooms where creator = u[1]));

  -- ===== 9. Время: пропуск — база кладёт за игрока одну карту; второй подряд — выбыл последним; «Выйти» — поражение =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.bluff_create(5, 2, 0);
  perform pg_temp.login(u[2]); perform public.bluff_join(r);
  perform pg_temp.login(u[3]); perform public.bluff_join(r);
  perform pg_temp.login(u[4]); perform public.bluff_join(r);
  perform pg_temp.login(u[1]); perform public.bluff_start(r);
  for i in 2..4 loop perform pg_temp.login(u[i]); perform public.bluff_ready(r); end loop;
  s0 := pg_temp.uid_at(r, 0); s1 := pg_temp.uid_at(r, 1); s2 := pg_temp.uid_at(r, 2);
  perform pg_temp.setup(r, '{0,4,8}', '{1,5,9}', '{2,6,10}', 0);
  update public.bluff_players set hand = '{3,7,11}' where room_id = r and seat = 3;
  update public.bluff_rooms set bita = 52 - 12 where id = r;
  update public.bluff_rooms set deadline = now() - interval '5 seconds' where id = r;
  perform public.bluff_tick(r);                                          -- нулевой не успел: честно одна младшая карта
  g := pg_temp.st(r); e := pg_temp.lastlog(r, 'put');
  if g.claim_rank = 2 and g.pile = '{0}' and (e ->> 'auto')::boolean and g.turn_seat = 1
     and (select misses from public.bluff_players where room_id = r and seat = 0) = 1 then n := n + 1; end if;
  update public.bluff_rooms set deadline = now() - interval '5 seconds' where id = r;
  perform public.bluff_tick(r);                                          -- первый не успел: доложил подходящую (двойку)
  g := pg_temp.st(r);
  if g.pile = '{0,1}' and g.last_seat = 1 and g.turn_seat = 2 then n := n + 1; end if;
  perform public.bluff_move(r, s2, 'trust', null, null, false);          -- правда: стопка в биту, второй начинает
  perform public.bluff_move(r, s2, 'put', '{2}', 2, false);
  update public.bluff_players set misses = 1 where room_id = r and seat = 3;
  update public.bluff_rooms set deadline = now() - interval '5 seconds' where id = r;
  perform public.bluff_tick(r);                                          -- третий — второй пропуск подряд: выбыл последним
  g := pg_temp.st(r);
  if (select place || ':' || out_kind from public.bluff_players where room_id = r and seat = 3) = '4:afk' and g.turn_seat = 0
     and g.last_seat = 2 and pg_temp.cards_ok(r) then n := n + 1; end if;  -- круг идёт: отвечает следующий (нулевой) на тот же ход
  perform pg_temp.login(s2); perform public.bluff_leave(r);              -- второй (клал последним) вышел сам: стопка в биту, круг окончен
  g := pg_temp.st(r);
  if (select place || ':' || out_kind from public.bluff_players where room_id = r and seat = 2) = '3:left' and g.claim_rank is null
     and g.turn_seat = 0 and cardinality(g.pile) = 0 and pg_temp.cards_ok(r) then n := n + 1; end if;
  perform pg_temp.login(s0); perform public.bluff_leave(r);              -- нулевой тоже вышел: остался один — итог
  g := pg_temp.st(r);
  bank := 5 * 4; paid := (select sum(payout) from public.bluff_players where room_id = r);
  if g.status = 'finished' and paid = bank and (select payout from public.bluff_players where room_id = r and seat = 1) = bank
     and (select count(*) from public.bluff_players where room_id = r and out_kind in ('left', 'afk') and payout = 0) = 3 then n := n + 1; end if;
  res := res || case when n = 5 then E'ok   9 время: пропуск — база кладёт одну карту (честно / подходящую), второй — выбыл последним; «Выйти» — поражение, банк сошёлся\n'
                     else E'FAIL 9 (' || n || E'/5)\n' end;

  -- ===== 10. Один в комнате минуту — закрыта; «Готов» не нажали — вышли, ставки вернулись =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.bluff_create(10, 2, 0);
  update public.bluff_rooms set alone_since = now() - interval '61 seconds' where id = r;
  v := public.bluff_view(r);
  if v ->> 'status' = 'cancelled' and (v -> 'log' -> -1 ->> 'kind') = 'alone' then n := n + 1; end if;
  perform pg_temp.login(u[1]); r := public.bluff_create(10, 2, 0);
  perform pg_temp.login(u[2]); perform public.bluff_join(r);
  perform pg_temp.login(u[3]); perform public.bluff_join(r);
  perform pg_temp.login(u[1]); perform public.bluff_start(r);
  update public.bluff_rooms set deadline = now() - interval '5 seconds' where id = r;
  perform public.bluff_tick(r);
  g := pg_temp.st(r);
  if g.status = 'open' and (select count(*) from public.bluff_players where room_id = r) = 1 and g.alone_since = now() then n := n + 1; end if;
  perform pg_temp.login(u[1]); perform public.bluff_leave(r);
  if (pg_temp.st(r)).status = 'cancelled' then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   10 один в комнате минуту — закрыта (журнал «alone»); «Готов» не нажали — вышли, остался один — отсчёт\n'
                     else E'FAIL 10 (' || n || E'/3)\n' end;

  -- ===== 11. Партии со случайными ходами (3–4 человека, разные колоды) =====
  for games in 1..40 loop
    lo := 2 + floor(random() * 13)::integer; jk := floor(random() * 5)::integer;
    nb := least(3 + floor(random() * 2)::integer, public.bluff_deck_n(lo, 14, jk));
    perform pg_temp.login(u[1]); r := public.bluff_create(7, lo, jk);
    for i in 2..nb loop perform pg_temp.login(u[i]); perform public.bluff_join(r); end loop;
    perform pg_temp.login(u[1]); perform public.bluff_start(r);
    for i in 2..nb loop perform pg_temp.login(u[i]); perform public.bluff_ready(r); end loop;
    if not pg_temp.cards_ok(r) then bad := bad + 1; end if;
    step := 0;
    while (pg_temp.st(r)).status = 'play' and step < 1500 loop
      step := step + 1;
      g := pg_temp.st(r);
      cur := pg_temp.uid_at(r, g.turn_seat);
      perform pg_temp.rnd_move(r, cur);
      if not pg_temp.cards_ok(r) then bad := bad + 1; note := note || ' партия ' || games || ' ход ' || step; exit; end if;
    end loop;
    steps_max := greatest(steps_max, step);
    if (pg_temp.st(r)).status = 'finished' then
      finished := finished + 1;
      if (select sum(payout) from public.bluff_players where room_id = r) <> 7 * nb
         or (select count(distinct place) from public.bluff_players where room_id = r) <> nb then bad := bad + 1; note := note || ' выплаты ' || games; end if;
    else
      for i in 1..nb loop perform pg_temp.login(u[i]); perform pg_temp.try('select public.bluff_leave(' || r || ')'); end loop;
    end if;
  end loop;
  if (select sum(public.coins_of(y)) from unnest(u) y) <> (select sum(z) from unnest(c0) z) then bad := bad + 1; note := note || ' монеты'; end if;
  res := res || case when bad = 0 and finished >= 30 then 'ok   11 случайные партии: ' || finished || E' из 40 закончились, карты ни разу не потерялись, выплаты = банк, монеты четверых сошлись\n'
                     else 'FAIL 11 (закончились ' || finished || ' из 40, ошибок ' || bad || note || E')\n' end;

  -- ===== 12. Тестовые комнаты админа с ботами: боты играют сами, админ — случайно =====
  bad := 0; note := ''; steps_max := 0;
  for games in 1..30 loop
    lo := 2 + floor(random() * 13)::integer; jk := floor(random() * 5)::integer;
    perform pg_temp.login(adm); r := public.bluff_create(0, lo, jk, true);
    nb := least(2 + floor(random() * 4)::integer, public.bluff_max_seats(r) - 1);
    for i in 1..nb loop perform public.bluff_add_bot(r); end loop;
    if nb < 2 then perform pg_temp.try('select public.bluff_leave(' || r || ')'); continue; end if;
    perform public.bluff_start(r);
    bot_games := bot_games + 1;
    step := 0;
    while (pg_temp.st(r)).status = 'play' and step < 1500 loop
      step := step + 1;
      g := pg_temp.st(r);
      select * into p from public.bluff_players where room_id = r and seat = g.turn_seat;
      if p.bot_name is not null then perform public.bluff_bot_move(r, p.user_id); else perform pg_temp.rnd_move(r, p.user_id); end if;
      if not pg_temp.cards_ok(r) then bad := bad + 1; note := note || ' бот-партия ' || games; exit; end if;
    end loop;
    steps_max := greatest(steps_max, step);
    if (pg_temp.st(r)).status = 'finished' then bot_fin := bot_fin + 1;
    else perform pg_temp.login(adm); perform public.bluff_leave(r);           -- админ ушёл — боты по числу карт
      if (pg_temp.st(r)).status <> 'finished' then bad := bad + 1; note := note || ' не закончилась ' || games; end if;
    end if;
  end loop;
  res := res || case when bad = 0 and bot_fin >= bot_games * 0.8 then 'ok   12 боты: ' || bot_fin || ' из ' || bot_games || ' партий доиграли сами (до ' || steps_max || E' ходов), карты не потерялись\n'
                     else 'FAIL 12 (доиграли ' || bot_fin || ' из ' || bot_games || ', ошибок ' || bad || note || E')\n' end;

  raise exception E'\n%', res;
end $test$;
