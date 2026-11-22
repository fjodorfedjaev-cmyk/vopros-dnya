-- СОЗДАТЕЛЬ СТОЛА (01_host.sql): самоотменяющийся тест. Запускать одним запросом после миграций Дурака, Покера,
-- «Верю — не верю» (01–04) и 01_host.sql. В конце тест падает — всё откатывается.
-- Весь тест — одна транзакция, now() в ней не меняется: «ушёл больше чем на 5 секунд» делаем, сдвигая назад
-- время, когда человек смотрел комнату (card_seen) и когда зашёл (joined_at).
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;
-- «ушёл»: смотрел комнату 10 секунд назад, зашёл минуту назад
create function pg_temp.away(p_game text, r bigint, p uuid) returns void language plpgsql as $$
begin
  update public.card_seen set seen_at = now() - interval '10 seconds' where game = p_game and room_id = r and user_id = p;
  if p_game = 'durak' then update public.durak_players set joined_at = joined_at - interval '1 minute' where room_id = r and user_id = p;
  else update public.bluff_players set joined_at = joined_at - interval '1 minute' where room_id = r and user_id = p; end if;
end $$;
-- кто создатель на экране у p (флаг 'creator' у игрока в виде)
create function pg_temp.dk_host(r bigint, p uuid) returns uuid language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.login(p); v := public.durak_view(r);
  return (select (x ->> 'id')::uuid from jsonb_array_elements(v -> 'players') x where (x ->> 'creator')::boolean);
end $$;
create function pg_temp.bf_host(r bigint, p uuid) returns uuid language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.login(p); v := public.bluff_view(r);
  return (select (x ->> 'id')::uuid from jsonb_array_elements(v -> 'players') x where (x ->> 'creator')::boolean);
end $$;

do $test$
declare
  u uuid[]; adm uuid; res text := ''; n integer; i integer; r bigint; r2 bigint; v jsonb; ver integer; c0 numeric[]; h uuid;
begin
  select array_agg(x.id order by x.created_at) into u from (
    select x.id, x.created_at from public.profiles x
     where not exists (select 1 from public.admins a where a.user_id = x.id)
     order by x.created_at limit 4) x;
  select a.user_id into adm from public.admins a limit 1;
  if cardinality(u) < 4 or adm is null then raise exception 'для теста нужно 4 участника и админ'; end if;
  for i in 1..4 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 100000, 'game', 'test:host'); end loop;
  c0 := array(select public.coins_of(y) from unnest(u) y);

  -- ===== 1. Дурак: создатель на месте — он; ушёл больше чем на 5 с — следующий; вернулся — снова он =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.durak_create(10);
  perform pg_temp.login(u[2]); perform public.durak_join(r);
  perform pg_temp.login(u[3]); perform public.durak_join(r);
  if pg_temp.dk_host(r, u[1]) = u[1] and pg_temp.dk_host(r, u[2]) = u[1] and pg_temp.dk_host(r, u[3]) = u[1] then n := n + 1; end if;
  perform pg_temp.away('durak', r, u[1]);
  ver := (select version from public.durak_rooms where id = r);
  h := pg_temp.dk_host(r, u[3]);
  if h = u[2] and (select version from public.durak_rooms where id = r) > ver then n := n + 1; end if;   -- следующий по входу; версия выросла — телефоны перерисуют
  perform pg_temp.login(u[3]);
  if pg_temp.try('select public.durak_start(' || r || ')') like '%durak_gone%' then n := n + 1; end if;   -- третий не создатель — начать нельзя
  perform pg_temp.away('durak', r, u[2]);
  if pg_temp.dk_host(r, u[3]) = u[3] then n := n + 1; end if;   -- оба ушли — создатель третий (он на месте)
  if pg_temp.dk_host(r, u[1]) = u[1] and pg_temp.dk_host(r, u[3]) = u[1] then n := n + 1; end if;   -- первый вернулся — снова он
  res := res || case when n = 5 then E'ok   1 Дурак: создатель — изначальный; ушёл больше чем на 5 с — следующий по входу (кто на месте), не создатель начать не может; вернулся — снова он\n'
                     else E'FAIL 1 (' || n || E'/5)\n' end;

  -- ===== 2. Дурак: «Выйти» — насовсем; «Начать» — нажавший; «Ещё раз» — изначальный остаётся создателем =====
  n := 0;
  perform pg_temp.login(u[1]); perform public.durak_leave(r);           -- изначальный вышел насовсем
  perform pg_temp.dk_host(r, u[2]);                                      -- второй снова на месте
  if pg_temp.dk_host(r, u[3]) = u[2] and (select owner from public.durak_rooms where id = r) = u[2] then n := n + 1; end if;
  perform pg_temp.login(u[1]); perform public.durak_join(r);            -- вернулся — уже не изначальный
  if pg_temp.dk_host(r, u[1]) = u[2] then n := n + 1; end if;
  perform pg_temp.away('durak', r, u[2]);                                -- второго нет больше 5 с: создатель — третий (зашёл раньше вернувшегося первого)
  perform pg_temp.dk_host(r, u[1]);
  perform pg_temp.login(u[1]);
  if pg_temp.try('select public.durak_start(' || r || ')') like '%durak_gone%' then n := n + 1; end if;
  perform pg_temp.login(u[3]); perform public.durak_start(r);
  if (select status from public.durak_rooms where id = r) = 'ready' and (select owner from public.durak_rooms where id = r) = u[3] then n := n + 1; end if;
  -- партия кончилась (для теста — сразу), «Ещё раз» первым нажал первый
  update public.durak_rooms set status = 'finished', finished_at = now(), deadline = null where id = r;
  update public.durak_players set place = seat + 1, payout = stake where room_id = r;
  perform pg_temp.login(u[1]); r2 := public.durak_rematch(r);
  if pg_temp.dk_host(r2, u[1]) = u[1] and (select owner from public.durak_rooms where id = r2) = u[3] then n := n + 1; end if;   -- пока начавшего нет — нажавший
  perform pg_temp.login(u[2]); perform public.durak_rematch(r);
  perform pg_temp.login(u[3]); perform public.durak_rematch(r);
  if pg_temp.dk_host(r2, u[3]) = u[3] and pg_temp.dk_host(r2, u[1]) = u[3] and pg_temp.dk_host(r2, u[2]) = u[3] then n := n + 1; end if;   -- зашёл — создатель он
  perform pg_temp.login(u[3]); perform public.durak_start(r2);
  if (select status from public.durak_rooms where id = r2) = 'ready' then n := n + 1; end if;
  res := res || case when n = 7 then E'ok   2 Дурак: «Выйти» — насовсем (вернулся — уже не создатель); «Начать» — только создатель, начавший — изначальный для «Ещё раз»: пока его нет — нажавший, зашёл — он\n'
                     else E'FAIL 2 (' || n || E'/7)\n' end;
  for i in 1..3 loop perform pg_temp.login(u[i]); perform pg_temp.try('select public.durak_leave(' || r2 || ')'); end loop;

  -- ===== 3. «Верю — не верю»: то же самое =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.bluff_create(10, 2, 0);
  for i in 2..4 loop perform pg_temp.login(u[i]); perform public.bluff_join(r); end loop;
  if pg_temp.bf_host(r, u[1]) = u[1] and pg_temp.bf_host(r, u[4]) = u[1] then n := n + 1; end if;
  perform pg_temp.bf_host(r, u[2]); perform pg_temp.bf_host(r, u[3]);
  perform pg_temp.away('bluff', r, u[1]);
  if pg_temp.bf_host(r, u[4]) = u[2] then n := n + 1; end if;
  perform pg_temp.login(u[4]);
  if pg_temp.try('select public.bluff_start(' || r || ')') like '%bluff_gone%' then n := n + 1; end if;
  if pg_temp.bf_host(r, u[1]) = u[1] then n := n + 1; end if;           -- вернулся
  perform pg_temp.login(u[1]); perform public.bluff_start(r);
  for i in 2..4 loop perform pg_temp.login(u[i]); perform public.bluff_ready(r); end loop;
  update public.bluff_rooms set status = 'finished', finished_at = now(), deadline = null, turn_seat = null where id = r;
  update public.bluff_players set place = seat + 1, payout = stake where room_id = r;
  perform pg_temp.login(u[4]); r2 := public.bluff_rematch(r);
  if pg_temp.bf_host(r2, u[4]) = u[4] and (select owner from public.bluff_rooms where id = r2) = u[1] then n := n + 1; end if;
  perform pg_temp.login(u[1]); perform public.bluff_rematch(r);
  if pg_temp.bf_host(r2, u[4]) = u[1] then n := n + 1; end if;
  perform pg_temp.login(u[1]); perform public.bluff_leave(r2);          -- изначальный вышел насовсем — четвёртый
  if pg_temp.bf_host(r2, u[4]) = u[4] and (select owner from public.bluff_rooms where id = r2) = u[4] then n := n + 1; end if;
  res := res || case when n = 7 then E'ok   3 «Верю — не верю»: изначальный; ушёл — следующий, начать нельзя; вернулся — он; «Ещё раз» — он, когда зашёл; «Выйти» — насовсем\n'
                     else E'FAIL 3 (' || n || E'/7)\n' end;
  perform pg_temp.login(u[4]); perform pg_temp.try('select public.bluff_leave(' || r2 || ')');

  -- ===== 4. Тестовая комната с ботами: создатель — админ (боты создателями не бывают) =====
  n := 0;
  perform pg_temp.login(adm); r := public.bluff_create(0, 2, 0, true);
  perform public.bluff_add_bot(r); perform public.bluff_add_bot(r);
  update public.bluff_players set joined_at = joined_at - interval '1 minute' where room_id = r and bot_name is null;
  if pg_temp.bf_host(r, adm) = adm and (public.bluff_view(r) ->> 'creator')::boolean then n := n + 1; end if;
  perform public.bluff_start(r);
  if (select status from public.bluff_rooms where id = r) = 'play' then n := n + 1; end if;
  perform public.bluff_leave(r);
  perform pg_temp.login(adm); r := public.durak_create(0, true);
  perform public.durak_add_bot(r);
  perform public.durak_start(r);
  if (select status from public.durak_rooms where id = r) in ('choose', 'play') then n := n + 1; end if;
  perform public.durak_leave(r);
  res := res || case when n = 3 then E'ok   4 тестовые комнаты с ботами: создатель — админ, «Начать» работает\n'
                     else E'FAIL 4 (' || n || E'/3)\n' end;

  -- ===== 5. Покер: создатель встал — создатель тот, кто сел следующим =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.poker_create(2, 10);
  perform pg_temp.login(u[2]); perform public.poker_sit(r, 10);
  perform pg_temp.login(u[3]); perform public.poker_sit(r, 10);
  if (select creator from public.poker_tables where id = r) = u[1] then n := n + 1; end if;
  perform pg_temp.login(u[1]); perform public.poker_leave(r);
  if (select creator from public.poker_tables where id = r) = u[2] then n := n + 1; end if;
  perform pg_temp.login(u[3]); perform public.poker_leave(r);           -- встал не создатель — ничего не меняется
  if (select creator from public.poker_tables where id = r) = u[2] then n := n + 1; end if;
  perform pg_temp.login(u[2]); perform public.poker_leave(r);           -- последний встал — стол закрыт, создатель остался
  if (select status || ':' || (creator = u[2]) from public.poker_tables where id = r) = 'closed:true' then n := n + 1; end if;
  res := res || case when n = 4 then E'ok   5 Покер: создатель встал — создатель сел следующим; встал не создатель — без изменений; стол закрылся\n'
                     else E'FAIL 5 (' || n || E'/4)\n' end;

  -- ===== 6. Монеты сошлись, телефону новые таблица и функции закрыты =====
  n := 0;
  if (select sum(public.coins_of(y)) from unnest(u) y) = (select sum(z) from unnest(c0) z) then n := n + 1; end if;
  if not has_table_privilege('authenticated', 'public.card_seen', 'select')
     and not has_function_privilege('authenticated', 'public.durak_host_sync(bigint, uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.bluff_host(bigint, uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.card_seen_mark(text, bigint, uuid)', 'execute') then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   6 монеты четверых сошлись; таблица card_seen и новые функции телефону закрыты\n'
                     else E'FAIL 6 (' || n || E'/2)\n' end;

  raise exception E'\n%', res;
end $test$;
