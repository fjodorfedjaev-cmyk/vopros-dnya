-- «ПРЕДЛОЖИТЬ СВОЙ ВОПРОС»: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 01_suggestions.sql
-- (и строкой insert into public.admins …). В конце тест намеренно падает — откатывается всё, следов нет.
do $test$
declare
  u1 uuid; poor uuid; adm uuid; e text; res text := ''; n integer; b0 numeric; b1 numeric;
  s_q bigint; s_f bigint; s_p bigint; t text; r record;
begin
  select a.user_id into adm from public.admins a limit 1;
  select p.id into u1 from public.profiles p where p.id <> adm order by p.created_at, p.id limit 1;
  select p.id into poor from public.profiles p where p.id not in (adm, u1) and public.coins_of(p.id) < 300 limit 1;

  -- тестовые монеты, чтобы точно хватило (откатятся вместе с тестом)
  insert into public.points_ledger (user_id, amount, reason, ref) values (u1, 1000, 'game', 'test:suggest');
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  b0 := public.coins_of(u1);

  -- 1. вопрос: списано 300, предложение ждёт проверки
  select x.s_id, x.s_balance into s_q, b1 from public.suggest_question('question', '  Какой   звук  самый бесячий на свете? ') x;
  res := res || case when b1 = b0 - 300 and (select status from public.suggestions where id = s_q) = 'pending'
      and (select text from public.suggestions where id = s_q) = 'Какой звук самый бесячий на свете?'
    then E'ok   1 вопрос отправлен, −300, лишние пробелы убраны\n' else E'FAIL 1 ' || b0 || ' → ' || b1 || E'\n' end;

  -- 2. тот же вопрос второй раз — не принят, монеты не списаны
  begin perform public.suggest_question('question', 'какой звук самый бесячий на свете?'); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_duplicate' and public.coins_of(u1) = b1 then E'ok   2 повтор не принят, монеты на месте\n' else E'FAIL 2 ' || e || E'\n' end;

  -- 3. слово: без пропуска — нельзя; «____» превращается в ___
  begin perform public.suggest_question('fill', 'Фраза совсем без пропуска'); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_need_blank' then E'ok   3a фраза без пропуска не принята\n' else E'FAIL 3a ' || e || E'\n' end;
  begin perform public.suggest_question('fill', 'Два ___ пропуска ___ нельзя'); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_need_blank' then E'ok   3b два пропуска не приняты\n' else E'FAIL 3b ' || e || E'\n' end;
  select x.s_id into s_f from public.suggest_question('fill', 'Тестовая фраза: идеальный выходной — это _____ и тишина.') x;
  res := res || case when (select text from public.suggestions where id = s_f) = 'Тестовая фраза: идеальный выходной — это ___ и тишина.'
    then E'ok   3c фраза принята, пропуск приведён к ___\n' else E'FAIL 3c\n' end;

  -- 4. выбор: нужно ровно 4 разных варианта
  begin perform public.suggest_question('poll', 'Тест: что лучше?', '["А","Б","В"]'::jsonb); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_bad_options' then E'ok   4a три варианта не приняты\n' else E'FAIL 4a ' || e || E'\n' end;
  begin perform public.suggest_question('poll', 'Тест: что лучше?', '["Чай","чай","Кофе","Сок"]'::jsonb); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_same_options' then E'ok   4b одинаковые варианты не приняты\n' else E'FAIL 4b ' || e || E'\n' end;
  begin perform public.suggest_question('poll', 'Тест: что лучше?', '["Чай","","Кофе","Сок"]'::jsonb); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_bad_options' then E'ok   4c пустой вариант не принят\n' else E'FAIL 4c ' || e || E'\n' end;
  select x.s_id into s_p from public.suggest_question('poll', 'Тест: что взять на необитаемый остров?', '[" Нож ","Книгу","Гитару","Друга"]'::jsonb) x;
  res := res || case when (select options from public.suggestions where id = s_p) = '["Нож","Книгу","Гитару","Друга"]'::jsonb
    then E'ok   4d выбор с 4 вариантами принят\n' else E'FAIL 4d\n' end;
  res := res || case when public.coins_of(u1) = b0 - 900 then E'ok   4e всего списано 900 за 3 предложения\n' else E'FAIL 4e\n' end;

  -- 5. не хватает монет — отказ, ничего не создано
  if poor is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', poor, 'role', 'authenticated')::text, true);
    n := (select count(*) from public.suggestions);
    begin perform public.suggest_question('question', 'Вопрос от того, у кого мало монет?'); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
    res := res || case when e = 'sug_not_enough' and (select count(*) from public.suggestions) = n
      then E'ok   5 без 300 монет предложить нельзя\n' else E'FAIL 5 ' || e || E'\n' end;
  else
    res := res || E'skip 5 нет участника с балансом меньше 300\n';
  end if;

  -- 6. не админ не видит очередь и не может одобрить
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  begin perform public.admin_suggestions(); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'not_admin' then E'ok   6a не админ не видит очередь\n' else E'FAIL 6a ' || e || E'\n' end;
  begin perform public.admin_review_suggestion(s_q, true); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'not_admin' then E'ok   6b не админ не может одобрить\n' else E'FAIL 6b ' || e || E'\n' end;

  -- 7. админ видит все три
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  n := (select count(*) from public.admin_suggestions() x where x.s_id in (s_q, s_f, s_p));
  res := res || case when n = 3 then E'ok   7 админ видит все 3 предложения\n' else E'FAIL 7 ' || n || E'\n' end;

  -- 8. одобрить вопрос с правкой текста: вопрос появился и стоит первым в очереди
  t := public.admin_review_suggestion(s_q, true, 'Какой звук самый бесячий?');
  select q.* into r from public.questions q where q.id = (select target_id from public.suggestions where id = s_q);
  res := res || case when t = 'approved' and r.text = 'Какой звук самый бесячий?' and r.active and r.position < 0
    then E'ok   8a вопрос одобрен с правкой и добавлен\n' else E'FAIL 8a\n' end;
  n := (select qs.id from public.questions qs where qs.active
        order by (select max(dq.day) from public.daily_questions dq where dq.question_id = qs.id) asc nulls first, qs.position asc
        limit 1);
  res := res || case when n = r.id then E'ok   8b он следующий в очереди вопросов дня\n' else E'FAIL 8b\n' end;

  -- 9. одобрить выбор: 4 варианта на месте, тоже первый в очереди
  perform public.admin_review_suggestion(s_p, true);
  select pq.* into r from public.poll_questions pq where pq.id = (select target_id from public.suggestions where id = s_p);
  n := (select pq.id from public.poll_questions pq where pq.active
        order by (select max(dp.day) from public.daily_polls dp where dp.poll_id = pq.id) asc nulls first, pq.position asc, pq.id asc
        limit 1);
  res := res || case when jsonb_array_length(r.options) = 4 and n = r.id then E'ok   9 выбор одобрен и следующий в очереди\n' else E'FAIL 9\n' end;

  -- 10. отклонить слово: монеты вернулись
  b1 := public.coins_of(u1);
  t := public.admin_review_suggestion(s_f, false);
  res := res || case when t = 'rejected' and public.coins_of(u1) = b1 + 300
      and not exists (select 1 from public.fill_prompts where text like 'Тестовая фраза%')
    then E'ok   10 отказ: +300 вернулись, фраза не добавлена\n' else E'FAIL 10\n' end;

  -- 11. второй раз проверить нельзя (и монеты второй раз не вернутся)
  begin perform public.admin_review_suggestion(s_f, false); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_reviewed' and public.coins_of(u1) = b1 + 300 then E'ok   11 повторная проверка не проходит\n' else E'FAIL 11 ' || e || E'\n' end;

  -- 12. автор видит статусы своих предложений
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  n := (select count(*) from public.my_suggestions() x
        where (x.s_id = s_q and x.s_status = 'approved') or (x.s_id = s_p and x.s_status = 'approved') or (x.s_id = s_f and x.s_status = 'rejected'));
  res := res || case when n = 3 then E'ok   12 в «Моих предложениях» верные статусы\n' else E'FAIL 12 ' || n || E'\n' end;

  -- 13. таблицы напрямую закрыты, гость ничего не может
  set local role authenticated;
  begin perform 1 from public.suggestions limit 1; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   13a таблица предложений закрыта от прямого чтения\n' else E'FAIL 13a\n' end;
  set local role anon;
  begin perform public.suggest_question('question', 'Вопрос от гостя без входа?'); e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   13b гость не может предложить\n' else E'FAIL 13b\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «СВОЙ ВОПРОС» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
