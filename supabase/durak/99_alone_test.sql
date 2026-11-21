-- ДУРАК: один в комнате минуту — комната закрывается (07_alone.sql). Самоотменяющийся тест: запускать одним запросом
-- вместе с миграцией; в конце тест падает — всё откатывается.
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.view(r bigint, u uuid) returns jsonb language plpgsql as $$
begin perform pg_temp.login(u); return public.durak_view(r); end $$;
create function pg_temp.st(r bigint) returns text language sql as $$ select status from public.durak_rooms where id = r $$;
create function pg_temp.back(r bigint, s integer) returns void language sql as $$
  update public.durak_rooms set alone_since = alone_since - make_interval(secs => s) where id = r $$;

do $test$
declare u uuid[]; adm uuid; n integer; res text := ''; r bigint; c numeric[]; v jsonb; i integer;
begin
  select array_agg(p.id order by p.created_at) into u from (
    select x.id, x.created_at from public.profiles x
     where not exists (select 1 from public.durak_players d join public.durak_rooms g on g.id = d.room_id
                        where d.user_id = x.id and d.place is null and g.status in ('open', 'ready', 'choose', 'play'))
       and not exists (select 1 from public.admins a where a.user_id = x.id)
     order by x.created_at limit 3) p;
  select a.user_id into adm from public.admins a
   where not exists (select 1 from public.durak_players d join public.durak_rooms g on g.id = d.room_id
                      where d.user_id = a.user_id and d.place is null and g.status in ('open', 'ready', 'choose', 'play')) limit 1;
  if cardinality(u) < 3 or adm is null then raise exception 'для теста нужно 3 свободных участника и админ'; end if;
  for i in 1..3 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 1000, 'game', 'test:durak-alone'); end loop;
  c := array(select public.coins_of(y) from unnest(u) y);

  -- ===== 1. Открыл комнату и ждёт один: 59 с — открыта; минута — закрыта, ставка вернулась, в журнале «alone» =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.durak_create(10);
  v := pg_temp.view(r, u[1]);
  if (v ->> 'alone_ms')::bigint = (extract(epoch from now() + interval '1 minute') * 1000)::bigint then n := n + 1; end if;
  if public.coins_of(u[1]) = c[1] - 10 then n := n + 1; end if;
  perform pg_temp.back(r, 59);
  if pg_temp.view(r, u[1]) ->> 'status' = 'open' then n := n + 1; end if;
  perform pg_temp.back(r, 2);                                        -- прошла минута и секунда
  v := pg_temp.view(r, u[1]);                                        -- телефон спросил комнату — она закрылась
  if v ->> 'status' = 'cancelled' and (v -> 'log' -> -1 ->> 'kind') = 'alone' and v -> 'my' = 'null'::jsonb then n := n + 1; end if;
  if public.coins_of(u[1]) = c[1] and not exists (select 1 from public.durak_players where room_id = r) then n := n + 1; end if;
  res := res || case when n = 5 then E'ok   1 один в новой комнате: 59 с — открыта, минута — закрыта (журнал «alone»), ставка вернулась\n'
                     else E'FAIL 1 (' || n || E'/5)\n' end;

  -- ===== 2. Зашёл второй — отсчёта нет; он вышел — новая минута с его выхода; закрывает и список комнат =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.durak_create(10);
  perform pg_temp.back(r, 50);
  perform pg_temp.login(u[2]); perform public.durak_join(r);
  if (select alone_since from public.durak_rooms where id = r) is null and (pg_temp.view(r, u[1]) ->> 'alone_ms') is null then n := n + 1; end if;
  update public.durak_rooms set created_at = created_at - interval '10 minutes' where id = r;   -- двое ждут 10 минут — открыта
  if pg_temp.view(r, u[2]) ->> 'status' = 'open' then n := n + 1; end if;
  perform pg_temp.login(u[2]); perform public.durak_leave(r);
  if (select alone_since from public.durak_rooms where id = r) = now() and public.durak_alone_at(r) = now() + interval '1 minute'
     and (pg_temp.view(r, u[3]) ->> 'alone_ms') is not null then n := n + 1; end if;   -- отсчёт видно и тому, кто не в комнате
  perform pg_temp.back(r, 61);
  perform pg_temp.login(u[3]); perform public.durak_list();          -- кто-то открыл список комнат
  if pg_temp.st(r) = 'cancelled' and public.coins_of(u[1]) = c[1] and public.coins_of(u[2]) = c[2] then n := n + 1; end if;
  res := res || case when n = 4 then E'ok   2 второй зашёл — отсчёта нет (10 минут вдвоём — открыта); вышел — минута с его выхода; закрыл список комнат\n'
                     else E'FAIL 2 (' || n || E'/4)\n' end;

  -- ===== 3. «Готов»: двое не успели — остался один, у него свежая минута (не закрывается сразу) =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.durak_create(10);
  perform pg_temp.login(u[2]); perform public.durak_join(r);
  perform pg_temp.login(u[3]); perform public.durak_join(r);
  perform pg_temp.login(u[1]); perform public.durak_start(r);
  update public.durak_rooms set deadline = now() - interval '5 seconds' where id = r;
  v := pg_temp.view(r, u[1]);                                        -- «Готов» просрочен: двое выходят, ставки им вернулись
  if v ->> 'status' = 'open' and (v ->> 'alone_ms')::bigint = (extract(epoch from now() + interval '1 minute') * 1000)::bigint then n := n + 1; end if;
  if public.coins_of(u[2]) = c[2] and public.coins_of(u[3]) = c[3] then n := n + 1; end if;
  perform pg_temp.login(u[1]); perform public.durak_leave(r);
  if pg_temp.st(r) = 'cancelled' and public.coins_of(u[1]) = c[1] then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   3 «Готов» не нажали двое — один остался в открытой комнате, у него новая минута\n'
                     else E'FAIL 3 (' || n || E'/3)\n' end;

  -- ===== 4. Игра началась — правило не действует; тестовая комната админа с ботами — тоже =====
  n := 0;
  perform pg_temp.login(u[1]); r := public.durak_create(0);
  perform pg_temp.login(u[2]); perform public.durak_join(r);
  perform pg_temp.login(u[1]); perform public.durak_start(r);
  perform pg_temp.login(u[2]); perform public.durak_ready(r);
  if pg_temp.st(r) in ('choose', 'play') and public.durak_alone_at(r) is null then n := n + 1; end if;
  perform pg_temp.login(u[2]); perform public.durak_leave(r);        -- вышел посреди игры — итог, комната закончена
  if pg_temp.st(r) = 'finished' then n := n + 1; end if;
  perform pg_temp.login(adm); r := public.durak_create(0, true);
  update public.durak_rooms set alone_since = now() - interval '5 minutes' where id = r;
  if public.durak_alone_at(r) is null and pg_temp.view(r, adm) ->> 'status' = 'open' then n := n + 1; end if;
  perform public.durak_add_bot(r);
  if pg_temp.view(r, adm) ->> 'status' = 'open' then n := n + 1; end if;
  perform pg_temp.login(adm); perform public.durak_leave(r);
  res := res || case when n = 4 then E'ok   4 игра идёт — отсчёта нет; тестовая комната админа (один и с ботом, 5 минут) — открыта\n'
                     else E'FAIL 4 (' || n || E'/4)\n' end;

  -- ===== 5. Монеты троих — как было =====
  res := res || case when (select sum(public.coins_of(y)) from unnest(u) y) = (select sum(z) from unnest(c) z)
                     then E'ok   5 монеты троих сошлись до копейки\n' else E'FAIL 5\n' end;

  raise exception E'\n%', res;
end $test$;
