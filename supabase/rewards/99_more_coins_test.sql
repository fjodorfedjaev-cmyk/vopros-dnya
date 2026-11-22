-- НАГРАДЫ БОЛЬШЕ (03_more_coins.sql): самоотменяющийся тест для рабочей базы — запускать одним запросом вместе
-- с миграцией. Ответы пишутся на выдуманный день (30.12.2099), «Выбор от друзей» — сегодня (своё место или то,
-- где участник ещё не голосовал), предложения — новые. В конце тест падает — всё откатывается (и push в очередь не уходит).
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.got(p uuid, p_reason text, p_ref text) returns integer language sql as $$
  select sum(amount)::integer from public.points_ledger where user_id = p and reason = p_reason and ref = p_ref $$;

do $test$
declare
  u uuid; adm uuid; d date := date '2099-12-30'; t date := public.today_tallinn(); res text := ''; n integer;
  pid integer; sid bigint; slot smallint; k integer; tag text := substr(md5(random()::text), 1, 8);
begin
  select a.user_id into adm from public.admins a limit 1;
  -- участник, который сегодня ещё не голосовал хотя бы в одном месте «Выбора от друзей» (или место свободно)
  select p.id into u from public.profiles p
   where not exists (select 1 from public.admins a where a.user_id = p.id)
     and exists (select 1 from unnest(array[2, 3]::smallint[]) s
                  where not exists (select 1 from public.poll_extra_votes v where v.user_id = p.id and v.day = t and v.slot = s))
   order by p.created_at limit 1;
  if u is null or adm is null then raise exception 'нужен участник и админ'; end if;

  -- ===== 1. Вопрос и Слово — по 50, Выбор — 30; серия считается как раньше =====
  n := 0;
  insert into public.answers (user_id, day, body, kind) values (u, d, 'тест', 'question');
  insert into public.answers (user_id, day, body, kind) values (u, d, 'тест', 'fill');
  if pg_temp.got(u, 'question', d::text) = 50 and pg_temp.got(u, 'fill', d::text) = 50 then n := n + 1; end if;
  insert into public.poll_questions (text, options, position, active) values ('тест ' || tag, '["а","б","в","г"]', 0, false) returning id into pid;
  insert into public.daily_polls (day, poll_id) values (d, pid);
  insert into public.answers (user_id, day, body, kind) values (u, d, '1', 'poll');
  if pg_temp.got(u, 'poll', d::text) = 30 then n := n + 1; end if;
  -- серия: ещё два дня подряд — третий день, бонус 40 (как раньше)
  insert into public.answers (user_id, day, body, kind) values (u, d + 1, 'тест', 'question');
  insert into public.answers (user_id, day, body, kind) values (u, d + 2, 'тест', 'question');
  if pg_temp.got(u, 'streak', '3:' || (d + 2)) = 40 and pg_temp.got(u, 'question', (d + 2)::text) = 50 then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   1 Вопрос дня и Слово дня — по 50, Выбор дня — 30; бонус за 3 дня подряд — 40, как был\n' else E'FAIL 1 (' || n || E'/3)\n' end;

  -- ===== 2. Дополнительный «Выбор» от друзей — 30 =====
  n := 0;
  select s into slot from unnest(array[2, 3]::smallint[]) s
   where not exists (select 1 from public.daily_poll_extras e where e.day = t and e.slot = s) limit 1;
  if slot is not null then
    insert into public.poll_questions (text, options, position, active) values ('тест2 ' || tag, '["а","б","в","г"]', 0, false) returning id into pid;
    insert into public.daily_poll_extras (day, slot, poll_id) values (t, slot, pid);
  else
    select e.slot into slot from public.daily_poll_extras e
     where e.day = t and not exists (select 1 from public.poll_extra_votes v where v.user_id = u and v.day = t and v.slot = e.slot) limit 1;
  end if;
  perform pg_temp.login(u);
  perform public.poll_extra_vote(t, slot, 0);
  perform public.poll_extra_vote(t, slot, 1);                            -- поменял выбор — второй раз не начисляется
  if pg_temp.got(u, 'poll', 'x' || slot || ':' || t) = 30 then n := n + 1; end if;
  res := res || case when n = 1 then E'ok   2 дополнительный «Выбор» — 30 (смена выбора не начисляет ещё раз)\n' else E'FAIL 2 (' || n || E'/1)\n' end;

  -- ===== 3. Сектор: 1 монета за 5 очков =====
  n := 0;
  if public.award_game_points(u, gen_random_uuid(), 23) = 4 and public.award_game_points(u, gen_random_uuid(), 4) = 0
     and public.award_game_points(u, gen_random_uuid(), 100) = 20 then n := n + 1; end if;
  res := res || case when n = 1 then E'ok   3 Сектор: 23 очка — 4 монеты, 4 очка — 0, 100 — 20\n' else E'FAIL 3 (' || n || E'/1)\n' end;

  -- ===== 4. Одобренное предложение — автору 20; отклонённое — ничего =====
  n := 0; k := 0;
  insert into public.suggestions (user_id, kind, text, status) values (u, 'question', 'Тестовый вопрос ' || tag || '?', 'pending') returning id into sid;
  perform pg_temp.login(adm);
  if public.admin_review_suggestion(sid, true) = 'approved' and pg_temp.got(u, 'suggest', 'sug:' || sid || ':ok') = 20 then k := k + 1; end if;
  insert into public.suggestions (user_id, kind, text, status) values (u, 'fill', 'Тестовое ___ слово ' || tag, 'pending') returning id into sid;
  if public.admin_review_suggestion(sid, true) = 'approved' and pg_temp.got(u, 'suggest', 'sug:' || sid || ':ok') = 20 then k := k + 1; end if;
  insert into public.suggestions (user_id, kind, text, options, status)
    values (u, 'poll', 'Тестовый выбор ' || tag || '?', '["раз","два","три","четыре"]', 'pending') returning id into sid;
  if public.admin_review_suggestion(sid, true) = 'approved' and pg_temp.got(u, 'suggest', 'sug:' || sid || ':ok') = 20 then k := k + 1; end if;
  if k = 3 then n := n + 1; end if;
  insert into public.suggestions (user_id, kind, text, status) values (u, 'question', 'Тестовый отказ ' || tag || '?', 'pending') returning id into sid;
  if public.admin_review_suggestion(sid, false) = 'rejected'
     and not exists (select 1 from public.points_ledger where user_id = u and reason = 'suggest' and ref like 'sug:' || sid || '%') then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   4 одобрено (Вопрос, Слово, Выбор) — автору по 20; отклонено — без монет\n' else E'FAIL 4 (' || n || E'/2)\n' end;

  raise exception E'\n%', res;
end $test$;
