-- «ВЫБОР ДНЯ»: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 01_poll.sql и 02_questions.sql:
-- в конце тест намеренно падает — откатывается всё, включая сами изменения базы. Следов нет.
do $test$
declare
  u1 uuid; r record; r2 record; e text; res text := ''; n integer; streak_before integer; total_before integer;
  ledger_before integer; d date := public.today_tallinn();
begin
  -- участник, который сегодня ещё не выбирал
  select p.id into u1 from public.profiles p order by p.created_at, p.id limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);

  -- 1. 60 вопросов, у всех от 2 до 4 вариантов
  n := (select count(*) from public.poll_questions where active and jsonb_array_length(options) between 2 and 4);
  res := res || case when n = 60 then E'ok   1 60 вопросов, у каждого 2–4 варианта\n' else E'FAIL 1 ' || n || E'\n' end;

  -- 2. вопрос на сегодня один и тот же при повторном вызове, первый по порядку
  select * into r from public.ensure_today_poll();
  select * into r2 from public.ensure_today_poll();
  res := res || case when r.q_id = r2.q_id and r.q_day = d and jsonb_array_length(r.q_options) = 4
      and r.q_text = (select text from public.poll_questions where position = 1)
    then E'ok   2 вопрос дня выбран один раз: «' || r.q_text || E'»\n' else E'FAIL 2\n' end;

  -- 3. выбор даёт +15 монет и не меняет серию и счётчик ответов
  streak_before := public.streak_on(u1, d);
  select s.total_answers into total_before from public.member_stats() s where s.user_id = u1;
  ledger_before := (select count(*) from public.points_ledger where user_id = u1 and reason = 'streak');
  delete from public.answers where user_id = u1 and day = d and kind = 'poll';
  insert into public.answers (user_id, day, kind, body) values (u1, d, 'poll', '2');
  n := (select amount from public.points_ledger where user_id = u1 and reason = 'poll' and ref = d::text);
  res := res || case when n = 15 then E'ok   3a за выбор +15 монет\n' else E'FAIL 3a ' || coalesce(n::text, 'нет записи') || E'\n' end;
  res := res || case when public.streak_on(u1, d) = streak_before
      and (select s.total_answers from public.member_stats() s where s.user_id = u1) = total_before
      and (select count(*) from public.points_ledger where user_id = u1 and reason = 'streak') = ledger_before
    then E'ok   3b серия, счётчик ответов и бонусы за серию не изменились\n' else E'FAIL 3b\n' end;

  -- 4. изменить выбор можно, повторно монеты не начисляются
  update public.answers set body = '0' where user_id = u1 and day = d and kind = 'poll';
  n := (select count(*) from public.points_ledger where user_id = u1 and reason = 'poll' and ref = d::text);
  res := res || case when n = 1 then E'ok   4 выбор поменялся, монеты начислены один раз\n' else E'FAIL 4\n' end;

  -- 5. несуществующие варианты не принимаются
  begin update public.answers set body = '4' where user_id = u1 and day = d and kind = 'poll'; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  res := res || case when e = 'отказ' then E'ok   5a вариант «4» не принят\n' else E'FAIL 5a\n' end;
  begin update public.answers set body = 'привет' where user_id = u1 and day = d and kind = 'poll'; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  res := res || case when e = 'отказ' then E'ok   5b текст вместо номера не принят\n' else E'FAIL 5b\n' end;

  -- 6. вопрос и слово работают как раньше: +30
  n := (select count(*) from public.answers where kind in ('question', 'fill'));
  res := res || case when n > 0 then E'ok   6 старые ответы на месте (' || n || E')\n' else E'FAIL 6\n' end;

  -- 7. гость не может получить вопрос
  set local role anon;
  begin perform public.ensure_today_poll(); e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   7 гостю вопрос не выдаётся\n' else E'FAIL 7\n' end;

  -- 8. напрямую таблицы с вопросами не читаются (только через функцию)
  set local role authenticated;
  begin perform 1 from public.poll_questions limit 1; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   8 таблица вопросов закрыта от прямого чтения\n' else E'FAIL 8\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «ВЫБОРА ДНЯ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
