-- «ЗИГЗАГ»: самоотменяющийся тест. В конце намеренно падает — всё откатывается, следов нет.
do $test$
declare
  u1 uuid; u2 uuid; sid uuid; sid2 uuid;
  r record; e text; res text := ''; n integer; sector_before bigint;
begin
  sector_before := (select count(*) from public.game_sessions);
  select id into u1 from public.profiles order by created_at, id limit 1;
  select id into u2 from public.profiles order by created_at, id offset 1 limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u1)::text, true);

  -- 1. честная партия: 10 очков, 40 плиток, 2 монеты (больше на 40 плитках не бывает), 20 секунд
  sid := public.zz_start();
  update public.zigzag_sessions set started_at = now() - interval '20 seconds' where id = sid;
  select * into r from public.zz_finish(sid, 10, 40, 2);
  n := (select count(*) from public.points_ledger where user_id = u1 and reason = 'game' and ref = 'zigzag:' || sid::text and amount = 2);
  res := res || case when r.valid and r.coins = 2 and r.best_all = 10 and n = 1
    then E'ok   1 честная партия: засчитана, 2 собранные монеты → +2 в общий журнал\n' else E'FAIL 1 ' || row_to_json(r)::text || E'\n' end;

  -- 2. повторное завершение той же партии
  begin perform public.zz_finish(sid, 10, 40, 2); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'already_finished' then E'ok   2 повторно завершить партию нельзя\n' else E'FAIL 2 ' || e || E'\n' end;

  -- 3. слишком быстро: 40 плиток за 2 секунды
  sid := public.zz_start();
  update public.zigzag_sessions set started_at = now() - interval '2 seconds' where id = sid;
  select * into r from public.zz_finish(sid, 10, 40, 2);
  res := res || case when not r.valid and r.coins = 0
      and not exists (select 1 from public.points_ledger where ref = 'zigzag:' || sid::text)
    then E'ok   3 слишком быстро — не засчитано, монет нет\n' else E'FAIL 3\n' end;

  -- 4. монет больше, чем помещается на 40 плитках (максимум 2)
  sid := public.zz_start();
  update public.zigzag_sessions set started_at = now() - interval '60 seconds' where id = sid;
  select * into r from public.zz_finish(sid, 10, 40, 3);
  res := res || case when not r.valid and r.coins = 0 then E'ok   4 3 монеты на 40 плитках — не засчитано\n' else E'FAIL 4\n' end;

  -- 5. очков больше, чем плиток
  sid := public.zz_start();
  update public.zigzag_sessions set started_at = now() - interval '60 seconds' where id = sid;
  select * into r from public.zz_finish(sid, 50, 40, 1);
  res := res || case when not r.valid then E'ok   5 очков больше, чем плиток — не засчитано\n' else E'FAIL 5\n' end;

  -- 6. 80 плиток, 3 монеты (ровно максимум); новый рекорд 25
  sid := public.zz_start();
  update public.zigzag_sessions set started_at = now() - interval '60 seconds' where id = sid;
  select * into r from public.zz_finish(sid, 25, 80, 3);
  res := res || case when r.valid and r.coins = 3 and r.best_all = 25 and r.prev_best = 10
    then E'ok   6 3 монеты на 80 плитках засчитаны, рекорд 10 → 25\n' else E'FAIL 6 ' || row_to_json(r)::text || E'\n' end;

  -- 7. рейтинг недели
  select * into r from public.zz_leaderboard('week') where user_id = u1;
  res := res || case when r.best = 25 and r.coins = 3 and r.rank >= 1
    then E'ok   7 в рейтинге недели: лучший счёт 25, 3 монеты\n' else E'FAIL 7\n' end;

  -- 8. чужая партия
  sid2 := public.zz_start();
  perform set_config('request.jwt.claims', json_build_object('sub', u2)::text, true);
  begin perform public.zz_finish(sid2, 1, 10, 0); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'bad_session' then E'ok   8 нельзя завершить чужую партию\n' else E'FAIL 8 ' || e || E'\n' end;

  -- 9. посторонний
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid())::text, true);
  begin perform public.zz_start(); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'not_member' then E'ok   9 посторонний не может начать партию\n' else E'FAIL 9 ' || e || E'\n' end;

  -- 10. права
  perform set_config('request.jwt.claims', json_build_object('sub', u1)::text, true);
  set local role authenticated;
  begin perform 1 from public.zigzag_sessions limit 1; e := 'нет ошибки'; exception when others then e := 'denied'; end;
  res := res || case when e = 'denied' then E'ok   10a таблица партий клиенту закрыта\n' else E'FAIL 10a\n' end;
  begin perform public.zz_leaderboard('all'); e := 'доступно'; exception when others then e := 'denied'; end;
  res := res || case when e = 'доступно' then E'ok   10b рейтинг игроку доступен\n' else E'FAIL 10b\n' end;
  reset role;
  set local role anon;
  begin perform public.zz_start(); e := 'нет ошибки'; exception when others then e := 'denied'; end;
  reset role;
  res := res || case when e = 'denied' then E'ok   10c гость не может начать партию\n' else E'FAIL 10c\n' end;

  -- 11. «Сектор» не затронут
  res := res || case when (select count(*) from public.game_sessions) = sector_before
    then E'ok   11 партии «Сектора» не затронуты (рейтинги отдельные)\n' else E'FAIL 11\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «ЗИГЗАГА» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
