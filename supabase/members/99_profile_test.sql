-- МИНИ-ПРОФИЛЬ: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 02_member_profile.sql.
-- В конце тест намеренно падает — откатывается всё (и миграция тоже), следов нет.
do $test$
declare
  u1 uuid; u2 uuid; u3 uuid; r jsonb; b jsonb; s record; e text; res text := ''; n integer;
begin
  select p.id into u1 from public.profiles p order by p.created_at, p.id limit 1;
  select p.id into u2 from public.profiles p where p.id <> u1 order by p.created_at, p.id limit 1;
  select p.id into u3 from public.profiles p where p.id not in (u1, u2) order by p.created_at, p.id limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);

  -- 1. основное совпадает с профилем, member_stats и coins_of
  r := public.member_profile(u2);
  select * into s from public.member_stats() m where m.user_id = u2;
  res := res || case when r ->> 'user_id' = u2::text
      and r ->> 'name' is not distinct from (select display_name from public.profiles where id = u2)
      and r ->> 'color' is not distinct from (select color from public.profiles where id = u2)
      and r ->> 'avatar' is not distinct from (select avatar from public.profiles where id = u2)
      and r ->> 'zodiac' is not distinct from (select zodiac from public.profiles where id = u2)
      and (r ->> 'streak')::integer = coalesce(s.current_streak, 0) and (r ->> 'best_streak')::integer = coalesce(s.best_streak, 0)
      and (r ->> 'answers')::integer = coalesce(s.total_answers, 0) and (r ->> 'answered_today')::boolean = coalesce(s.answered_today, false)
      and (r ->> 'reactions')::integer = coalesce(s.reactions_received, 0)
      and (r ->> 'coins')::numeric = public.coins_of(u2)
      and r ? 'joined'
    then E'ok   1 имя, цвет, аватарка, знак, серия, ответы, «сегодня», реакции, монеты — как в базе\n' else E'FAIL 1\n' end;

  -- 2. карточки и витрина
  res := res || case when (r ->> 'cards')::integer = coalesce((select m.distinct_cards from public.cards_members() m where m.user_id = u2), 0)
      and (r ->> 'cards_total')::integer = (select count(*) from public.cards)
      and jsonb_array_length(r -> 'shelf') = (select count(*) from public.card_showcase where user_id = u2)
    then E'ok   2 собрано X из Y и витрина — как в базе\n' else E'FAIL 2\n' end;

  -- 3. рекорды игр — лучший зачтённый результат
  res := res || case when (r ->> 'sector_best')::integer is not distinct from (select max(g.score) from public.game_sessions g where g.user_id = u2 and g.game = 'sector' and g.valid)
      and (r ->> 'zigzag_best')::integer is not distinct from (select max(z.score) from public.zigzag_sessions z where z.user_id = u2 and z.valid)
      and (r -> 'durak' ->> 'games')::integer = (select count(*) from public.durak_players dp where dp.user_id = u2
            and exists (select 1 from public.durak_rooms x where x.id = dp.room_id and x.status = 'finished' and x.test = false))
    then E'ok   3 рекорды Сектора и Зигзага, партии в Дураке (без тестовых)\n' else E'FAIL 3\n' end;

  -- 4. дуэли: добавим законченные (откатятся) — u1 выиграл 2, u2 выиграл 1, одна ничья; и u2 выиграл у u3
  b := r;
  insert into public.sector_duels (p1, p2, stake, status, result, finished_at) values
    (u1, u2, 1, 'finished', 'p1', now()), (u2, u1, 1, 'finished', 'p2', now()), (u2, u1, 1, 'finished', 'p1', now()),
    (u1, u2, 1, 'finished', 'draw', now()), (u3, u2, 1, 'finished', 'p2', now()), (u1, u2, 1, 'cancelled', null, null);
  r := public.member_profile(u2);
  res := res || case when (r -> 'duels' ->> 'won')::integer = (b -> 'duels' ->> 'won')::integer + 2
      and (r -> 'duels' ->> 'lost')::integer = (b -> 'duels' ->> 'lost')::integer + 2
      and (r -> 'duels' ->> 'draw')::integer = (b -> 'duels' ->> 'draw')::integer + 1
    then E'ok   4 дуэли u2: +2 победы, +2 поражения, +1 ничья (отменённая не считается)\n' else E'FAIL 4 ' || (r -> 'duels')::text || E'\n' end;
  res := res || case when (r -> 'vs' ->> 'me')::integer = (b -> 'vs' ->> 'me')::integer + 2
      and (r -> 'vs' ->> 'them')::integer = (b -> 'vs' ->> 'them')::integer + 1
      and (r -> 'vs' ->> 'draw')::integer = (b -> 'vs' ->> 'draw')::integer + 1
    then E'ok   5 «между вами» глазами u1: 2 : 1, ничья +1\n' else E'FAIL 5 ' || coalesce((r -> 'vs')::text, 'пусто') || E'\n' end;

  -- 6. свой профиль — без «между вами»; несуществующий — пусто
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  r := public.member_profile(u2);
  res := res || case when r -> 'vs' = 'null'::jsonb and public.member_profile(gen_random_uuid()) is null
    then E'ok   6 свой профиль без «между вами», чужой id — пусто\n' else E'FAIL 6\n' end;

  -- 7. не участник и гость — нельзя
  n := 0;
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  begin perform public.member_profile(u2); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'not_member' then n := n + 1; end if;
  set local role anon;
  begin perform public.member_profile(u2); e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  if e = 'отказ' then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   7 не участнику и гостю — нельзя\n' else E'FAIL 7 (' || n || E' из 2)\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «МИНИ-ПРОФИЛЬ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
