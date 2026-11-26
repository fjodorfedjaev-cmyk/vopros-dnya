-- ПОКЕР: столы 0,05 / 0,10 … 100 / 200, стола 0,01 / 0,02 больше нет (05_levels.sql). Самоотменяющийся тест:
-- запускать одним запросом вместе с миграцией; в конце тест падает — всё откатывается.
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.err(q text) returns text language plpgsql as $$
begin execute q; return 'нет ошибки'; exception when others then return sqlerrm; end $$;

do $test$
declare
  u uuid[]; t bigint; n integer; res text := ''; g public.poker_tables%rowtype; i integer; c numeric; c2 numeric;
begin
  select array_agg(p.id order by p.created_at) into u from (
    select x.id, x.created_at from public.profiles x where not public.poker_busy(x.id, null)
       and not exists (select 1 from public.admins a where a.user_id = x.id) order by x.created_at limit 2) p;
  if cardinality(u) < 2 then raise exception 'для теста нужно 2 участника'; end if;
  -- столов может быть открыто не больше 3 — на время теста закрываем открытые (всё откатится)
  update public.poker_tables set status = 'closed', closed_at = now() where status <> 'closed' and not test;
  for i in 1..2 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 30000, 'game', 'test:poker-levels'); end loop;

  -- ===== 1. Уровни: 1 больше нет, 2…7 есть, 7 — это 100 / 200 =====
  n := 0;
  if not exists (select 1 from public.poker_level(1)) then n := n + 1; end if;
  if (select count(*) from generate_series(2, 7) l where exists (select 1 from public.poker_level(l))) = 6 then n := n + 1; end if;
  if (select sb = 100 and bb = 200 from public.poker_level(7)) then n := n + 1; end if;
  if not exists (select 1 from public.poker_level(8)) then n := n + 1; end if;
  res := res || case when n = 4 then E'ok   1 уровни: 0,01 / 0,02 нет; 0,05 / 0,10 … 25 / 50 и 100 / 200 есть; восьмого нет\n'
                     else E'FAIL 1 (' || n || E'/4)\n' end;

  -- ===== 2. Открыть стол 0,01 / 0,02 нельзя (и с ботами у админа тоже), 8-й — нельзя =====
  n := 0;
  perform pg_temp.login(u[1]);
  if pg_temp.err('select public.poker_create(1, 2)') = 'poker_bad_level' then n := n + 1; end if;
  if pg_temp.err('select public.poker_create(8, 100)') = 'poker_bad_level' then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   2 стол 0,01 / 0,02 и несуществующий уровень не открываются (poker_bad_level)\n'
                     else E'FAIL 2 (' || n || E'/2)\n' end;

  -- ===== 3. Стол 100 / 200: вход от 8 000 до 20 000, сел второй, оба встали — монеты как были =====
  n := 0;
  c := public.coins_of(u[1]) + public.coins_of(u[2]);
  if pg_temp.err('select public.poker_create(7, 7999.99)') = 'poker_bad_buyin' then n := n + 1; end if;
  if pg_temp.err('select public.poker_create(7, 20000.01)') = 'poker_bad_buyin' then n := n + 1; end if;
  t := public.poker_create(7, 8000);
  select * into g from public.poker_tables where id = t;
  if g.level = 7 and g.sb = 100 and g.bb = 200 then n := n + 1; end if;
  perform pg_temp.login(u[2]);
  if pg_temp.err('select public.poker_sit(' || t || ', 20000.01)') = 'poker_bad_buyin' then n := n + 1; end if;
  c2 := public.coins_of(u[2]);
  perform public.poker_sit(t, 20000);
  if public.coins_of(u[2]) = c2 - 20000 then n := n + 1; end if;
  perform public.poker_leave(t);
  perform pg_temp.login(u[1]); perform public.poker_leave(t);
  if public.coins_of(u[1]) + public.coins_of(u[2]) = c then n := n + 1; end if;
  res := res || case when n = 6 then E'ok   3 стол 100 / 200: вход 8 000–20 000, оба сели и встали — монеты сошлись\n'
                     else E'FAIL 3 (' || n || E'/6)\n' end;

  -- ===== 4. Старые столы с уровнем 1 (записаны раньше) по-прежнему читаются =====
  n := 0;
  insert into public.poker_tables (creator, level, sb, bb, status, closed_at) values (u[1], 1, 0.01, 0.02, 'closed', now()) returning id into t;
  if (select level from public.poker_tables where id = t) = 1 then n := n + 1; end if;
  if pg_temp.err('insert into public.poker_tables (creator, level, sb, bb) values (''' || u[1] || ''', 8, 1, 2)') like '%poker_tables_level_check%' then n := n + 1; end if;
  res := res || case when n = 2 then E'ok   4 старые столы уровня 1 остаются в базе; уровень 8 база не примет\n'
                     else E'FAIL 4 (' || n || E'/2)\n' end;

  raise exception E'\n%', res;
end $test$;
