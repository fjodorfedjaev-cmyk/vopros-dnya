-- «ВЕРЮ — НЕ ВЕРЮ»: последние карты (04_last_cards.sql). Самоотменяющийся тест: в конце падает — всё откатывается.
-- Запускать одним запросом после миграций 01–04.
-- Карты (колода от 2): номинал r, масть m → (r − 2) × 4 + m: 2♠ 0, 2♥ 1, 3♠ 4, 3♥ 5, 4♠ 8, 4♥ 9, 5♠ 12, 5♥ 13.
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;
create function pg_temp.uid_at(r bigint, s integer) returns uuid language sql as $$
  select user_id from public.bluff_players where room_id = r and seat = s $$;
create function pg_temp.hand(r bigint, s integer) returns integer[] language sql as $$
  select hand from public.bluff_players where room_id = r and seat = s $$;
create function pg_temp.st(r bigint) returns public.bluff_rooms language sql as $$ select * from public.bluff_rooms where id = r $$;
create function pg_temp.lastlog(r bigint, k text) returns jsonb language sql as $$
  select e from public.bluff_rooms g, jsonb_array_elements(g.log) e where g.id = r and e ->> 'kind' = k order by (e ->> 'i')::int desc limit 1 $$;
create function pg_temp.places(r bigint) returns text language sql as $$
  select string_agg(seat || ':' || coalesce(place::text, '-') || ':' || coalesce(out_kind, '-'), ',' order by seat) from public.bluff_players where room_id = r $$;
-- карт всего (руки + стопка + бита) и нет ли повторов
create function pg_temp.cards_ok(r bigint) returns boolean language sql as $$
  with c as (select unnest(hand) x from public.bluff_players where room_id = r union all select unnest(pile) from public.bluff_rooms where id = r)
  select (select count(*) from c) + (select bita from public.bluff_rooms where id = r)
           = (select public.bluff_deck_n(low_rank, high_rank, jokers) from public.bluff_rooms where id = r)
     and (select count(*) from c) = (select count(distinct x) from c) $$;
-- комната на n человек (u[1..n]), игра идёт; руки раскладываем вручную, ход — t
create function pg_temp.room(u uuid[], n integer) returns bigint language plpgsql as $$
declare r bigint; i integer;
begin
  perform pg_temp.login(u[1]); r := public.bluff_create(10, 2, 0);
  for i in 2..n loop perform pg_temp.login(u[i]); perform public.bluff_join(r); end loop;
  perform pg_temp.login(u[1]); perform public.bluff_start(r);
  for i in 2..n loop perform pg_temp.login(u[i]); perform public.bluff_ready(r); end loop;
  return r;
end $$;
create function pg_temp.setup(r bigint, h integer[][], t integer) returns void language plpgsql as $$
declare i integer; k integer := 0;
begin
  for i in 1..array_length(h, 1) loop
    update public.bluff_players set hand = array(select x from unnest(h[i:i]) x where x >= 0), place = null, out_kind = null, misses = 0, emptied_at = null
     where room_id = r and seat = i - 1;
    k := k + (select count(*) from unnest(h[i:i]) x where x >= 0);
  end loop;
  update public.bluff_rooms set pile = '{}', claim_rank = null, last_seat = null, last_n = 0, turn_seat = t, status = 'play', log = '[]',
         bita = 52 - k, deadline = now() + interval '30 seconds'
   where id = r;
end $$;

do $test$
declare
  u uuid[]; adm uuid; res text := ''; n integer; i integer; r bigint; g public.bluff_rooms%rowtype; e jsonb; v jsonb;
  s uuid[]; c0 numeric; bots uuid[]; kinds text := '';
begin
  select array_agg(x.id order by x.created_at) into u from (
    select x.id, x.created_at from public.profiles x
     where not exists (select 1 from public.admins a where a.user_id = x.id)
       and not exists (select 1 from public.bluff_players b join public.bluff_rooms rr on rr.id = b.room_id
                        where b.user_id = x.id and b.place is null and rr.status in ('open', 'ready', 'play'))
     order by x.created_at limit 4) x;
  select a.user_id into adm from public.admins a limit 1;
  if cardinality(u) < 4 or adm is null then raise exception 'для теста нужно 4 участника и админ'; end if;
  for i in 1..4 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 100000, 'game', 'test:bluff-last'); end loop;

  -- ===== 1. Без карт, круг дошёл, время вышло — база отвечает «Верю» =====
  n := 0;
  r := pg_temp.room(u, 3);
  s := array[pg_temp.uid_at(r, 0), pg_temp.uid_at(r, 1), pg_temp.uid_at(r, 2)];
  perform pg_temp.setup(r, array[[0, -1], [4, 5], [8, 9]], 0);
  perform public.bluff_move(r, s[1], 'put', '{0}', 2, false);          -- последняя, правда
  perform public.bluff_move(r, s[2], 'put', '{4}', null, false);       -- враньё
  perform public.bluff_move(r, s[3], 'put', '{8}', null, false);       -- враньё — круг дошёл до нулевого
  update public.bluff_rooms set deadline = now() - interval '5 seconds' where id = r;
  perform public.bluff_tick(r);
  e := pg_temp.lastlog(r, 'reveal');
  if e ->> 'call' = 'trust' and (e ->> 'auto')::boolean and (e ->> 'seat')::int = 0 and not (e ->> 'truth')::boolean then n := n + 1; end if;
  if pg_temp.hand(r, 0) @> '{0,4,8}' and (select place is null and misses = 1 from public.bluff_players where room_id = r and seat = 0)
     and pg_temp.cards_ok(r) then n := n + 1; end if;                    -- поверил вранью — забрал стопку, играет дальше
  res := res || case when n = 2 then E'ok   1 без карт, время вышло — база отвечает «Верю» (пропуск засчитан); враньё — забрал стопку и играет дальше\n'
                     else E'FAIL 1 (' || n || E'/2)\n' end;
  for i in 1..3 loop perform pg_temp.login(u[i]); perform pg_temp.try('select public.bluff_leave(' || r || ')'); end loop;

  -- ===== 2. Без карт остались двое — кто раньше остался без карт, тот выше =====
  n := 0;
  r := pg_temp.room(u, 4);
  s := array[pg_temp.uid_at(r, 0), pg_temp.uid_at(r, 1), pg_temp.uid_at(r, 2), pg_temp.uid_at(r, 3)];
  perform pg_temp.setup(r, array[[0, -1], [1, -1], [4, 5], [8, 9]], 1);
  perform public.bluff_move(r, s[2], 'put', '{1}', 2, false);          -- первый: последняя (раньше всех без карт)
  perform public.bluff_move(r, s[3], 'put', '{4}', null, false);
  perform public.bluff_move(r, s[4], 'put', '{8}', null, false);
  perform public.bluff_move(r, s[1], 'put', '{0}', null, false);       -- нулевой: последняя, правда
  g := pg_temp.st(r);
  if g.turn_seat = 1 and pg_temp.places(r) = '0:-:-,1:-:-,2:-:-,3:-:-' then n := n + 1; end if;   -- круг дошёл до первого, все в игре
  perform pg_temp.login(s[2]); v := public.bluff_view(r);
  if (v -> 'my' ->> 'can_call')::boolean and not (v -> 'my' ->> 'new_round')::boolean then n := n + 1; end if;
  perform public.bluff_move(r, s[2], 'trust', null, null, false);      -- правда: стопка в биту — оба без карт занимают места
  g := pg_temp.st(r);
  if pg_temp.places(r) = '0:2:done,1:1:done,2:-:-,3:-:-' and g.turn_seat = 2 and g.claim_rank is null and pg_temp.cards_ok(r) then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   2 без карт двое: круг идёт, оба в игре; «верю» на правду — в биту, места по тому, кто раньше остался без карт; начинает следующий\n'
                     else E'FAIL 2 (' || n || E'/3): ' || pg_temp.places(r) || E'\n' end;
  for i in 1..4 loop perform pg_temp.login(u[i]); perform pg_temp.try('select public.bluff_leave(' || r || ')'); end loop;

  -- ===== 3. Положивший последним вышел («Выйти»), а ход был у того, кто без карт =====
  n := 0;
  r := pg_temp.room(u, 4);
  s := array[pg_temp.uid_at(r, 0), pg_temp.uid_at(r, 1), pg_temp.uid_at(r, 2), pg_temp.uid_at(r, 3)];
  perform pg_temp.setup(r, array[[0, -1], [4, 5], [8, 9], [12, 13]], 0);
  perform public.bluff_move(r, s[1], 'put', '{0}', 2, false);          -- нулевой: последняя
  perform public.bluff_move(r, s[2], 'put', '{4}', null, false);
  perform public.bluff_move(r, s[3], 'put', '{8}', null, false);
  perform public.bluff_move(r, s[4], 'put', '{12}', null, false);      -- круг дошёл до нулевого
  perform pg_temp.login(s[4]); perform public.bluff_leave(r);           -- третий (клал последним) вышел
  g := pg_temp.st(r);
  if pg_temp.places(r) = '0:1:done,1:-:-,2:-:-,3:4:left' then n := n + 1; end if;   -- стопка в биту: нулевой без карт — первое место
  if g.turn_seat = 1 and g.claim_rank is null and cardinality(g.pile) = 0 and g.deadline > now() and pg_temp.cards_ok(r) then n := n + 1; end if;   -- ход не застрял у занявшего место
  res := res || case when n = 2 then E'ok   3 положивший последним вышел — стопка в биту, тот, кто был без карт, занял место; ход — следующему\n'
                     else E'FAIL 3 (' || n || E'/2): ' || pg_temp.places(r) || ' ход ' || coalesce(g.turn_seat::text, '-') || E'\n' end;
  for i in 1..4 loop perform pg_temp.login(u[i]); perform pg_temp.try('select public.bluff_leave(' || r || ')'); end loop;

  -- ===== 4. Не ответил тому, кто положил последние, — выбыл по времени; отвечает следующий =====
  n := 0;
  r := pg_temp.room(u, 3);
  s := array[pg_temp.uid_at(r, 0), pg_temp.uid_at(r, 1), pg_temp.uid_at(r, 2)];
  perform pg_temp.setup(r, array[[0, 1, -1], [4, 5, -1], [8, 9, 12]], 1);
  perform public.bluff_move(r, s[2], 'put', '{4,5}', 3, false);        -- первый: последние две
  update public.bluff_players set misses = 1 where room_id = r and seat = 2;
  update public.bluff_rooms set deadline = now() - interval '5 seconds' where id = r;
  perform public.bluff_tick(r);                                          -- второй: второй пропуск подряд — выбыл
  g := pg_temp.st(r);
  -- дальше по кругу — нулевой (он отвечает первому), стопка не трогается
  if pg_temp.places(r) = '0:-:-,1:-:-,2:3:afk' and g.turn_seat = 0 and g.last_seat = 1 and pg_temp.cards_ok(r) then n := n + 1; end if;
  perform public.bluff_move(r, s[1], 'doubt', null, null, false);      -- правда: нулевой забрал, первый без карт — первое место, итог
  g := pg_temp.st(r);
  if g.status = 'finished' and pg_temp.places(r) = '0:2:last,1:1:done,2:3:afk' then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   4 не ответил на последние карты — выбыл по времени, отвечает следующий; «не верю» на правду — место, итог\n'
                     else E'FAIL 4 (' || n || E'/2): ' || pg_temp.places(r) || E'\n' end;

  -- ===== 5. Бот без карт: только «Верю» / «Не верю» =====
  n := 0;
  perform pg_temp.login(adm); r := public.bluff_create(0, 2, 0, true);
  perform public.bluff_add_bot(r); perform public.bluff_add_bot(r);
  perform public.bluff_start(r);
  for i in 1..20 loop
    perform pg_temp.setup(r, array[[0, 1], [-1, -1], [8, 9]], 1);
    update public.bluff_rooms set pile = '{4}', claim_rank = 3, last_seat = 0, last_n = 1, bita = 52 - 5 where id = r;   -- нулевой положил «тройку»
    update public.bluff_players set hand = '{0,1}' where room_id = r and seat = 0;
    if pg_temp.try(format('select public.bluff_bot_move(%s, %L)', r, pg_temp.uid_at(r, 1))) = 'ok' then
      e := pg_temp.lastlog(r, 'reveal');
      if (e ->> 'seat')::int = 1 and e ->> 'call' in ('trust', 'doubt') then n := n + 1; kinds := kinds || (e ->> 'call') || ' '; end if;
    end if;
  end loop;
  res := res || case when n = 20 and kinds like '%trust%' and kinds like '%doubt%' then E'ok   5 бот без карт 20 раз: только «верю» / «не верю» (бывают оба), ошибок нет\n'
                     else E'FAIL 5 (' || n || E'/20)\n' end;
  perform pg_temp.login(adm); perform pg_temp.try('select public.bluff_leave(' || r || ')');

  raise exception E'\n%', res;
end $test$;
