-- ДУРАК: «Наблюдать» (08_watch.sql). Самоотменяющийся тест: запускать одним запросом вместе с миграцией;
-- в конце тест падает — всё откатывается.
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.view(r bigint, u uuid) returns jsonb language plpgsql as $$
begin perform pg_temp.login(u); return public.durak_view(r); end $$;
create function pg_temp.row(r bigint, u uuid) returns jsonb language plpgsql as $$
begin perform pg_temp.login(u); return (select x from jsonb_array_elements(public.durak_list()) x where (x ->> 'id')::bigint = r); end $$;

do $test$
declare u uuid[]; adm uuid; n integer; res text := ''; r bigint; t bigint; c numeric; v jsonb; w jsonb; i integer; e text;
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
  for i in 1..3 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 1000, 'game', 'test:durak-watch'); end loop;
  c := public.coins_of(u[3]);

  -- двое играют на 10, третий (u[3]) наблюдает
  perform pg_temp.login(u[1]); r := public.durak_create(10);
  perform pg_temp.login(u[2]); perform public.durak_join(r);
  perform pg_temp.login(u[1]); perform public.durak_start(r);
  perform public.durak_ready(r);
  perform pg_temp.login(u[2]); perform public.durak_ready(r);

  -- ===== 1. Выбор открытых: наблюдатель видит стол, но не свои/чужие карты на выбор =====
  n := 0;
  v := pg_temp.view(r, u[3]);
  if v ->> 'status' = 'choose' then n := n + 1; end if;
  if v -> 'my' = 'null'::jsonb and jsonb_array_length(v -> 'players') = 2 then n := n + 1; end if;
  if not exists (select 1 from jsonb_array_elements(v -> 'players') p where jsonb_typeof(p -> 'hand') <> 'number' or p ? 'pick') then n := n + 1; end if;
  if (pg_temp.row(r, u[3]) ->> 'watch')::boolean and not (pg_temp.row(r, u[1]) ->> 'watch')::boolean then n := n + 1; end if;
  res := res || case when n = 4 then E'ok   1 выбор открытых: наблюдатель видит стол без карт; в списке у него «Наблюдать», у игрока — нет\n'
                     else E'FAIL 1 (' || n || E'/4)\n' end;

  -- оба выбирают по три карты — игра началась
  for i in 1..2 loop
    v := pg_temp.view(r, u[i]);
    perform pg_temp.login(u[i]);
    perform public.durak_choose(r, array(select (x)::int from jsonb_array_elements_text(v -> 'my' -> 'pick') x limit 3));
  end loop;

  -- ===== 2. Игра: наблюдатель видит только то, что видят соперники =====
  n := 0;
  v := pg_temp.view(r, u[3]);
  w := pg_temp.view(r, u[1]);
  if v ->> 'status' = 'play' and v -> 'my' = 'null'::jsonb then n := n + 1; end if;
  -- то же, что видит соперник: игроки, стопка, колода (без своего блока my)
  if (v -> 'players') = (select jsonb_agg(p - 'me' || jsonb_build_object('me', false) order by (p ->> 'seat')::int) from jsonb_array_elements(w -> 'players') p)
     and v -> 'pile_top' = w -> 'pile_top' and v -> 'deck_n' = w -> 'deck_n' and v ->> 'turn' = w ->> 'turn' then n := n + 1; end if;
  -- закрытая карта, ушедшая в руку, наблюдателю не видна, а открывшему — видна
  update public.durak_rooms set log = log || jsonb_build_array(jsonb_build_object('i', 9999, 'kind', 'flip_take', 'seat', 1, 'cards', jsonb_build_array(7))) where id = r;
  v := pg_temp.view(r, u[3]);
  if not (v -> 'log' -> -1 ? 'cards') then n := n + 1; end if;
  w := pg_temp.view(r, (select user_id from public.durak_players where room_id = r and seat = 1));
  if w -> 'log' -> -1 ? 'cards' then n := n + 1; end if;
  -- наблюдатель не может ходить
  perform pg_temp.login(u[3]);
  begin perform public.durak_take(r); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e <> 'нет ошибки' then n := n + 1; end if;
  res := res || case when n = 5 then E'ok   2 игра: наблюдатель видит то же, что соперник; закрытая в руку — скрыта; ходить нельзя\n'
                     else E'FAIL 2 (' || n || E'/5)\n' end;

  -- ===== 3. Тестовую комнату админа наблюдать нельзя, и в списке её нет =====
  n := 0;
  perform pg_temp.login(adm); t := public.durak_create(0, true);
  perform public.durak_add_bot(t); perform public.durak_start(t);
  if (select status from public.durak_rooms where id = t) in ('choose', 'play') then n := n + 1; end if;
  if pg_temp.row(t, u[3]) is null then n := n + 1; end if;
  begin perform pg_temp.view(t, u[3]); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e like '%durak_gone%' then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   3 тестовая комната с ботами: в списке не видна, наблюдать нельзя\n'
                     else E'FAIL 3 (' || n || E'/3)\n' end;

  -- ===== 4. Второй вышел — игра окончена: итог виден наблюдателю; монеты наблюдателя не менялись =====
  n := 0;
  perform pg_temp.login(u[2]); perform public.durak_leave(r);
  v := pg_temp.view(r, u[3]);
  if v ->> 'status' = 'finished' and v -> 'my' = 'null'::jsonb and jsonb_array_length(v -> 'players') = 2 then n := n + 1; end if;
  if public.coins_of(u[3]) = c and not exists (select 1 from public.durak_players where room_id = r and user_id = u[3]) then n := n + 1; end if;
  if pg_temp.row(r, u[3]) is null then n := n + 1; end if;              -- законченная чужая игра в его «Истории» не появляется
  res := res || case when n = 3 then E'ok   4 итог виден наблюдателю; в комнату он не добавлен, монеты те же, в его истории игры нет\n'
                     else E'FAIL 4 (' || n || E'/3)\n' end;

  raise exception E'ТЕСТ ОТКАЧЕН (так и задумано):\n%', res;
end $test$;
