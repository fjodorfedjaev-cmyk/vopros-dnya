-- КОМНАТЫ «3 МИНУТЫ»: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 01_start_3min.sql.
-- В конце тест намеренно падает — откатывается всё. «Время» двигаем, меняя created_at / alone_since / accepted_at.
do $test$
declare
  u1 uuid; u2 uuid; u3 uuid; e text; res text := ''; r bigint; b0 numeric; c0 numeric; v jsonb; n integer;
  function_ok boolean;
begin
  select p.id into u1 from public.profiles p order by p.created_at, p.id limit 1;
  select p.id into u2 from public.profiles p where p.id <> u1 order by p.created_at, p.id limit 1;
  select p.id into u3 from public.profiles p where p.id not in (u1, u2) order by p.created_at, p.id limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref) select x, 1000, 'game', 'test:3min' from unnest(array[u1, u2, u3]) x;
  b0 := public.coins_of(u1); c0 := public.coins_of(u2);

  -- 1. Дурак: двое в комнате 2 минуты — ещё открыта, закроется через 3 минуты с открытия
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  r := public.durak_create(10);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.durak_join(r);
  update public.durak_rooms set created_at = now() - interval '2 minutes' where id = r;
  v := public.durak_view(r);
  res := res || case when v->>'status' = 'open' and abs((v->>'alone_ms')::bigint - (extract(epoch from now() + interval '1 minute') * 1000)::bigint) < 2000
    then E'ok   1 Дурак: двое, 2 минуты — открыта, отсчёт до 3-й минуты\n' else E'FAIL 1 ' || coalesce(v->>'status', '-') || E'\n' end;

  -- 2. Дурак: 3 минуты без игры — закрыта (причина «expired»), ставки вернулись обоим
  update public.durak_rooms set created_at = now() - interval '3 minutes 1 second' where id = r;
  v := public.durak_view(r);
  res := res || case when v->>'status' = 'cancelled' and v->'log'->-1->>'kind' = 'expired' and public.coins_of(u1) = b0 and public.coins_of(u2) = c0
    then E'ok   2 Дурак: 3 минуты без игры — закрыта, «expired», ставки вернулись\n' else E'FAIL 2 ' || coalesce(v->>'status', '-') || ' ' || coalesce(v->'log'->-1->>'kind', '-') || E'\n' end;

  -- 3. Дурак: один минуту — как раньше («alone»)
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  r := public.durak_create(10);
  update public.durak_rooms set created_at = now() - interval '61 seconds', alone_since = now() - interval '61 seconds' where id = r;
  v := public.durak_view(r);
  res := res || case when v->>'status' = 'cancelled' and v->'log'->-1->>'kind' = 'alone' and public.coins_of(u1) = b0
    then E'ok   3 Дурак: один минуту — закрыта, «alone», ставка вернулась\n' else E'FAIL 3\n' end;

  -- 4. Дурак: закрывает и список комнат (смотрит третий)
  r := public.durak_create(10);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.durak_join(r);
  update public.durak_rooms set created_at = now() - interval '4 minutes' where id = r;
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  perform public.durak_list();
  res := res || case when (select status from public.durak_rooms where id = r) = 'cancelled' and public.coins_of(u1) = b0 and public.coins_of(u2) = c0
    then E'ok   4 Дурак: список комнат закрывает просроченную\n' else E'FAIL 4\n' end;

  -- 5. Дурак: тестовую комнату с ботами не трогает (тестовую открывает только админ)
  perform set_config('request.jwt.claims', json_build_object('sub', (select a.user_id from public.admins a limit 1), 'role', 'authenticated')::text, true);
  r := public.durak_create(0, true);
  update public.durak_rooms set created_at = now() - interval '10 minutes' where id = r;
  v := public.durak_view(r);
  res := res || case when v->>'status' = 'open' then E'ok   5 Дурак: тестовая комната живёт дольше 3 минут\n' else E'FAIL 5\n' end;
  perform public.durak_leave(r);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);

  -- 6. «Верю — не верю»: трое, 3 минуты без игры — закрыта («expired»), ставки вернулись
  r := public.bluff_create(10, 6, 2);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.bluff_join(r);
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  perform public.bluff_join(r);
  update public.bluff_rooms set created_at = now() - interval '2 minutes 50 seconds' where id = r;
  v := public.bluff_view(r);
  n := case when v->>'status' = 'open' then 1 else 0 end;
  update public.bluff_rooms set created_at = now() - interval '3 minutes 1 second' where id = r;
  v := public.bluff_view(r);
  res := res || case when n = 1 and v->>'status' <> 'open' and v->'log'->-1->>'kind' = 'expired' and public.coins_of(u1) = b0 and public.coins_of(u2) = c0
    then E'ok   6 Верю: 2:50 — открыта, 3:01 — закрыта, «expired», ставки вернулись\n' else E'FAIL 6 ' || coalesce(v->>'status', '-') || E'\n' end;

  -- 7. «Верю — не верю»: один минуту — «alone»
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  r := public.bluff_create(10, 6, 2);
  update public.bluff_rooms set created_at = now() - interval '61 seconds', alone_since = now() - interval '61 seconds' where id = r;
  v := public.bluff_view(r);
  res := res || case when v->>'status' <> 'open' and v->'log'->-1->>'kind' = 'alone' and public.coins_of(u1) = b0
    then E'ok   7 Верю: один минуту — «alone»\n' else E'FAIL 7\n' end;

  -- 8. Дуэль: вызов 2 минуты — ждёт; 3 минуты — истёк, ставка вернулась
  r := public.duel_create(u2, 10);
  update public.sector_duels set created_at = now() - interval '2 minutes' where id = r;
  perform public.duel_list();
  n := case when (select status from public.sector_duels where id = r) = 'invited' then 1 else 0 end;
  update public.sector_duels set created_at = now() - interval '3 minutes 1 second' where id = r;
  perform public.duel_list();
  res := res || case when n = 1 and (select status from public.sector_duels where id = r) = 'expired' and public.coins_of(u1) = b0
    then E'ok   8 Дуэль: вызов — 2 минуты ждёт, после 3 — отменён, ставка вернулась\n' else E'FAIL 8\n' end;

  -- 9. Дуэль: открытая комната — закрывает список у любого через 3 минуты
  r := public.duel_create(null, 10);
  update public.sector_duels set created_at = now() - interval '3 minutes 1 second' where id = r;
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  perform public.duel_list();
  res := res || case when (select status from public.sector_duels where id = r) = 'expired' and public.coins_of(u1) = b0
    then E'ok   9 Дуэль: открытая комната — через 3 минуты закрыта (у любого в списке), ставка вернулась\n' else E'FAIL 9\n' end;

  -- 10. Дуэль: принял, но «Готов» не нажали 3 минуты — отменена, обе ставки вернулись
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  r := public.duel_create(u2, 10);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.duel_respond(r, true);
  update public.sector_duels set accepted_at = now() - interval '2 minutes' where id = r;
  perform public.duel_list();
  n := case when (select status from public.sector_duels where id = r) = 'accepted' then 1 else 0 end;
  update public.sector_duels set accepted_at = now() - interval '3 minutes 1 second' where id = r;
  perform public.duel_list();
  res := res || case when n = 1 and (select status from public.sector_duels where id = r) = 'cancelled' and public.coins_of(u1) = b0 and public.coins_of(u2) = c0
    then E'ok   10 Дуэль: после «Принять» 3 минуты без «Готов» — отменена, обе ставки вернулись\n' else E'FAIL 10\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «3 МИНУТЫ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
