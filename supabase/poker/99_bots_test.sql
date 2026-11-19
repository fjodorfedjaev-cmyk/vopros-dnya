-- ПОКЕР: тестовый стол с ботами — самоотменяющийся тест (запускать вместе с 01_poker.sql, в конце всё откатывается).
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
create function pg_temp.err(p text) returns text language plpgsql as $$
begin execute p; return 'ok'; exception when others then return sqlerrm; end $$;

do $test$
declare
  adm uuid; u uuid[]; t bigint; t2 bigint; c0 numeric; i integer; k integer; n integer; res text := ''; e text;
  g public.poker_tables%rowtype; me public.poker_seats%rowtype; steps integer; hands integer := 0; bot_moves integer := 0;
  admin_moves integer := 0; busts integer := 0; bad integer := 0; note text := ''; v_call numeric; v jsonb; buy numeric; onT numeric;
begin
  select a.user_id into adm from public.admins a where not public.poker_busy(a.user_id, null) limit 1;
  select array_agg(p.id order by p.created_at) into u from (
    select x.id, x.created_at from public.profiles x where x.id <> adm and not public.poker_busy(x.id, null) order by x.created_at limit 3) p;
  if adm is null or cardinality(u) < 3 then raise exception 'для теста нужен админ и ещё 3 участника'; end if;
  for i in 1..3 loop insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 100000, 'game', 'test:poker-bots'); end loop;
  c0 := public.coins_of(adm);

  -- 1. Только админ; вход без монет; до 5 ботов; другим стол не виден
  n := 0;
  perform pg_temp.login(u[1]);
  if pg_temp.err('select public.poker_create(4, null, true)') = 'not_admin' then n := n + 1; end if;
  perform pg_temp.login(adm);
  t := public.poker_create(4, null, true);
  if public.coins_of(adm) = c0 and (select stack from public.poker_seats where table_id = t and user_id = adm) = 200 then n := n + 1; end if;
  for i in 1..5 loop perform public.poker_add_bot(t); end loop;
  if (select count(*) from public.poker_seats where table_id = t and left_at is null) = 6
     and pg_temp.err('select public.poker_add_bot(' || t || ')') = 'poker_full' then n := n + 1; end if;
  perform public.poker_remove_bot(t, '00000000-0000-4000-8000-0000000000c3');
  perform public.poker_add_bot(t);
  if (select count(*) from public.poker_seats where table_id = t and left_at is null and bot_name is not null) = 5 then n := n + 1; end if;
  perform pg_temp.login(u[1]);
  if pg_temp.err('select public.poker_sit(' || t || ', 100)') = 'poker_gone' and pg_temp.err('select public.poker_view(' || t || ')') = 'poker_gone'
     and not exists (select 1 from jsonb_array_elements(public.poker_list() -> 'tables') x where (x ->> 'id')::bigint = t) then n := n + 1; end if;
  -- тестовый стол не считается в лимите 3 столов
  for i in 1..3 loop perform pg_temp.login(u[i]); perform public.poker_create(1, 2); end loop;
  if (select count(*) from public.poker_tables where status <> 'closed' and not test) = 3 then n := n + 1; end if;
  for i in 1..3 loop perform pg_temp.login(u[i]); perform public.poker_leave((select table_id from public.poker_seats where user_id = u[i] and left_at is null)); end loop;
  res := res || case when n = 6 then E'ok   1 тестовый стол: только админ, без монет, 5 ботов, другим не виден, в лимит столов не входит\n'
                     else E'FAIL 1 (' || n || E'/6)\n' end;

  -- 2. 60 раздач против ботов: боты ходят сами через 1,5 с, вылетевший бот докупает, монеты админа не меняются
  perform pg_temp.login(adm);
  for k in 1..60 loop
    exit when not public.poker_deal(t);
    hands := hands + 1; steps := 0;
    while (select status from public.poker_tables where id = t) = 'play' and steps < 300 loop
      steps := steps + 1;
      select * into g from public.poker_tables where id = t;
      select * into me from public.poker_seats where table_id = t and left_at is null and seat = g.turn_seat;
      if me.bot_name is not null then
        update public.poker_tables set deadline = now() + interval '28 seconds' where id = t;   -- «прошло» 2 секунды
        perform public.poker_tick(t);
        bot_moves := bot_moves + 1;
      else
        v_call := greatest(g.cur_bet - me.bet, 0);
        e := pg_temp.err(format('select public.poker_act(%s, %L, %s)', t,
               case when random() < 0.15 and v_call > 0 then 'fold' when v_call > 0 then 'call' else 'check' end, 'null'));
        admin_moves := admin_moves + 1;
        if e <> 'ok' then bad := bad + 1; note := 'ход админа: ' || e; end if;
      end if;
      select coalesce(sum(buyin), 0),
             coalesce(sum(stack) filter (where left_at is null), 0) + coalesce(sum(cashout) filter (where left_at is not null), 0)
             + case when (select status from public.poker_tables where id = t) = 'play' then coalesce(sum(put) filter (where in_hand), 0) else 0 end
        into buy, onT from public.poker_seats where table_id = t;
      if buy <> onT then bad := bad + 1; note := 'фишки ' || buy || ' ≠ ' || onT; end if;
    end loop;
    if (select status from public.poker_tables where id = t) = 'play' then bad := bad + 1; note := 'раздача не закончилась'; end if;
    -- админ вылетел — стол ждёт, боты без него не играют; садится снова
    if not exists (select 1 from public.poker_seats where table_id = t and user_id = adm and left_at is null) then
      perform public.poker_tick(t);
      if (select status from public.poker_tables where id = t) <> 'open' then bad := bad + 1; note := 'после вылета админа стол не ждёт'; end if;
      perform public.poker_sit(t, 200);
      busts := busts + 1;
    end if;
  end loop;
  v := public.poker_view(t);
  if bad = 0 and hands = 60 and bot_moves > 100 and public.coins_of(adm) = c0
     and (select count(*) from public.poker_seats where table_id = t and left_at is null and bot_name is not null) = 5 then
    res := res || 'ok   2 ' || hands || ' раздач против 5 ботов: ботов ' || bot_moves || ' ходов, админа ' || admin_moves || E', фишки сходятся, монеты админа не изменились, боты докупают; админ вылетал ' || busts || E' раз — стол ждал, сел снова\n';
  else
    res := res || 'FAIL 2 (' || note || ', раздач ' || hands || ', ходов ботов ' || bot_moves || ', монеты ' || c0 || ' → ' || public.coins_of(adm) || E')\n';
  end if;

  -- 3. Админ уходит — стол закрывается, боты встают
  perform public.poker_leave(t);
  if (select status from public.poker_tables where id = t) = 'closed'
     and not exists (select 1 from public.poker_seats where table_id = t and left_at is null) and public.coins_of(adm) = c0 then
    res := res || E'ok   3 админ ушёл — тестовый стол закрылся, монеты админа те же\n';
  else res := res || E'FAIL 3\n'; end if;

  raise exception E'\n%', res;
end $test$;
