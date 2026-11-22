-- «ВЕРЮ — НЕ ВЕРЮ»: «Наблюдать» (03_watch.sql). Самоотменяющийся тест: запускать одним запросом вместе с миграцией;
-- в конце тест падает — всё откатывается.
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.view(r bigint, u uuid) returns jsonb language plpgsql as $$
begin perform pg_temp.login(u); return public.bluff_view(r); end $$;
create function pg_temp.row(r bigint, u uuid) returns jsonb language plpgsql as $$
begin perform pg_temp.login(u); return (select x from jsonb_array_elements(public.bluff_list()) x where (x ->> 'id')::bigint = r); end $$;

do $test$
declare u uuid[]; adm uuid; n integer; res text := ''; r bigint; t bigint; c numeric; v jsonb; w jsonb; i integer; e text; s integer; h integer[];
begin
  select array_agg(p.id order by p.created_at) into u from (
    select x.id, x.created_at from public.profiles x
     where not exists (select 1 from public.bluff_players d join public.bluff_rooms g on g.id = d.room_id
                        where d.user_id = x.id and d.place is null and g.status in ('open', 'ready', 'play'))
       and not exists (select 1 from public.admins a where a.user_id = x.id)
     order by x.created_at limit 4) p;
  select a.user_id into adm from public.admins a
   where not exists (select 1 from public.bluff_players d join public.bluff_rooms g on g.id = d.room_id
                      where d.user_id = a.user_id and d.place is null and g.status in ('open', 'ready', 'play')) limit 1;
  if cardinality(u) < 4 or adm is null then raise exception 'для теста нужно 4 свободных участника и админ'; end if;
  for i in 1..4 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 1000, 'game', 'test:bluff-watch'); end loop;
  c := public.coins_of(u[4]);

  -- трое играют на 10 (колода от шестёрки + 2 джокера), четвёртый (u[4]) наблюдает
  perform pg_temp.login(u[1]); r := public.bluff_create(10, 6, 2);
  perform pg_temp.login(u[2]); perform public.bluff_join(r);
  perform pg_temp.login(u[3]); perform public.bluff_join(r);
  perform pg_temp.login(u[1]); perform public.bluff_start(r);
  perform pg_temp.login(u[2]); perform public.bluff_ready(r);
  perform pg_temp.login(u[3]); perform public.bluff_ready(r);

  -- ===== 1. Игра: наблюдатель видит то же, что игроки, но без своей руки =====
  n := 0;
  v := pg_temp.view(r, u[4]);
  w := pg_temp.view(r, u[1]);
  if v ->> 'status' = 'play' and v -> 'my' = 'null'::jsonb and jsonb_array_length(v -> 'players') = 3 then n := n + 1; end if;
  if not exists (select 1 from jsonb_array_elements(v -> 'players') p where jsonb_typeof(p -> 'n') <> 'number' or p ? 'hand') then n := n + 1; end if;
  if (v -> 'players') = (select jsonb_agg(p - 'me' || jsonb_build_object('me', false) order by (p ->> 'seat')::int) from jsonb_array_elements(w -> 'players') p)
     and v -> 'log' = w -> 'log' and v ->> 'turn' = w ->> 'turn' and v ->> 'pile_n' = w ->> 'pile_n' then n := n + 1; end if;
  if (pg_temp.row(r, u[4]) ->> 'watch')::boolean and not (pg_temp.row(r, u[1]) ->> 'watch')::boolean then n := n + 1; end if;
  res := res || case when n = 4 then E'ok   1 игра: наблюдатель видит то же, что игроки, без своей руки; в списке у него «Наблюдать», у игрока — нет\n'
                     else E'FAIL 1 (' || n || E'/4)\n' end;

  -- ===== 2. Ход: после «положить» наблюдатель видит число карт и номинал, но не сами карты; ходить не может =====
  n := 0;
  s := (select turn_seat from public.bluff_rooms where id = r);
  h := (select hand[1:2] from public.bluff_players where room_id = r and seat = s);
  perform pg_temp.login((select user_id from public.bluff_players where room_id = r and seat = s));
  perform public.bluff_put(r, h, 9);
  v := pg_temp.view(r, u[4]);
  if (v ->> 'pile_n')::int = 2 and (v ->> 'claim')::int = 9 and (v ->> 'last_n')::int = 2 then n := n + 1; end if;
  if v::text not like '%"pile":%' and not exists (select 1 from jsonb_array_elements(v -> 'log') x where x ->> 'kind' = 'put' and x ? 'cards') then n := n + 1; end if;
  perform pg_temp.login(u[4]);
  begin perform public.bluff_call(r, 'trust'); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e <> 'нет ошибки' then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   2 после хода наблюдатель видит «+2 карты · девятки», но не сами карты; ходить нельзя\n'
                     else E'FAIL 2 (' || n || E'/3)\n' end;

  -- ===== 3. Тестовую комнату админа наблюдать нельзя, и в списке её нет =====
  n := 0;
  perform pg_temp.login(adm); t := public.bluff_create(0, 6, 0, true);
  perform public.bluff_add_bot(t); perform public.bluff_add_bot(t); perform public.bluff_start(t);
  if (select status from public.bluff_rooms where id = t) = 'play' then n := n + 1; end if;
  if pg_temp.row(t, u[4]) is null then n := n + 1; end if;
  begin perform pg_temp.view(t, u[4]); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e like '%bluff_gone%' then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   3 тестовая комната с ботами: в списке не видна, наблюдать нельзя\n'
                     else E'FAIL 3 (' || n || E'/3)\n' end;

  -- ===== 4. Игрок вышел — у него в списке «Наблюдать»; итог виден наблюдателю; монеты наблюдателя не менялись =====
  n := 0;
  perform pg_temp.login(u[3]); perform public.bluff_leave(r);
  if (select status from public.bluff_rooms where id = r) = 'play' and (pg_temp.row(r, u[3]) ->> 'watch')::boolean then n := n + 1; end if;
  perform pg_temp.login(u[2]); perform public.bluff_leave(r);           -- остался один — игра окончена
  v := pg_temp.view(r, u[4]);
  if v ->> 'status' = 'finished' and v -> 'my' = 'null'::jsonb then n := n + 1; end if;
  if public.coins_of(u[4]) = c and not exists (select 1 from public.bluff_players where room_id = r and user_id = u[4])
     and pg_temp.row(r, u[4]) is null then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   4 вышедший видит «Наблюдать»; итог виден наблюдателю; монеты те же, в его истории игры нет\n'
                     else E'FAIL 4 (' || n || E'/3)\n' end;

  raise exception E'ТЕСТ ОТКАЧЕН (так и задумано):\n%', res;
end $test$;
