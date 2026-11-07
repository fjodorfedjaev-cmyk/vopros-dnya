-- ДУЭЛИ: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 01_duels.sql.
-- Время внутри теста стоит на месте (now() — момент начала запроса), поэтому «прошедшее время»
-- изображаем, сдвигая start_at и created_at назад. В конце тест падает — всё откатывается.
do $test$
declare
  u1 uuid; u2 uuid; u3 uuid; e text; res text := ''; r record; n integer;
  d1 bigint; d2 bigint; d3 bigint; d4 bigint; d5 bigint; b1 numeric; b2 numeric;
begin
  select p.id into u1 from public.profiles p order by p.created_at limit 1;
  select p.id into u2 from public.profiles p where p.id <> u1 order by p.created_at limit 1;
  select p.id into u3 from public.profiles p where p.id not in (u1, u2) order by p.created_at limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref) values (u1, 1000, 'game', 'test:duel1'), (u2, 1000, 'game', 'test:duel2');
  b1 := public.coins_of(u1); b2 := public.coins_of(u2);

  -- 1. вызов: ставка уходит в банк, второй вызов тому же — нельзя, без денег — нельзя
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  d1 := public.duel_create(u2, 50);
  n := 0;
  begin perform public.duel_create(u2, 10); exception when others then if sqlerrm = 'duel_exists' then n := n + 1; end if; end;
  begin perform public.duel_create(u3, 99999); exception when others then if sqlerrm = 'duel_not_enough' then n := n + 1; end if; end;
  begin perform public.duel_create(u1, 10); exception when others then if sqlerrm = 'duel_bad_opponent' then n := n + 1; end if; end;
  begin perform public.duel_create(u3, 0); exception when others then if sqlerrm = 'duel_bad_stake' then n := n + 1; end if; end;
  res := res || case when public.coins_of(u1) = b1 - 50 and n = 4 and (select status from public.duel_state(d1)) = 'invited'
      and (select seed from public.duel_state(d1)) is null
    then E'ok   1 вызов: −50 в банк; повтор, без денег, сам себе, ставка 0 — отказ; зерно скрыто\n' else E'FAIL 1 (' || n || E')\n' end;

  -- 2. принять: ставка второго тоже в банк; «Готов» от обоих — старт, зерно открыто
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.duel_respond(d1, true);
  perform public.duel_ready(d1);
  select * into r from public.duel_state(d1);
  e := r.status;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform public.duel_ready(d1);
  select * into r from public.duel_state(d1);
  res := res || case when public.coins_of(u2) = b2 - 50 and e = 'accepted' and r.status = 'playing' and r.seed is not null
      and r.start_ms - r.server_ms between 3000 and 4500 and r.opp_name is not null and r.i_am_p1
    then E'ok   2 принял (−50), оба «Готов» → старт через 4 с, зерно открыто\n' else E'FAIL 2\n' end;

  -- 3. счёт во время игры виден сопернику; результат с телефона напрямую записать нельзя
  perform public.duel_progress(d1, 7);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  e := (select opp_progress::text from public.duel_state(d1));
  set local role authenticated;
  begin perform public.duel_store_result(d1, u2, 999, 999, 999, 'win', '[]', 0); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  begin perform 1 from public.sector_duels limit 1; e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  begin perform public.duel_secret(d1, u2); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  reset role;
  res := res || case when e = '7,отказ,отказ,отказ' then E'ok   3 счёт соперника виден; записать результат, прочитать таблицу и зерно напрямую — нельзя\n' else E'FAIL 3 ' || e || E'\n' end;

  -- 4. итог: первый проиграл с 10, второй обогнал (11) — победа и весь банк
  update public.sector_duels set start_at = now() - interval '60 seconds', p1_seen = now(), p2_seen = now() where id = d1;
  perform public.duel_store_result(d1, u1, 10, 10, 2, 'skip', '[1,2]', 40000);
  n := 0;
  begin perform public.duel_store_result(d1, u2, 10, 10, 9, 'win', '[1]', 45000); exception when others then if sqlerrm = 'duel_not_won' then n := n + 1; end if; end;
  select * into r from public.duel_store_result(d1, u2, 11, 11, 0, 'win', '[1]', 45000);
  res := res || case when n = 1 and r.status = 'finished' and r.outcome = 'win'
      and public.coins_of(u2) = b2 + 50 and public.coins_of(u1) = b1 - 50
    then E'ok   4 «победа» без обгона — отказ; обогнал 10 → 11: банк 100 победителю\n' else E'FAIL 4 (' || n || E')\n' end;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  res := res || case when (select outcome from public.duel_state(d1)) = 'lose' and (select opp_score from public.duel_state(d1)) = 11
    then E'ok   5 проигравший видит «lose» и счёт соперника\n' else E'FAIL 5\n' end;

  -- 6. ничья: счёт и PERFECT равные — ставки возвращаются
  b1 := public.coins_of(u1); b2 := public.coins_of(u2);
  d2 := public.duel_create(u2, 30);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.duel_respond(d2, true); perform public.duel_ready(d2);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform public.duel_ready(d2);
  update public.sector_duels set start_at = now() - interval '60 seconds', p1_seen = now(), p2_seen = now() where id = d2;
  perform public.duel_store_result(d2, u1, 15, 13, 2, 'miss', '[]', 30000);
  select * into r from public.duel_store_result(d2, u2, 15, 13, 2, 'skip', '[]', 30000);
  res := res || case when r.outcome = 'draw' and public.coins_of(u1) = b1 and public.coins_of(u2) = b2
    then E'ok   6 ничья (15 и 15, PERFECT поровну) — ставки вернулись\n' else E'FAIL 6\n' end;

  -- 7. пропал больше 20 секунд — проигрыш, даже если счёт был больше
  b1 := public.coins_of(u1); b2 := public.coins_of(u2);
  d3 := public.duel_create(u2, 20);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.duel_respond(d3, true); perform public.duel_ready(d3);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform public.duel_ready(d3);
  update public.sector_duels set start_at = now() - interval '90 seconds', p1_seen = now() - interval '40 seconds', p1_progress = 50, p2_seen = now() where id = d3;
  perform public.duel_store_result(d3, u2, 3, 3, 0, 'skip', '[]', 20000);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select * into r from public.duel_state(d3);
  res := res || case when r.status = 'finished' and r.outcome = 'win' and r.opp_end = 'forfeit' and public.coins_of(u2) = b2 + 20 and public.coins_of(u1) = b1 - 20
    then E'ok   7 соперник пропал (счёт 50) — победа у того, кто доиграл с 3\n' else E'FAIL 7\n' end;

  -- 8. свернул приложение (quit) — проигрыш
  b1 := public.coins_of(u1); b2 := public.coins_of(u2);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  d4 := public.duel_create(u2, 10);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.duel_respond(d4, true); perform public.duel_ready(d4);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform public.duel_ready(d4);
  update public.sector_duels set start_at = now() - interval '60 seconds', p1_seen = now(), p2_seen = now() where id = d4;
  perform public.duel_store_result(d4, u1, 40, 30, 10, 'quit', '[]', 20000);
  select * into r from public.duel_store_result(d4, u2, 2, 2, 0, 'miss', '[]', 10000);
  res := res || case when r.outcome = 'win' and public.coins_of(u2) = b2 + 10 then E'ok   8 свернул приложение (40 очков) — проиграл\n' else E'FAIL 8\n' end;

  -- 9. слишком рано: игра на 60 с не может закончиться через 1 с после старта
  d5 := public.duel_create(u2, 5);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.duel_respond(d5, true); perform public.duel_ready(d5);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform public.duel_ready(d5);
  update public.sector_duels set start_at = now() - interval '1 second' where id = d5;
  begin perform public.duel_store_result(d5, u1, 80, 60, 20, 'skip', '[]', 60000); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'duel_too_early' then E'ok   9 результат «из будущего» — отказ\n' else E'FAIL 9 ' || e || E'\n' end;

  -- 10. отказ, отмена и просрочка возвращают ставку; чужую дуэль не видно
  update public.sector_duels set status = 'cancelled' where id = d5;  -- (чтобы снова можно было вызвать того же)
  b1 := public.coins_of(u1);
  d5 := public.duel_create(u2, 25);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.duel_respond(d5, false);
  e := (select coins_of::text from public.coins_of(u1));
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  d5 := public.duel_create(u2, 25);
  perform public.duel_cancel(d5);
  d5 := public.duel_create(u2, 25);
  update public.sector_duels set created_at = now() - interval '25 hours' where id = d5;
  perform public.duel_list();
  n := (select count(*) from public.duel_list() where status = 'invited');
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  res := res || case when e::numeric = b1 and public.coins_of(u1) = b1 and n = 0
      and (select status from public.sector_duels where id = d5) = 'expired'
      and not exists (select 1 from public.duel_state(d1))
    then E'ok   10 отказ, отмена, просрочка — ставка вернулась; чужую дуэль не видно\n' else E'FAIL 10\n' end;

  -- 11. комнаты: открыл → любой может зайти (только один), себе нельзя; не больше 3; отмена и просрочка возвращают
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  b1 := public.coins_of(u1); b2 := public.coins_of(u2);
  d1 := public.duel_create(null, 40);
  n := 0;
  begin perform public.duel_join(d1); exception when others then if sqlerrm = 'duel_gone' then n := n + 1; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  e := (select count(*)::text from public.duel_list() where id = d1 and joinable and room);
  perform public.duel_join(d1);
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  begin perform public.duel_join(d1); exception when others then if sqlerrm = 'duel_gone' then n := n + 1; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  select * into r from public.duel_state(d1);
  res := res || case when e = '1' and n = 2 and r.status = 'accepted' and r.opp_id = u2
      and public.coins_of(u1) = b1 - 40 and public.coins_of(u2) = b2 - 40
    then E'ok   11 комната: в списке у других, зашёл один (−40 у обоих), второй и сам создатель — нельзя\n' else E'FAIL 11 (' || coalesce(e, '-') || ',' || n || E')\n' end;
  perform public.duel_cancel(d1);
  b1 := public.coins_of(u1);
  d2 := public.duel_create(null, 1); d3 := public.duel_create(null, 1); d4 := public.duel_create(null, 1);
  begin perform public.duel_create(null, 1); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  perform public.duel_cancel(d2);
  update public.sector_duels set created_at = now() - interval '25 hours' where id = d3;
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  perform public.duel_list();
  res := res || case when e = 'duel_too_many' and (select status from public.sector_duels where id = d3) = 'expired'
      and public.coins_of(u1) = b1 - 1
      and (select r2.opp_name from public.duel_list() r2 where r2.id = d4) is not null
    then E'ok   12 комнат не больше 3; отмена и просрочка вернули ставки; в чужой комнате видно, чья она\n' else E'FAIL 12 ' || e || E'\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «ДУЭЛИ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
