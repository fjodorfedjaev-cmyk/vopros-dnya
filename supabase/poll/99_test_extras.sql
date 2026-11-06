-- ДОПОЛНИТЕЛЬНЫЕ «ВЫБОРЫ»: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 03_extras.sql.
-- В конце тест намеренно падает — откатывается всё, следов нет.
do $test$
declare
  adm uuid; u1 uuid; u2 uuid; e text; res text := ''; r record; n integer; b numeric; ans0 bigint;
  s1 bigint; s2 bigint; s3 bigint; sq bigint; t1 integer; t2 integer; t3 integer; d date := public.today_tallinn();
  tag text := floor(random() * 1000000)::text;
begin
  select a.user_id into adm from public.admins a limit 1;
  select p.id into u1 from public.profiles p where p.id <> adm order by p.created_at limit 1;
  select p.id into u2 from public.profiles p where p.id not in (adm, u1) order by p.created_at limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref) values (u1, 5000, 'game', 'test:pollx');
  ans0 := (select count(*) from public.answers);

  -- три «Выбора» и один «Вопрос» от u1
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  select s_id into s1 from public.suggest_question('poll', 'Тест А ' || tag || ': что лучше?', '["раз","два","три","четыре"]');
  select s_id into s2 from public.suggest_question('poll', 'Тест Б ' || tag || ': что лучше?', '["пять","шесть","семь","восемь"]');
  select s_id into s3 from public.suggest_question('poll', 'Тест В ' || tag || ': что лучше?', '["a","b","c","d"]');
  select s_id into sq from public.suggest_question('question', 'Тест вопрос ' || tag || ': норм ли так?');

  -- админ одобряет
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform public.admin_review_suggestion(s1, true);
  perform public.admin_review_suggestion(s2, true);
  perform public.admin_review_suggestion(s3, true);
  perform public.admin_review_suggestion(sq, true);
  select target_id into t1 from public.suggestions where id = s1;
  select target_id into t2 from public.suggestions where id = s2;
  select target_id into t3 from public.suggestions where id = s3;

  -- 1. «Выбор» уходит в очередь дополнительных со следующего дня, «Вопрос» — в общую очередь первым, как раньше
  res := res || case when (select count(*) from public.poll_questions where id in (t1, t2, t3) and extra_from = d + 1) = 3
      and (select position from public.questions where id = (select target_id from public.suggestions where id = sq)) < 0
    then E'ok   1 одобренный «Выбор» — в очередь дополнительных с завтра; «Вопрос» — как раньше\n' else E'FAIL 1\n' end;

  -- 2. сегодня их ещё нет; обычный «Выбор» дня не из них
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  res := res || case when not exists (select 1 from public.poll_extras_today() x where x.poll_id in (t1, t2, t3))
      and (select q_id from public.ensure_today_poll()) not in (t1, t2, t3)
    then E'ok   2 в день одобрения не появляются и обычный «Выбор» не заменяют\n' else E'FAIL 2\n' end;

  -- 3. «наступило завтра»: на день — не больше 2 дополнительных, по порядку одобрения
  update public.poll_questions set extra_from = d where id in (t1, t2, t3);
  delete from public.daily_poll_extras where day = d;  -- на случай, если сегодня уже были настоящие
  select count(*) into n from public.poll_extras_today();
  res := res || case when n = 2
      and (select poll_id from public.poll_extras_today() where slot = 2) = t1
      and (select poll_id from public.poll_extras_today() where slot = 3) = t2
      and not exists (select 1 from public.daily_poll_extras where poll_id = t3)
      and (select my_choice from public.poll_extras_today() where slot = 2) is null
      and (select votes from public.poll_extras_today() where slot = 2) is null
    then E'ok   3 сегодня 2 дополнительных (А и Б), третий ждёт следующего дня\n' else E'FAIL 3 (' || n || E')\n' end;

  -- 4. выбор: +15 один раз, поменять можно, голоса видны после выбора
  b := public.coins_of(u1);
  perform public.poll_extra_vote(d, 2, 1);
  perform public.poll_extra_vote(d, 2, 3);
  select * into r from public.poll_extras_today() where slot = 2;
  res := res || case when public.coins_of(u1) = b + 15 and r.my_choice = 3 and jsonb_array_length(r.votes) = 1
      and (r.votes -> 0 ->> 'choice') = '3'
    then E'ok   4 выбор: +15 один раз, поменять можно, свой голос виден\n' else E'FAIL 4\n' end;
  perform public.poll_extra_vote(d, 3, 0);
  res := res || case when public.coins_of(u1) = b + 30 then E'ok   5 второй дополнительный — ещё +15\n' else E'FAIL 5\n' end;

  -- 6. кто не выбрал — голосов не видит
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select * into r from public.poll_extras_today() where slot = 2;
  res := res || case when r.my_choice is null and r.votes is null then E'ok   6 до своего выбора голосов не видно\n' else E'FAIL 6\n' end;
  perform public.poll_extra_vote(d, 2, 0);
  select * into r from public.poll_extras_today() where slot = 2;
  res := res || case when jsonb_array_length(r.votes) = 2 then E'ok   7 после выбора видны оба голоса\n' else E'FAIL 7\n' end;

  -- 8. ошибки: чужой вариант, нет такого места, вчерашний день
  n := 0;
  begin perform public.poll_extra_vote(d, 2, 4); exception when others then if sqlerrm = 'bad_poll_choice' then n := n + 1; end if; end;
  begin perform public.poll_extra_vote(d, 2, -1); exception when others then if sqlerrm = 'bad_poll_choice' then n := n + 1; end if; end;
  begin perform public.poll_extra_vote(d, 4, 0); exception when others then if sqlerrm = 'poll_extra_gone' then n := n + 1; end if; end;
  begin perform public.poll_extra_vote(d - 1, 2, 0); exception when others then if sqlerrm = 'poll_day_over' then n := n + 1; end if; end;
  res := res || case when n = 4 then E'ok   8 вариант 5, место 4, вчерашний день — отказ\n' else E'FAIL 8 (' || n || E' из 4)\n' end;

  -- 9. на серию и ответы не влияет
  res := res || case when (select count(*) from public.answers) = ans0 then E'ok   9 таблица ответов (серия, счётчики) не тронута\n' else E'FAIL 9\n' end;

  -- 10. повторный вызов не добавляет третий, дополнительные не попадают в обычную очередь
  perform public.poll_extras_today();
  res := res || case when (select count(*) from public.daily_poll_extras where day = d) = 2
      and not exists (select 1 from public.daily_polls dp where dp.poll_id in (t1, t2, t3))
    then E'ok   10 больше 2 в день не бывает; в обычную очередь не попадают\n' else E'FAIL 10\n' end;

  -- 11. таблицы закрыты, гость не может
  set local role authenticated;
  begin perform 1 from public.poll_extra_votes limit 1; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  set local role anon;
  begin perform public.poll_extras_today(); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  reset role;
  res := res || case when e = 'отказ,отказ' then E'ok   11 голоса напрямую закрыты, гость не может\n' else E'FAIL 11 ' || e || E'\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «ДОПОЛНИТЕЛЬНЫЕ ВЫБОРЫ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
