-- ДУРАК: самоотменяющийся тест. Запускать одним запросом вместе с новой миграцией «Дурака» (предыдущие уже в базе).
-- Часть 1 — правила по одному (раскладываем карты вручную), часть 2 — боты играют много партий
-- случайными, но честными ходами и после каждого хода проверяем, что ни одна карта не потерялась.
-- В конце тест падает — всё откатывается (и уведомления тоже не уходят).
do $test$
declare
  u uuid[]; nu integer; e text; res text := ''; n integer; i integer; k integer; step integer;
  rid bigint; rid2 bigint; v jsonb; me jsonb; b numeric[]; bb numeric;
  g public.durak_rooms%rowtype;
  cur uuid; cards integer[]; pos integer; total integer; dup integer; bad integer := 0;
  games integer := 0; finished integer := 0; steps_max integer := 0; steps_sum integer := 0;
  burns integer := 0; takes integer := 0; afks integer := 0; np integer; st integer; sum_pay numeric;
  fail_note text := ''; bots bigint[] := '{}'; forced integer := 0;
begin
  -- игроки: до 5 первых участников, которые сейчас не сидят в другой игре
  select array_agg(p.id order by p.created_at) into u from (
    select * from public.profiles x
     where not exists (select 1 from public.durak_players dp join public.durak_rooms dr on dr.id = dp.room_id
                        where dp.user_id = x.id and dp.place is null and dr.status not in ('finished', 'cancelled'))
     order by created_at limit 5) p;
  nu := cardinality(u);
  if nu < 3 then raise exception 'для теста нужно хотя бы 3 участника'; end if;
  for i in 1..nu loop
    insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 100000, 'game', 'test:durak');
  end loop;

  -- ===== 1. Правила карт: что надо побить и что можно положить =====
  -- карта = (достоинство − 2) × 4 + масть
  n := 0;
  if public.durak_need('{}') = 0 then n := n + 1; end if;
  if public.durak_need(array[(5-2)*4, (8-2)*4]) = 5 then n := n + 1; end if;           -- 8 на 5 → бить 5
  if public.durak_need(array[(8-2)*4]) = 8 then n := n + 1; end if;                     -- 8 на пустом столе — обычная 8
  if public.durak_need(array[(8-2)*4, (8-2)*4+1]) = 8 then n := n + 1; end if;
  if public.durak_need(array[(2-2)*4, (8-2)*4, (8-2)*4+1]) = 2 then n := n + 1; end if; -- 8, 8 на двойке → бить 2
  if public.durak_fits(3, 0) and public.durak_fits(2, 14) and public.durak_fits(2, 7) then n := n + 1; end if;
  if public.durak_fits(8, 14) and public.durak_fits(10, 13) and not public.durak_fits(8, 7) and not public.durak_fits(10, 7) then n := n + 1; end if;
  if public.durak_fits(5, 7) and public.durak_fits(7, 7) and not public.durak_fits(9, 7) and not public.durak_fits(14, 7) then n := n + 1; end if;
  if public.durak_fits(9, 9) and public.durak_fits(14, 9) and not public.durak_fits(5, 9) then n := n + 1; end if;
  if public.durak_fits(7, 14) and public.durak_fits(7, 13) and public.durak_fits(7, 8) and public.durak_fits(7, 7) then n := n + 1; end if;
  res := res || case when n = 10 then E'ok   1 правила: 2 и 7 на всё, после 7 → только 2–7, 8 невидимка (на пустом — обычная), 10 на всё кроме 7\n'
                     else E'FAIL 1 (' || n || E'/10)\n' end;

  -- ===== 2. Комната: ставки, вход, выход, ограничения =====
  b := array(select public.coins_of(x) from unnest(u) x);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  rid := public.durak_create(100);
  n := 0;
  begin perform public.durak_create(10); exception when others then if sqlerrm = 'durak_busy' then n := n + 1; end if; end;
  begin perform public.durak_start(rid); exception when others then if sqlerrm = 'durak_alone' then n := n + 1; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  begin perform public.durak_create(-1); exception when others then if sqlerrm = 'durak_bad_stake' then n := n + 1; end if; end;
  perform public.durak_join(rid);
  perform public.durak_join(rid);                       -- повторный вход ничего не меняет
  bb := public.coins_of(u[2]);
  perform public.durak_leave(rid);
  e := (public.coins_of(u[2]) = b[2])::text;
  perform public.durak_join(rid);
  begin perform public.durak_start(rid); exception when others then if sqlerrm = 'durak_gone' then n := n + 1; end if; end;
  res := res || case when n = 4 and e = 'true' and bb = b[2] - 100 and public.coins_of(u[1]) = b[1] - 100
                      and (select count(*) from public.durak_players where room_id = rid) = 2
    then E'ok   2 вход −100, выход — вернулось; вторая комната, «Начать» в одиночку и чужое «Начать» — отказ\n'
    else E'FAIL 2 (' || n || ',' || e || E')\n' end;

  -- ===== 3. Старт: «Готов», раздача, выбор открытых =====
  perform set_config('request.jwt.claims', json_build_object('sub', u[3], 'role', 'authenticated')::text, true);
  perform public.durak_join(rid);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  perform public.durak_start(rid);
  e := (select status from public.durak_rooms where id = rid);
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  perform public.durak_ready(rid);
  -- третий не нажал «Готов» за 30 секунд — выходит, ставка возвращается, игра начинается вдвоём
  update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid;
  v := public.durak_view(rid);
  me := v->'my';
  res := res || case when e = 'ready' and v->>'status' = 'choose' and jsonb_array_length(v->'players') = 2
                      and public.coins_of(u[3]) = b[3] and jsonb_array_length(me->'pick') = 6 and (v->>'deck_n')::int = 52 - 18
                      and (v->'players'->0->'open') = 'null'::jsonb
    then E'ok   3 «Готов»: не успел — вышел (ставка вернулась); раздача: 3 закрытые + 6 на выбор, колода 34\n'
    else E'FAIL 3 ' || e || ' ' || coalesce(v->>'status', '?') || E'\n' end;

  n := 0;
  begin perform public.durak_choose(rid, array[(me->'pick'->>0)::int, (me->'pick'->>1)::int]); exception when others then if sqlerrm = 'durak_bad_move' then n := n + 1; end if; end;
  begin perform public.durak_choose(rid, array[(me->'pick'->>0)::int, (me->'pick'->>1)::int, 99]); exception when others then if sqlerrm = 'durak_bad_move' then n := n + 1; end if; end;
  perform public.durak_choose(rid, array[(me->'pick'->>0)::int, (me->'pick'->>1)::int, (me->'pick'->>2)::int]);
  v := public.durak_view(rid);
  e := v->>'status';
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  me := public.durak_view(rid)->'my';
  -- пока u1 выбирает: открытые карты u2 (уже выбрал) видны, свои ещё нет
  v := public.durak_view(rid);
  if (select count(*) from jsonb_array_elements(v->'players') x
       where not (x->>'me')::boolean and case when jsonb_typeof(x->'open') = 'array' then jsonb_array_length(x->'open') else 0 end = 3) = 1
     and (select x->'open' from jsonb_array_elements(v->'players') x where (x->>'me')::boolean) = 'null'::jsonb then n := n + 1; end if;
  perform public.durak_choose(rid, array[(me->'pick'->>3)::int, (me->'pick'->>4)::int, (me->'pick'->>5)::int]);
  v := public.durak_view(rid);
  res := res || case when n = 3 and e = 'choose' and v->>'status' = 'play' and jsonb_array_length(v->'my'->'hand') = 3
                      and jsonb_array_length(v->'players'->0->'open') = 3 and v->>'turn' is not null
    then E'ok   4 выбор открытых: не 3 или чужая карта — отказ; выбравший сразу показывает открытые; выбрали оба — игра, рука 3\n'
    else E'FAIL 4 (' || n || ',' || e || E')\n' end;

  -- ===== 4. Ходы на разложенных вручную картах (двое: место 0 — u1, место 1 — u2) =====
  -- рука u1: 10♠, 5♠, 5♥; рука u2: К♠, Д♠, 3♠; стопка пустая, ходит u1
  update public.durak_players set seat = case when user_id = u[1] then 0 else 1 end where room_id = rid;
  update public.durak_players set hand = array[(10-2)*4, (5-2)*4, (5-2)*4+1] where room_id = rid and user_id = u[1];
  update public.durak_players set hand = array[(13-2)*4, (12-2)*4, (3-2)*4] where room_id = rid and user_id = u[2];
  update public.durak_rooms set turn_seat = 0, pile = '{}', deck = array[(4-2)*4, (4-2)*4+1, (6-2)*4, (6-2)*4+1, (6-2)*4+2], bita = 0 where id = rid;
  -- общее число карт держим в порядке: остальное «в бите»
  update public.durak_rooms gx set bita = 52 - cardinality(gx.deck) - (select sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null))) from public.durak_players x where x.room_id = rid) where id = rid;
  -- 10 — бита, тот же игрок ходит ещё раз и добирает до 3
  perform public.durak_play(rid, array[(10-2)*4]);
  v := public.durak_view(rid);
  n := 0;
  if (v->>'turn')::int = 0 and (v->>'pile_n')::int = 0 and jsonb_array_length(v->'my'->'hand') = 3 and (v->'log'->-1->>'burn') = 'true'
     and (v->'log'->-1->>'drew')::int = 1 and (v->'log'->-1->>'i')::int > (v->'log'->-2->>'i')::int then n := n + 1; end if;
  -- две пятёрки за раз, ход переходит к u2
  perform public.durak_play(rid, array[(5-2)*4, (5-2)*4+1]);
  v := public.durak_view(rid);
  if (v->>'turn')::int = 1 and (v->>'pile_n')::int = 2 then n := n + 1; end if;
  -- u2: тройку на пятёрку нельзя; чужой ход нельзя
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  begin perform public.durak_play(rid, array[(3-2)*4]); exception when others then if sqlerrm = 'durak_bad_move' then n := n + 1; end if; end;
  begin perform public.durak_take(rid); exception when others then if sqlerrm = 'durak_can_play' then n := n + 1; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  begin perform public.durak_play(rid, array[(4-2)*4]); exception when others then if sqlerrm = 'durak_not_turn' then n := n + 1; end if; end;
  res := res || case when n = 5 then E'ok   5 10 → бита и ещё ход (в журнале: добрал 1); две пятёрки за раз; 3 на 5 — нельзя; забрать, когда есть ход, — нельзя; чужой ход — нельзя\n'
                     else E'FAIL 5 (' || n || E'/5)\n' end;

  -- 8 — невидимка: u2 кладёт 8 на 5, u1 должен бить пятёрку
  update public.durak_players set hand = array[(8-2)*4, (12-2)*4, (3-2)*4] where room_id = rid and user_id = u[2];
  update public.durak_players set hand = array[(4-2)*4+3, (6-2)*4+3, (9-2)*4+3] where room_id = rid and user_id = u[1];
  update public.durak_rooms set deck = '{}' where id = rid;
  update public.durak_rooms gx set bita = 52 - cardinality(gx.pile) - (select sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null))) from public.durak_players x where x.room_id = rid) where id = rid;
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  perform public.durak_play(rid, array[(8-2)*4]);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  v := public.durak_view(rid);
  n := 0;
  if (v->>'need')::int = 5 and v->'my'->'playable' = jsonb_build_array((6-2)*4+3, (9-2)*4+3) and jsonb_array_length(v->'pile_top') = 2 then n := n + 1; end if;
  begin perform public.durak_play(rid, array[(4-2)*4+3]); exception when others then if sqlerrm = 'durak_bad_move' then n := n + 1; end if; end;
  perform public.durak_play(rid, array[(6-2)*4+3]);
  res := res || case when n = 2 and (select turn_seat from public.durak_rooms where id = rid) = 1
    then E'ok   6 восьмёрка на пятёрке: бить надо 5 (4 — нельзя, 6 — можно), видно карту под восьмёркой\n'
    else E'FAIL 6 (' || n || E')\n' end;

  -- 7: после семёрки только 2–7. Стопка: 7; у u2 рука 8, 10, Д — нечем ходить → забирает
  update public.durak_rooms set pile = array[(7-2)*4] where id = rid;
  update public.durak_players set hand = array[(8-2)*4+1, (10-2)*4+1, (12-2)*4+1] where room_id = rid and user_id = u[2];
  update public.durak_rooms gx set bita = 52 - cardinality(gx.pile) - (select sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null))) from public.durak_players x where x.room_id = rid) where id = rid;
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  v := public.durak_view(rid);
  n := 0;
  if v->'my'->'playable' = '[]'::jsonb and (v->'my'->>'can_take')::boolean then n := n + 1; end if;
  begin perform public.durak_play(rid, array[(10-2)*4+1]); exception when others then if sqlerrm = 'durak_bad_move' then n := n + 1; end if; end;
  perform public.durak_take(rid);
  v := public.durak_view(rid);
  if jsonb_array_length(v->'my'->'hand') = 4 and (v->>'pile_n')::int = 0 and (v->>'turn')::int = 0 then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   7 после семёрки 8 и 10 нельзя; нечем ходить — забрал стопку, следующий ходит на пустой стол\n'
                     else E'FAIL 7 (' || n || E')\n' end;

  -- 8: все 4 одного достоинства в стопке (не подряд) — бита и ещё ход
  update public.durak_rooms set pile = array[(9-2)*4, (3-2)*4+2, (9-2)*4+1, (9-2)*4+2], turn_seat = 0 where id = rid;
  update public.durak_players set hand = array[(9-2)*4+3, (13-2)*4+3, (14-2)*4+3] where room_id = rid and user_id = u[1];
  update public.durak_rooms gx set bita = 52 - cardinality(gx.pile) - (select sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null))) from public.durak_players x where x.room_id = rid) where id = rid;
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  bb := (select bita from public.durak_rooms where id = rid);
  perform public.durak_play(rid, array[(9-2)*4+3]);
  g := (select x from public.durak_rooms x where x.id = rid);
  res := res || case when g.turn_seat = 0 and cardinality(g.pile) = 0 and g.bita = bb + 5
    then E'ok   8 четвёртая девятка (в стопке 9, 3, 9, 9) — бита, ход снова свой\n' else E'FAIL 8\n' end;

  -- 9: забрал стопку — 4 одинаковые в руке уходят в биту (только они)
  update public.durak_rooms set pile = array[(6-2)*4, (6-2)*4+1, (14-2)*4], turn_seat = 0 where id = rid;
  update public.durak_players set hand = array[(6-2)*4+2, (6-2)*4+3, (4-2)*4] where room_id = rid and user_id = u[1];
  update public.durak_rooms gx set bita = 52 - cardinality(gx.pile) - (select sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null))) from public.durak_players x where x.room_id = rid) where id = rid;
  bb := (select bita from public.durak_rooms where id = rid);
  perform public.durak_take(rid);
  v := public.durak_view(rid);
  res := res || case when v->'my'->'hand' = jsonb_build_array((4-2)*4, (14-2)*4) and (v->>'bita')::int = bb + 4
    then E'ok   9 забрал стопку с тремя шестёрками + своя — четыре шестёрки в биту, в руке 4 и Т\n' else E'FAIL 9 ' || (v->'my'->>'hand') || E'\n' end;

  -- 10: открытые и закрытые. У u1 рука пустая, колода пустая: ходит открытыми, закрытые — только после них
  update public.durak_rooms set pile = array[(11-2)*4], turn_seat = 0 where id = rid;
  update public.durak_players set hand = '{}', open = array[(12-2)*4+2, null, (12-2)*4+3], closed = array[(3-2)*4+3, (13-2)*4+2, null]
   where room_id = rid and user_id = u[1];
  update public.durak_rooms gx set bita = 52 - cardinality(gx.pile) - (select sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null))) from public.durak_players x where x.room_id = rid) where id = rid;
  n := 0;
  begin perform public.durak_flip(rid, 1); exception when others then if sqlerrm = 'durak_bad_move' then n := n + 1; end if; end;
  v := public.durak_view(rid);
  if v->'my'->>'src' = 'open' and jsonb_array_length(v->'my'->'playable') = 2 then n := n + 1; end if;
  -- со стола — только по одной, даже если одинаковые
  begin perform public.durak_play(rid, array[(12-2)*4+2, (12-2)*4+3]); exception when others then if sqlerrm = 'durak_bad_move' then n := n + 1; end if; end;
  perform public.durak_play(rid, array[(12-2)*4+2]);
  if (select open from public.durak_players where room_id = rid and user_id = u[1]) is not distinct from array[null, null, (12-2)*4+3]::integer[] then n := n + 1; end if;
  -- вторую даму убираем со стола (в биту), чтобы дальше u1 играл закрытыми
  update public.durak_players set open = array[null, null, null]::integer[] where room_id = rid and user_id = u[1];
  -- u2 кладёт короля, u1 открывает закрытую тройку — не подошла: забирает стопку (В, Д, К) вместе с ней — 4 карты
  update public.durak_players set hand = array[(13-2)*4+1, (5-2)*4+1, (5-2)*4+2] where room_id = rid and user_id = u[2];
  update public.durak_rooms gx set bita = 52 - cardinality(gx.pile) - (select sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null))) from public.durak_players x where x.room_id = rid) where id = rid;
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  perform public.durak_play(rid, array[(13-2)*4+1]);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  v := public.durak_view(rid);
  if v->'my'->>'src' = 'closed' and not (v->'my'->>'can_take')::boolean then n := n + 1; end if;
  begin perform public.durak_take(rid); exception when others then if sqlerrm = 'durak_bad_move' then n := n + 1; end if; end;
  perform public.durak_flip(rid, 1);
  v := public.durak_view(rid);
  if jsonb_array_length(v->'my'->'hand') = 4 and (v->>'pile_n')::int = 0 and v->'log'->-1->>'kind' = 'flip_take'
     and (v->'log'->-1->>'pos')::int = 1 and v->'log'->-1->'cards' = jsonb_build_array((3-2)*4+3) then n := n + 1; end if;
  -- соперник видит, что закрытая не подошла, но не видит, какая это карта
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  v := public.durak_view(rid);
  if v->'log'->-1->>'kind' = 'flip_take' and not (v->'log'->-1 ? 'cards') then n := n + 1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  res := res || case when n = 8 then E'ok  10 пока есть открытые — закрытую нельзя; со стола две дамы за раз — нельзя, по одной — можно; закрытая 3 на короля — забрал стопку вместе с ней, сопернику её не видно\n'
                     else E'FAIL 10 (' || n || E'/8)\n' end;

  -- 11: время. u2 не ходит: 1-й раз — база забирает стопку за него, 2-й раз подряд — выбывает на последнее место
  update public.durak_rooms set turn_seat = 1, pile = array[(14-2)*4+1] where id = rid;
  update public.durak_players set hand = array[(5-2)*4+1, (5-2)*4+2] where room_id = rid and user_id = u[2];
  update public.durak_rooms gx set bita = 52 - cardinality(gx.pile) - (select sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null))) from public.durak_players x where x.room_id = rid) where id = rid;
  update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid;
  v := public.durak_view(rid);
  n := 0;
  if v->'log'->-1->>'kind' = 'take' and (v->'log'->-1->>'auto')::boolean and (v->>'turn')::int = 0
     and (v->'players'->1->>'misses')::int = 1 then n := n + 1; end if;
  -- u1 ходит, снова очередь u2 — опять не ходит → выбывает, u1 — первое место, игра закончена
  select array[min(x)] into cards from unnest((select hand from public.durak_players where room_id = rid and user_id = u[1])) x;
  perform public.durak_play(rid, cards);
  update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid;
  v := public.durak_view(rid);
  if v->>'status' = 'finished' and (v->'players'->1->>'place')::int = 2 and v->'players'->1->>'out' = 'afk'
     and (v->'my'->>'place')::int = 1 and (v->'my'->>'payout')::numeric = 200 then n := n + 1; end if;
  if public.coins_of(u[1]) = b[1] + 100 and public.coins_of(u[2]) = b[2] - 100 and public.coins_of(u[3]) = b[3] then n := n + 1; end if;
  res := res || case when n = 3 then E'ok  11 время вышло: 1-й раз — стопку забрала база, 2-й раз подряд — выбыл последним; итог 200 / 0, баланс +100 / −100\n'
                     else E'FAIL 11 (' || n || E'/3)\n' end;

  -- 12: «Ещё раз» — новая комната с той же ставкой, второй игрок заходит в неё же
  rid2 := public.durak_rematch(rid);
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  n := 0;
  if public.durak_rematch(rid) = rid2 then n := n + 1; end if;
  v := public.durak_view(rid2);
  if v->>'status' = 'open' and (v->>'stake')::int = 100 and jsonb_array_length(v->'players') = 2 then n := n + 1; end if;
  v := public.durak_list();
  if exists (select 1 from jsonb_array_elements(v) x where (x->>'id')::bigint = rid2 and (x->>'mine')::boolean) then n := n + 1; end if;
  perform public.durak_leave(rid2);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  perform public.durak_leave(rid2);
  if (select status from public.durak_rooms where id = rid2) = 'cancelled' and public.coins_of(u[1]) = b[1] + 100 then n := n + 1; end if;
  res := res || case when n = 4 then E'ok  12 «Ещё раз»: одна новая комната на всех, та же ставка; все вышли — комната закрыта, ставки вернулись\n'
                     else E'FAIL 12 (' || n || E'/4)\n' end;

  -- 13: выплаты по местам втроём и впятером
  insert into public.durak_rooms (creator, stake, status) values (u[1], 100, 'play') returning id into rid;
  for i in 1..3 loop insert into public.durak_players (room_id, user_id, seat, stake, place) values (rid, u[i], i - 1, 100, i); end loop;
  perform public.durak_finish(rid);
  e := (select string_agg(payout::text, '/' order by place) from public.durak_players where room_id = rid);
  if nu >= 4 then
    insert into public.durak_rooms (creator, stake, status) values (u[1], 1, 'play') returning id into rid;
    for i in 1..4 loop insert into public.durak_players (room_id, user_id, seat, stake, place) values (rid, u[i], i - 1, 1, i); end loop;
    perform public.durak_finish(rid);
    e := e || ' ' || (select string_agg(payout::text, '/' order by place) from public.durak_players where room_id = rid);
  end if;
  res := res || case when e like '200.00/100.00/0.00%' and (nu < 4 or e like '% 2.01/1.33/0.66/0.00')
    then E'ok  13 выплаты: втроём 200/100/0; вчетвером при ставке 1 — 2,01/1,33/0,66/0 (сумма = банк)\n'
    else E'FAIL 13 ' || e || E'\n' end;

  -- ===== 5. Боты: много партий случайными честными ходами =====
  b := array(select public.coins_of(x) from unnest(u) x);
  for k in 1..60 loop
    games := games + 1;
    np := 2 + floor(random() * (nu - 1))::int;            -- 2..nu игроков
    st := (array[0, 1, 7, 100])[1 + floor(random() * 4)::int];
    perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
    rid := public.durak_create(st);
    bots := bots || rid;
    for i in 2..np loop
      perform set_config('request.jwt.claims', json_build_object('sub', u[i], 'role', 'authenticated')::text, true);
      perform public.durak_join(rid);
    end loop;
    perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
    perform public.durak_start(rid);
    for i in 2..np loop
      perform set_config('request.jwt.claims', json_build_object('sub', u[i], 'role', 'authenticated')::text, true);
      perform public.durak_ready(rid);
    end loop;
    -- выбор: случайные 3 из 6 (иногда — не успел, выбирает база)
    for i in 1..np loop
      if random() < 0.85 then
        perform set_config('request.jwt.claims', json_build_object('sub', u[i], 'role', 'authenticated')::text, true);
        me := public.durak_view(rid)->'my';
        cards := array(select (x)::int from jsonb_array_elements_text(me->'pick') x order by random() limit 3);
        perform public.durak_choose(rid, cards);
      end if;
    end loop;
    if (select status from public.durak_rooms where id = rid) = 'choose' then
      update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid;
      perform public.durak_tick(rid);
    end if;

    step := 0;
    loop
      select * into g from public.durak_rooms where id = rid;
      exit when g.status <> 'play' or step >= 3000;
      step := step + 1;
      select user_id into cur from public.durak_players where room_id = rid and seat = g.turn_seat;
      perform set_config('request.jwt.claims', json_build_object('sub', cur, 'role', 'authenticated')::text, true);
      v := public.durak_view(rid);
      me := v->'my';
      if random() < 0.02 then
        update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid;
        perform public.durak_tick(rid);
      elsif me->>'src' = 'closed' then
        select t.n into pos from public.durak_players x, unnest(x.closed) with ordinality t(c, n)
         where x.room_id = rid and x.user_id = cur and t.c is not null order by random() limit 1;
        perform public.durak_flip(rid, pos::int);
      elsif jsonb_array_length(me->'playable') > 0 then
        -- как живой игрок: чаще кладёт самую младшую подходящую карту, иногда — случайную
        if random() < 0.7 then i := (me->'playable'->>0)::int;
        else i := (me->'playable'->>floor(random() * jsonb_array_length(me->'playable'))::int)::int; end if;
        cards := array(select (x)::int from jsonb_array_elements_text(me->'playable') x where (x)::int / 4 = i / 4);
        if random() < 0.5 or me->>'src' = 'open' then cards := array[i]; end if;     -- иногда кладём одну из одинаковых; со стола — всегда одну
        perform public.durak_play(rid, cards);
      else
        perform public.durak_take(rid);
        takes := takes + 1;
      end if;
      -- проверка: все 52 карты на месте и ни одна не повторяется
      select g2.bita + cardinality(g2.deck) + cardinality(g2.pile)
             + (select coalesce(sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null)) + cardinality(x.pick)), 0)
                  from public.durak_players x where x.room_id = rid)
        into total from public.durak_rooms g2 where g2.id = rid;
      select count(*) - count(distinct c) into dup from (
        select unnest(deck || pile) c from public.durak_rooms where id = rid
        union all select unnest(array_remove(x.hand || x.open || x.closed || x.pick, null)) from public.durak_players x where x.room_id = rid) t;
      if total <> 52 or dup <> 0
         or exists (select 1 from public.durak_rooms g2, unnest(g2.pile) c where g2.id = rid group by c / 4 having count(*) >= 4)
         or exists (select 1 from public.durak_players x, unnest(x.hand) c where x.room_id = rid group by x.user_id, c / 4 having count(*) >= 4)
         or exists (select 1 from public.durak_players x where x.room_id = rid and x.place is not null and x.out_kind <> 'last'
                     and cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null)) > 0) then
        bad := bad + 1;
        if fail_note = '' then fail_note := 'партия ' || k || ', ход ' || step || ': карт ' || total || ', повторов ' || dup; end if;
        exit;
      end if;
    end loop;
    steps_max := greatest(steps_max, step); steps_sum := steps_sum + step;
    burns := burns + (select count(*) from public.durak_rooms g2, jsonb_array_elements(g2.log) x where g2.id = rid and x->>'burn' = 'true');
    afks := afks + (select count(*) from public.durak_players x where x.room_id = rid and x.out_kind = 'afk');
    select * into g from public.durak_rooms where id = rid;
    -- затянулась (боты ходят наугад) — доводим до конца пропусками хода: кто пропустил дважды, выбывает
    if g.status = 'play' then
      forced := forced + 1;
      for i in 1..40 loop
        exit when (select status from public.durak_rooms where id = rid) <> 'play';
        update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid;
        perform public.durak_tick(rid);
      end loop;
      select * into g from public.durak_rooms where id = rid;
    end if;
    if g.status = 'finished' then
      finished := finished + 1;
      select sum(payout) into sum_pay from public.durak_players where room_id = rid;
      if sum_pay <> st * np
         or (select array_agg(place order by place) from public.durak_players where room_id = rid) <> array(select generate_series(1, np))
         or exists (select 1 from public.durak_players x where x.room_id = rid
                     and x.payout <> floor(2.0 * st * (np - x.place) / (np - 1) * 100) / 100 + case when x.place = 1 then st * np - (select sum(floor(2.0 * st * (np - y.place) / (np - 1) * 100) / 100) from public.durak_players y where y.room_id = rid) else 0 end) then
        bad := bad + 1;
        if fail_note = '' then fail_note := 'партия ' || k || ': выплаты ' || sum_pay || ' из ' || st * np; end if;
      end if;
    end if;
  end loop;
  -- баланс каждого = было + сумма (выплата − ставка) по всем его партиям
  n := 0;
  for i in 1..nu loop
    if public.coins_of(u[i]) <> b[i] + (select coalesce(sum(x.payout - x.stake), 0) from public.durak_players x join public.durak_rooms g2 on g2.id = x.room_id
                                       where x.user_id = u[i] and g2.status = 'finished' and g2.id = any (bots)) then
      n := n + 1;
    end if;
  end loop;
  res := res || case when bad = 0 and finished = games and n = 0
    then 'ok  14 боты: ' || games || ' партий от 2 до ' || nu || ' игроков, все закончились; ходов в среднем ' || (steps_sum / games) || ', максимум ' || steps_max
         || '; забрали стопку ' || takes || ', выбыли по времени ' || afks
         || case when forced > 0 then ' (из них ' || forced || ' затянутых партий доведены до конца пропусками)' else '' end
         || E'; карты не терялись, выплаты = банк, балансы сошлись\n'
    else 'FAIL 14 закончено ' || finished || ' из ' || games || ', ошибок ' || bad || ', балансы ' || n || ' ' || fail_note || E'\n' end;

  -- 15: напрямую таблицы и чужие руки не прочитать, внутренние функции не вызвать
  set local role authenticated;
  e := '';
  begin perform 1 from public.durak_players limit 1; e := e || 'читает'; exception when others then e := e || 'нет'; end;
  begin perform public.durak_move(rid, u[1], 'take', null, null, true); e := e || ',зовёт'; exception when others then e := e || ',нет'; end;
  begin perform public.durak_finish(rid); e := e || ',зовёт'; exception when others then e := e || ',нет'; end;
  reset role;
  res := res || case when e = 'нет,нет,нет' then E'ok  15 таблицы и внутренние функции закрыты для телефона\n' else E'FAIL 15 ' || e || E'\n' end;

  -- 16: выход во время игры = поражение (последнее свободное место), карты уходят в биту, игра идёт дальше
  b := array(select public.coins_of(x) from unnest(u) x);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  rid := public.durak_create(100);
  for i in 2..3 loop
    perform set_config('request.jwt.claims', json_build_object('sub', u[i], 'role', 'authenticated')::text, true);
    perform public.durak_join(rid);
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  perform public.durak_start(rid);
  for i in 2..3 loop
    perform set_config('request.jwt.claims', json_build_object('sub', u[i], 'role', 'authenticated')::text, true);
    perform public.durak_ready(rid);
  end loop;
  for i in 1..3 loop
    perform set_config('request.jwt.claims', json_build_object('sub', u[i], 'role', 'authenticated')::text, true);
    me := public.durak_view(rid)->'my';
    perform public.durak_choose(rid, array[(me->'pick'->>0)::int, (me->'pick'->>1)::int, (me->'pick'->>2)::int]);
  end loop;
  select * into g from public.durak_rooms where id = rid;
  n := 0;
  -- выходит тот, кто сейчас не ходит: 3-е место, ход не меняется
  select user_id into cur from public.durak_players where room_id = rid and seat <> g.turn_seat order by seat limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', cur, 'role', 'authenticated')::text, true);
  perform public.durak_leave(rid);
  if (select place from public.durak_players where room_id = rid and user_id = cur) = 3
     and (select out_kind from public.durak_players where room_id = rid and user_id = cur) = 'left'
     and (select status from public.durak_rooms where id = rid) = 'play'
     and (select turn_seat from public.durak_rooms where id = rid) = g.turn_seat then n := n + 1; end if;
  select g2.bita + cardinality(g2.deck) + cardinality(g2.pile)
         + (select coalesce(sum(cardinality(x.hand) + cardinality(array_remove(x.open, null)) + cardinality(array_remove(x.closed, null)) + cardinality(x.pick)), 0)
              from public.durak_players x where x.room_id = rid)
    into total from public.durak_rooms g2 where g2.id = rid;
  if total = 52 then n := n + 1; end if;
  begin perform public.durak_leave(rid); exception when others then if sqlerrm = 'durak_gone' then n := n + 1; end if; end;
  if not exists (select 1 from jsonb_array_elements(public.durak_list()) x where (x->>'id')::bigint = rid) then n := n + 1; end if;
  -- выходит тот, кто ходит: 2-е место, но вышедший ставку теряет всегда — оставшийся забирает весь банк
  select user_id into cur from public.durak_players where room_id = rid and seat = g.turn_seat;
  perform set_config('request.jwt.claims', json_build_object('sub', cur, 'role', 'authenticated')::text, true);
  perform public.durak_leave(rid);
  if (select status from public.durak_rooms where id = rid) = 'finished'
     and (select string_agg(x.place || ':' || x.payout, ' ' order by x.place) from public.durak_players x where x.room_id = rid) = '1:300.00 2:0.00 3:0.00'
     and (select out_kind from public.durak_players where room_id = rid and user_id = cur) = 'left'
     and (public.coins_of(u[1]) - b[1]) + (public.coins_of(u[2]) - b[2]) + (public.coins_of(u[3]) - b[3]) = 0 then n := n + 1; end if;
  -- выход во время выбора открытых карт (вдвоём): второй сразу побеждает
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  rid := public.durak_create(0);
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  perform public.durak_join(rid);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  perform public.durak_start(rid);
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  perform public.durak_ready(rid);
  e := (select status from public.durak_rooms where id = rid);
  perform public.durak_leave(rid);
  if e = 'choose' and (select status from public.durak_rooms where id = rid) = 'finished'
     and (select place from public.durak_players where room_id = rid and user_id = u[1]) = 1
     and (select place from public.durak_players where room_id = rid and user_id = u[2]) = 2 then n := n + 1; end if;
  res := res || case when n = 6 then E'ok  16 «Выйти» во время игры: последнее свободное место, карты в биту, ход не сбился; ходящий вышел — итог 300/0/0 (вышедшие без выплаты); выход при выборе — второй победил\n'
                     else E'FAIL 16 (' || n || E'/6)\n' end;

  -- 17: не успел выбрать открытые — база кладёт три случайные из шести (не всегда старшие), рука — остальные три
  n := 0; k := 0;
  for i in 1..12 loop
    perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
    rid2 := public.durak_create(0);
    perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
    perform public.durak_join(rid2);
    perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
    perform public.durak_start(rid2);
    perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
    perform public.durak_ready(rid2);
    cards := (select pick from public.durak_players where room_id = rid2 and user_id = u[1]);
    update public.durak_rooms set deadline = now() - interval '1 minute' where id = rid2;
    perform public.durak_tick(rid2);
    if (select status from public.durak_rooms where id = rid2) = 'play'
       and (select cardinality(open) = 3 and cardinality(hand) = 3 and (open || hand) @> cards and cards @> (open || hand)
              from public.durak_players where room_id = rid2 and user_id = u[1]) then n := n + 1; end if;
    if not (select open @> array(select y from unnest(cards) y order by y desc limit 3)
              from public.durak_players where room_id = rid2 and user_id = u[1]) then k := k + 1; end if;   -- набор не «три старшие»
    perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
    perform public.durak_leave(rid2);
  end loop;
  res := res || case when n = 12 and k > 0 then E'ok  17 не успел выбрать — открытыми легли три случайные (не старшие в ' || k || E' из 12), рука — остальные\n'
                     else E'FAIL 17 (' || n || ', случайных ' || k || E')\n' end;

  raise exception E'\n%', res;
end $test$;
