-- Тест цены 100: запускать одним запросом ВМЕСТЕ с 02_price_100.sql. В конце намеренно падает — всё откатывается.
do $test$
declare
  u1 uuid; poor uuid; adm uuid; e text; res text := ''; b0 numeric; b1 numeric; sid bigint;
begin
  select a.user_id into adm from public.admins a limit 1;
  select p.id into u1 from public.profiles p where p.id <> adm order by p.created_at, p.id limit 1;

  insert into public.points_ledger (user_id, amount, reason, ref) values (u1, 1000, 'game', 'test:price');
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  b0 := public.coins_of(u1);

  -- 1. списывается ровно 100
  select x.s_id, x.s_balance into sid, b1 from public.suggest_question('question', 'Тестовый вопрос про цену сто монет?') x;
  res := res || case when b1 = b0 - 100
      and (select amount from public.points_ledger where ref = 'sug:' || sid and reason = 'suggest') = -100
    then E'ok   1 списано 100\n' else E'FAIL 1 ' || b0 || ' → ' || b1 || E'\n' end;

  -- 2. при отказе возвращаются те же 100
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform public.admin_review_suggestion(sid, false);
  res := res || case when public.coins_of(u1) = b0 then E'ok   2 отказ вернул 100\n' else E'FAIL 2 ' || public.coins_of(u1) || E'\n' end;

  -- 3. 99 монет — мало, 100 — хватает
  select p.id into poor from public.profiles p where p.id not in (adm, u1) order by p.created_at, p.id limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref) values (poor, 99 - public.coins_of(poor), 'game', 'test:price');
  perform set_config('request.jwt.claims', json_build_object('sub', poor, 'role', 'authenticated')::text, true);
  begin perform public.suggest_question('question', 'Тестовый вопрос от того, у кого 99?'); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'sug_not_enough' then E'ok   3a с 99 монетами нельзя\n' else E'FAIL 3a ' || e || E'\n' end;
  insert into public.points_ledger (user_id, amount, reason, ref) values (poor, 1, 'game', 'test:price2');
  begin perform public.suggest_question('question', 'Тестовый вопрос от того, у кого ровно сто?'); e := 'ok'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'ok' and public.coins_of(poor) = 0 then E'ok   3b со 100 монетами можно, баланс 0\n' else E'FAIL 3b ' || e || E'\n' end;

  raise exception E'ТЕСТ ОТКАЧЕН (так и задумано):\n%', res;
end $test$;
