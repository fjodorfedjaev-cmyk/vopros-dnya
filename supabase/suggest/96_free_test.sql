-- Тест бесплатного «Своего вопроса»: запускать одним запросом ВМЕСТЕ с 04_free.sql. В конце намеренно падает — всё откатывается.
do $test$
declare
  u1 uuid; adm uuid; e text; res text := ''; b0 numeric; sid bigint; s1 bigint; k integer; i integer; n integer;
begin
  select a.user_id into adm from public.admins a limit 1;
  -- участник, у которого меньше всего предложений на проверке
  select p.id into u1 from public.profiles p where p.id <> adm
   order by (select count(*) from public.suggestions x where x.user_id = p.id and x.status = 'pending'), p.created_at, p.id limit 1;
  k := (select count(*) from public.suggestions x where x.user_id = u1 and x.status = 'pending');
  -- монет ровно 0 — предлагать всё равно можно
  insert into public.points_ledger (user_id, amount, reason, ref) values (u1, - public.coins_of(u1), 'game', 'test:free');
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  b0 := public.coins_of(u1);

  -- 1. все три вида — без монет, в журнале монет ничего не появляется
  n := 0;
  if k <= 2 then
    select x.s_id into s1 from public.suggest_question('poll', 'Тестовый бесплатный выбор?', '["Раз", "Два", "Три", "Четыре"]'::jsonb) x;
    perform public.suggest_question('question', 'Тестовый бесплатный вопрос?');
    perform public.suggest_question('fill', 'Тестовая бесплатная фраза с ___ внутри');
    if public.coins_of(u1) = b0 and b0 < 1 then n := n + 1; end if;
    if not exists (select 1 from public.points_ledger l where l.user_id = u1 and l.reason = 'suggest' and l.created_at >= now() - interval '1 minute') then n := n + 1; end if;
  end if;
  res := res || case when n = 2 then E'ok   1 Вопрос, Слово и Выбор — бесплатно (даже с 0 монет), в журнале монет пусто\n'
                     else E'FAIL 1 (' || n || E'/2, на проверке было ' || k || E')\n' end;

  -- 2. на проверке 5 — шестое нельзя
  k := (select count(*) from public.suggestions x where x.user_id = u1 and x.status = 'pending');
  for i in k + 1 .. 5 loop perform public.suggest_question('question', 'Тестовый вопрос номер ' || i || ' про лимит?'); end loop;
  begin perform public.suggest_question('question', 'Тестовый шестой вопрос про лимит?'); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_limit' and (select count(*) from public.suggestions x where x.user_id = u1 and x.status = 'pending') = 5
                     then E'ok   2 на проверке 5 — шестое не принимается (sug_limit)\n' else E'FAIL 2 ' || e || E'\n' end;

  -- 3. отклонил одно — можно снова; за бесплатное при отказе ничего не начисляется
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform public.admin_review_suggestion(s1, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  begin perform public.suggest_question('question', 'Тестовый вопрос после проверки?'); e := 'ok'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'ok' and public.coins_of(u1) = b0 then E'ok   3 после отказа можно снова; за бесплатное при отказе ничего не вернулось\n'
                     else E'FAIL 3 ' || e || ' ' || public.coins_of(u1) || E'\n' end;

  -- 4. предложение, оплаченное раньше (100), при отказе возвращает 100
  insert into public.suggestions (user_id, kind, text, status) values (u1, 'question', 'Тестовый старый платный вопрос?', 'pending') returning id into sid;
  insert into public.points_ledger (user_id, amount, reason, ref) values (u1, -100, 'suggest', 'sug:' || sid);
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform public.admin_review_suggestion(sid, false);
  res := res || case when public.coins_of(u1) = b0 then E'ok   4 старое платное при отказе вернуло 100\n' else E'FAIL 4 ' || public.coins_of(u1) || E'\n' end;

  raise exception E'ТЕСТ ОТКАЧЕН (так и задумано):\n%', res;
end $test$;
