-- Тест «Показывать автора» (05_show_author.sql): запускать одним запросом ВМЕСТЕ с миграцией. В конце намеренно падает — всё откатывается.
do $test$
declare
  u1 uuid; adm uuid; e text; res text := ''; n integer; k integer;
  sq_on bigint; sq_off bigint; sf_on bigint; sp_on bigint; s_rej bigint; s_pend bigint;
  tq_on integer; tq_off integer; tf_on integer; tp_on integer;
begin
  select a.user_id into adm from public.admins a limit 1;
  -- участник (не админ), у которого меньше всего предложений на проверке
  select p.id into u1 from public.profiles p where p.id <> adm
   order by (select count(*) from public.suggestions x where x.user_id = p.id and x.status = 'pending'), p.created_at, p.id limit 1;
  k := (select count(*) from public.suggestions x where x.user_id = u1 and x.status = 'pending');
  if k > 0 then raise exception 'для теста нужен участник без предложений на проверке'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);

  -- 1. без параметра (как старый сайт) — автор скрыт; с p_show_author — показан
  n := 0;
  select x.s_id into sq_off from public.suggest_question('question', 'Тестовый вопрос без автора?', null) x;
  select x.s_id into sq_on from public.suggest_question(p_kind => 'question', p_text => 'Тестовый вопрос с автором?', p_show_author => true) x;
  select x.s_id into sf_on from public.suggest_question('fill', 'Тестовая фраза с автором и ___ внутри', null, true) x;
  select x.s_id into sp_on from public.suggest_question('poll', 'Тестовый выбор с автором?', '["Раз", "Два", "Три", "Четыре"]'::jsonb, true) x;
  select x.s_id into s_pend from public.suggest_question('question', 'Тестовый вопрос с автором, ждёт?', null, true) x;
  if not (select show_author from public.suggestions where id = sq_off) then n := n + 1; end if;
  if (select bool_and(show_author) from public.suggestions where id in (sq_on, sf_on, sp_on, s_pend)) then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   1 без переключателя (и со старого сайта) — автор скрыт; включил — показан\n'
                     else E'FAIL 1 (' || n || E'/2)\n' end;

  -- 2. «Мои предложения» — с пометкой
  n := 0;
  if (select s_show_author from public.my_suggestions() where s_id = sq_on) and not (select s_show_author from public.my_suggestions() where s_id = sq_off) then n := n + 1; end if;
  res := res || case when n = 1 then E'ok   2 «Мои предложения»: видно, с автором или без\n' else E'FAIL 2\n' end;

  -- 3. админ видит пометку, но не автора (в ответе нет user_id)
  n := 0;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  if (select s_show_author from public.admin_suggestions() where s_id = sq_on) and not (select s_show_author from public.admin_suggestions() where s_id = sq_off) then n := n + 1; end if;
  if not exists (select 1 from pg_proc p, unnest(p.proargnames) a where p.proname = 'admin_suggestions' and p.pronamespace = 'public'::regnamespace and a like '%user%') then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   3 при проверке — пометка «с автором», самого автора админ не видит\n' else E'FAIL 3 (' || n || E'/2)\n' end;

  -- 4. одобрил — автор виден только у тех, где включено; ждущие и отклонённые — нет
  perform public.admin_review_suggestion(sq_on, true);
  perform public.admin_review_suggestion(sq_off, true);
  perform public.admin_review_suggestion(sf_on, true);
  perform public.admin_review_suggestion(sp_on, true);
  select target_id into tq_on from public.suggestions where id = sq_on;
  select target_id into tq_off from public.suggestions where id = sq_off;
  select target_id into tf_on from public.suggestions where id = sf_on;
  select target_id into tp_on from public.suggestions where id = sp_on;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  select x.s_id into s_rej from public.suggest_question('question', 'Тестовый вопрос с автором, отклонят?', null, true) x;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform public.admin_review_suggestion(s_rej, false);
  n := 0;
  if (select count(*) from public.sug_authors('question', array[tq_on, tq_off]) a) = 1
     and (select a.user_id from public.sug_authors('question', array[tq_on, tq_off]) a where a.target_id = tq_on) = u1 then n := n + 1; end if;
  if (select a.user_id from public.sug_authors('fill', array[tf_on]) a) = u1 then n := n + 1; end if;
  if (select a.user_id from public.sug_authors('poll', array[tp_on]) a) = u1 then n := n + 1; end if;
  if not exists (select 1 from public.sug_authors('fill', array[tq_on]) a) then n := n + 1; end if;           -- номер вопроса, но вид «Слово» — не путается
  if (select status from public.suggestions where id = s_pend) = 'pending' and (select status from public.suggestions where id = s_rej) = 'rejected' then n := n + 1; end if;
  res := res || case when n = 5 then E'ok   4 sug_authors: автор только у одобренных с «Показывать автора» (Вопрос, Слово, Выбор), виды не путаются\n'
                     else E'FAIL 4 (' || n || E'/5)\n' end;

  -- 5. не участник ничего не получает; старые функции закрыты
  n := 0;
  perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from public.sug_authors('question', array[tq_on]) a) then n := n + 1; end if;
  if not has_function_privilege('authenticated', 'public.suggest_question_old(text, text, jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.my_suggestions_old()', 'execute')
     and not has_function_privilege('authenticated', 'public.admin_suggestions_old()', 'execute')
     and has_function_privilege('authenticated', 'public.sug_authors(text, integer[])', 'execute')
     and not has_function_privilege('anon', 'public.sug_authors(text, integer[])', 'execute') then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   5 без входа — пусто; *_old закрыты, sug_authors — только для вошедших\n' else E'FAIL 5 (' || n || E'/2)\n' end;

  raise exception E'ТЕСТ ОТКАЧЕН (так и задумано):\n%', res;
end $test$;
