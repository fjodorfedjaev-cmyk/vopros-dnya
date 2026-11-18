-- ДУРАК, боты: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 02_bots.sql (01_durak.sql уже в базе).
-- Админ играет против ботов в тестовой комнате; время в тесте стоит, поэтому «прошло 1,5 секунды» изображаем,
-- сдвигая срок хода. В конце тест падает — всё откатывается.
do $test$
declare
  adm uuid; usr uuid; e text; res text := ''; n integer; i integer; step integer;
  rid bigint; rid2 bigint; rid3 bigint; v jsonb; me jsonb; b0 numeric; b1 numeric;
  g public.durak_rooms%rowtype; cards integer[]; total integer; bot_moves integer := 0; games integer := 0; done integer := 0; forced integer := 0;
begin
  select a.user_id into adm from public.admins a limit 1;
  select p.id into usr from public.profiles p where p.id not in (select a.user_id from public.admins a) order by p.created_at limit 1;
  if adm is null or usr is null then raise exception 'для теста нужны админ и ещё один участник'; end if;
  b0 := public.coins_of(adm); b1 := public.coins_of(usr);

  -- 1. Тестовую комнату может открыть только админ; ставка в ней всегда 0
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  n := 0;
  begin perform public.durak_create(0, true); exception when others then if sqlerrm = 'not_admin' then n := n + 1; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  rid := public.durak_create(500, true);
  if (select stake from public.durak_rooms where id = rid) = 0 and (select test from public.durak_rooms where id = rid) then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   1 тестовую комнату открывает только админ, ставка в ней 0\n' else E'FAIL 1 (' || n || E')\n' end;

  -- 2. Другим её не видно и в неё не зайти; боты — только админу
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  n := 0;
  if not exists (select 1 from jsonb_array_elements(public.durak_list()) x where (x->>'id')::bigint = rid) then n := n + 1; end if;
  begin perform public.durak_join(rid); exception when others then if sqlerrm = 'durak_gone' then n := n + 1; end if; end;
  begin perform public.durak_view(rid); exception when others then if sqlerrm = 'durak_gone' then n := n + 1; end if; end;
  begin perform public.durak_add_bot(rid); exception when others then if sqlerrm = 'not_admin' then n := n + 1; end if; end;
  res := res || case when n = 4 then E'ok   2 чужим тестовую комнату не видно, зайти и посадить бота нельзя\n' else E'FAIL 2 (' || n || E')\n' end;

  -- 3. Боты: до 4 штук (5 мест), убрать можно; ботов нет в профилях, «Участниках» и балансах
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  for i in 1..4 loop perform public.durak_add_bot(rid); end loop;
  n := 0;
  begin perform public.durak_add_bot(rid); exception when others then if sqlerrm = 'durak_full' then n := n + 1; end if; end;
  perform public.durak_remove_bot(rid, '00000000-0000-4000-8000-0000000000b4');
  v := public.durak_view(rid);
  if jsonb_array_length(v->'players') = 4 and (v->>'test')::boolean
     and (select count(*) from jsonb_array_elements(v->'players') x where (x->>'bot')::boolean and x->>'avatar' = '🤖') = 3 then n := n + 1; end if;
  if not exists (select 1 from public.profiles p where p.id in (select b.id from public.durak_bot_list() b))
     and not exists (select 1 from public.member_coins() m where m.user_id in (select b.id from public.durak_bot_list() b)) then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   3 боты: 5-й нельзя, убрать можно; в профилях и «Участниках» ботов нет\n' else E'FAIL 3 (' || n || E')\n' end;

  -- 4. «Начать»: боты готовы сразу — раздача без ожидания, боты уже выбрали открытые
  perform public.durak_start(rid);
  v := public.durak_view(rid);
  res := res || case when v->>'status' = 'choose' and (select count(*) from jsonb_array_elements(v->'players') x where (x->>'chosen')::boolean) = 3
                      and jsonb_array_length(v->'my'->'pick') = 6
    then E'ok   4 «Начать» с ботами — сразу раздача, боты выбрали открытые, ждём только тебя\n' else E'FAIL 4 ' || (v->>'status') || E'\n' end;

  -- 5. Партии против ботов: админ ходит младшей картой, боты — сами (через 1,5 с после начала своего хода)
  for k in 1..20 loop
    if k > 1 then
      rid := public.durak_rematch(rid);
      perform public.durak_start(rid);
    end if;
    games := games + 1;
    me := public.durak_view(rid)->'my';
    perform public.durak_choose(rid, array[(me->'pick'->>3)::int, (me->'pick'->>4)::int, (me->'pick'->>5)::int]);
    step := 0;
    loop
      select * into g from public.durak_rooms where id = rid;
      exit when g.status <> 'play' or step >= 2000;
      step := step + 1;
      if exists (select 1 from public.durak_players x where x.room_id = rid and x.seat = g.turn_seat and x.bot_name is not null) then
        update public.durak_rooms set deadline = now() + interval '28 seconds' where id = rid;   -- «прошло 2 секунды»
        v := public.durak_view(rid);
        bot_moves := bot_moves + 1;
      else
        v := public.durak_view(rid);
        me := v->'my';
        if me->>'src' = 'closed' then
          select array[t.n::int] into cards from public.durak_players x, unnest(x.closed) with ordinality t(c, n)
           where x.room_id = rid and x.user_id = adm and t.c is not null limit 1;
          perform public.durak_flip(rid, cards[1]);
        elsif jsonb_array_length(me->'playable') > 0 then
          if random() < 0.7 then cards := array[(me->'playable'->>0)::int];
          else cards := array[(me->'playable'->>floor(random() * jsonb_array_length(me->'playable'))::int)::int]; end if;
          perform public.durak_play(rid, cards);
        else
          perform public.durak_take(rid);
        end if;
      end if;
      select g2.bita + cardinality(g2.deck) + cardinality(g2.pile)
             + (select coalesce(sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null)) + cardinality(x.pick)), 0)
                  from public.durak_players x where x.room_id = rid)
        into total from public.durak_rooms g2 where g2.id = rid;
      if total <> 52 then raise exception 'карты потерялись: % (партия %, ход %)', total, k, step; end if;
    end loop;
    -- затянулась — админ дважды пропускает ход и выбывает; живых не осталось — партия заканчивается сразу
    if (select status from public.durak_rooms where id = rid) = 'play' then
      forced := forced + 1;
      for i in 1..60 loop
        exit when (select status from public.durak_rooms where id = rid) <> 'play';
        select * into g from public.durak_rooms where id = rid;
        if exists (select 1 from public.durak_players x where x.room_id = rid and x.seat = g.turn_seat and x.bot_name is not null) then
          update public.durak_rooms set deadline = now() + interval '28 seconds' where id = rid;
        else
          update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid;
        end if;
        perform public.durak_view(rid);
      end loop;
    end if;
    if (select status from public.durak_rooms where id = rid) = 'finished'
       and (select array_agg(place order by place) from public.durak_players where room_id = rid)
           = array(select generate_series(1, (select count(*)::int from public.durak_players where room_id = rid))) then
      done := done + 1;
    end if;
  end loop;
  res := res || case when done = games and bot_moves > 0
    then 'ok   5 ' || games || ' партий против ботов (подряд через «Ещё раз») — все закончились, места 1..N, боты ходили сами, карты на месте'
         || case when forced > 0 then ' (затянутых, доведённых пропусками: ' || forced || ')' else '' end || E'\n'
    else 'FAIL 5 закончено ' || done || ' из ' || games || E'\n' end;

  -- 5б. Админ дважды не ходит — выбывает последним; остались одни боты — партия сразу закончена
  rid := public.durak_rematch(rid);
  perform public.durak_start(rid);
  me := public.durak_view(rid)->'my';
  perform public.durak_choose(rid, array[(me->'pick'->>0)::int, (me->'pick'->>1)::int, (me->'pick'->>2)::int]);
  n := 0;
  for i in 1..20 loop
    select * into g from public.durak_rooms where id = rid;
    exit when g.status <> 'play';
    if exists (select 1 from public.durak_players x where x.room_id = rid and x.seat = g.turn_seat and x.bot_name is not null) then
      update public.durak_rooms set deadline = now() + interval '28 seconds' where id = rid;
    else
      update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid;
    end if;
    perform public.durak_view(rid);
  end loop;
  v := public.durak_view(rid);
  if v->>'status' = 'finished' and (v->'my'->>'place')::int = 4 and v->'my'->>'place' is not null
     and (select count(*) from jsonb_array_elements(v->'players') x where x->>'out' = 'last') = 3 then n := n + 1; end if;
  res := res || case when n = 1 then E'ok  5б админ выбыл по времени — с одними ботами партия сразу закончена, боты расставлены по картам\n'
                     else E'FAIL 5б ' || (v->>'status') || ' ' || coalesce(v->'my'->>'place', '-') || E'\n' end;

  -- 6. «Ещё раз» в тестовой — новая тестовая с теми же ботами; выход админа закрывает комнату (боты не остаются хозяевами)
  rid2 := public.durak_rematch(rid);
  v := public.durak_view(rid2);
  n := 0;
  if (v->>'test')::boolean and v->>'status' = 'open' and jsonb_array_length(v->'players') = 4 then n := n + 1; end if;
  perform public.durak_leave(rid2);
  if (select status from public.durak_rooms where id = rid2) = 'cancelled'
     and not exists (select 1 from public.durak_players x where x.room_id = rid2) then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   6 «Ещё раз» — те же боты; админ вышел — комната закрыта\n' else E'FAIL 6 (' || n || E')\n' end;

  -- 7. Монеты не тронуты; обычные комнаты работают как раньше (ставка, видна всем)
  n := 0;
  if public.coins_of(adm) = b0 and public.coins_of(usr) = b1 then n := n + 1; end if;
  insert into public.points_ledger (user_id, amount, reason, ref) values (adm, 1000, 'game', 'test:durak-bots');
  rid3 := public.durak_create(10);
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  if exists (select 1 from jsonb_array_elements(public.durak_list()) x where (x->>'id')::bigint = rid3 and not (x->>'test')::boolean) then n := n + 1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  begin perform public.durak_add_bot(rid3); exception when others then if sqlerrm = 'durak_gone' then n := n + 1; end if; end;
  if public.coins_of(adm) = b0 + 1000 - 10 then n := n + 1; end if;
  res := res || case when n = 4 then E'ok   7 монеты после игр с ботами не изменились; обычная комната видна всем, ботов туда не посадить\n'
                     else E'FAIL 7 (' || n || E')\n' end;

  -- 8. Ход бота нельзя вызвать с телефона
  set local role authenticated;
  e := '';
  begin perform public.durak_bot_move(rid, adm); e := 'зовёт'; exception when others then e := 'нет'; end;
  reset role;
  res := res || case when e = 'нет' then E'ok   8 ход бота с телефона не вызвать\n' else E'FAIL 8\n' end;

  raise exception E'\n%', res;
end $test$;
