-- ПОКЕР: самоотменяющийся тест. Запускать одним запросом вместе с миграцией 01_poker.sql.
-- Часть 1 — правила по одному (карты и фишки раскладываем вручную), часть 2 — сотни случайных раздач,
-- после каждого хода проверяем, что фишки не появились и не пропали, а в конце — что монеты сошлись до копейки.
-- В конце тест падает — всё откатывается (и уведомления тоже не уходят).

-- помощники (живут только в этом запросе)
create function pg_temp.login(p uuid) returns text language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true) $$;
-- карта из записи: 'As' — туз пик, 'Th' — десятка червей, '9d', '2c' (масти: s ♠, h ♥, d ♦, c ♣)
create function pg_temp.c(p text) returns integer language sql immutable as $$
  select (strpos('23456789TJQKA', upper(substr(p, 1, 1))) - 1) * 4 + strpos('shdc', lower(substr(p, 2, 1))) - 1 $$;
create function pg_temp.cs(p text) returns integer[] language sql immutable as $$
  select array(select pg_temp.c(t.x) from unnest(string_to_array(p, ' ')) with ordinality t(x, n) order by t.n) $$;
create function pg_temp.ev(p text) returns integer language sql immutable as $$ select public.poker_eval(pg_temp.cs(p)) $$;
-- ход от имени игрока: 'ok' или текст ошибки
create function pg_temp.act(t bigint, u uuid, k text, x numeric default null) returns text language plpgsql as $$
begin
  perform pg_temp.login(u);
  perform public.poker_act(t, k, x);
  return 'ok';
exception when others then return sqlerrm;
end $$;
-- кто сейчас ходит
create function pg_temp.turn(t bigint) returns uuid language sql as $$
  select x.user_id from public.poker_seats x join public.poker_tables g on g.id = x.table_id
   where x.table_id = t and x.left_at is null and x.seat = g.turn_seat and g.status = 'play' $$;
create function pg_temp.seat_of(t bigint, u uuid) returns integer language sql as $$
  select x.seat from public.poker_seats x where x.table_id = t and x.user_id = u and x.left_at is null $$;
create function pg_temp.user_at(t bigint, s integer) returns uuid language sql as $$
  select x.user_id from public.poker_seats x where x.table_id = t and x.seat = s and x.left_at is null $$;
create function pg_temp.stack(t bigint, u uuid) returns numeric language sql as $$
  select x.stack from public.poker_seats x where x.table_id = t and x.user_id = u and x.left_at is null $$;
-- подложить карты: руки по местам {"0": "As Ah", …} и доска из 5 карт (сжигаемые — любые)
create function pg_temp.rig(t bigint, p_holes jsonb, p_board text) returns void language plpgsql as $$
declare b integer[] := pg_temp.cs(p_board);
begin
  update public.poker_seats x set hole = pg_temp.cs(p_holes ->> x.seat::text)
   where x.table_id = t and x.left_at is null and x.in_hand and p_holes ? x.seat::text;
  update public.poker_tables g set deck = array[51] || b[1:3] || array[50] || b[4:4] || array[49] || b[5:5] where g.id = t;
end $$;
-- проверка стола: фишки сходятся (принесли = на столе + унесли + в банке), нет минусов, ход у того, кто может ходить
create function pg_temp.inv(t bigint) returns text language plpgsql as $$
declare g public.poker_tables%rowtype; v_buy numeric; v_on numeric;
begin
  select * into g from public.poker_tables where id = t;
  select coalesce(sum(buyin), 0),
         coalesce(sum(stack) filter (where left_at is null), 0) + coalesce(sum(cashout) filter (where left_at is not null), 0)
         + case when g.status = 'play' then coalesce(sum(put) filter (where in_hand), 0) else 0 end
    into v_buy, v_on from public.poker_seats where table_id = t;
  if v_buy <> v_on then return 'фишки: принесли ' || v_buy || ', есть ' || v_on; end if;
  if exists (select 1 from public.poker_seats where table_id = t and (stack < 0 or bet < 0 or put < bet)) then return 'минус'; end if;
  if g.status = 'play' and not exists (select 1 from public.poker_seats x where x.table_id = t and x.left_at is null and x.seat = g.turn_seat
                                         and x.in_hand and not x.folded and not x.allin) then return 'ход у того, кто не может ходить'; end if;
  if g.status = 'play' and exists (select 1 from public.poker_seats x where x.table_id = t and x.in_hand and x.bet > g.cur_bet) then return 'ставка выше текущей'; end if;
  return null;
end $$;

do $test$
declare
  u uuid[]; nu integer; res text := ''; n integer; i integer; k integer; j integer; e text; t bigint; t2 bigint; t3 bigint;
  b numeric[]; v jsonb; g public.poker_tables%rowtype; s0 integer; s1 integer; s2 integer; cur uuid; x numeric;
  btn uuid; sbu uuid; bbu uuid; ua uuid; ub uuid; uc uuid; total0 numeric; total1 numeric;
  games integer := 0; hands integer := 0; acts integer := 0; bad integer := 0; fail_note text := ''; steps integer;
  showdowns integer := 0; sidepots integer := 0; splits integer := 0; afks integer := 0; leaves integer := 0; busts integer := 0;
  np integer; me public.poker_seats%rowtype; v_call numeric; r float8; v_to numeric; lvl integer; pick uuid;
begin
  -- игроки: до 6 первых участников, которые сейчас не сидят за столом
  select array_agg(p.id order by p.created_at) into u from (
    select * from public.profiles x where not public.poker_busy(x.id, null) order by created_at limit 6) p;
  nu := cardinality(u);
  if nu < 3 then raise exception 'для теста нужно хотя бы 3 участника'; end if;
  for i in 1..nu loop
    insert into public.points_ledger (user_id, amount, reason, ref) values (u[i], 100000, 'game', 'test:poker');
  end loop;

  -- ===== 1. Комбинации =====
  n := 0;
  if pg_temp.ev('As Ks Qs Js Ts 2c 3d') > pg_temp.ev('9h 8h 7h 6h 5h Ac Ad') then n := n + 1; end if;              -- роял > стрит-флеш
  if pg_temp.ev('5d 4d 3d 2d Ad Kc Kh') >> 20 = 8 and pg_temp.ev('5d 4d 3d 2d Ad Kc Kh') < pg_temp.ev('6c 5c 4c 3c 2c') then n := n + 1; end if; -- стрит-флеш с тузом снизу — младший
  if pg_temp.ev('9h 9d 9s 9c 2h') > pg_temp.ev('Ah Ad As Kc Kd') then n := n + 1; end if;                          -- каре > фулл-хаус
  if pg_temp.ev('Ah Ad As Kc Kd') > pg_temp.ev('Ah Qh 9h 4h 2h') then n := n + 1; end if;                          -- фулл-хаус > флеш
  if pg_temp.ev('2h 3h 5h 7h 9h') > pg_temp.ev('Ac Kd Qh Js Th') then n := n + 1; end if;                          -- флеш > стрит
  if pg_temp.ev('5c 4d 3h 2s Ah') >> 20 = 4 and pg_temp.ev('5c 4d 3h 2s Ah') < pg_temp.ev('6c 5d 4h 3s 2h') then n := n + 1; end if; -- стрит A-5 — самый младший
  if pg_temp.ev('Ac Kd Qh Js Th') > pg_temp.ev('7c 7d 7h As Kd') then n := n + 1; end if;                          -- стрит > тройка
  if pg_temp.ev('2c 2d 2h 3s 4d') > pg_temp.ev('Ac Ad Kh Ks Qd') then n := n + 1; end if;                          -- тройка > две пары
  if pg_temp.ev('Ac Ad Kh Ks Qd') > pg_temp.ev('Ac Ad Kh Ks Jd') then n := n + 1; end if;                          -- две пары: решает кикер
  if pg_temp.ev('Ac Ad Kh Ks Qd Qc 2h') = pg_temp.ev('Ac Ad Kh Ks Qd 3c 2h') then n := n + 1; end if;              -- третья пара — только кикер
  if pg_temp.ev('Ac Ad Kh 9s 3d') > pg_temp.ev('Ac Ad Qh Js Td') then n := n + 1; end if;                          -- пара: кикер K > Q
  if pg_temp.ev('Ac Kd 9h 7s 3d') > pg_temp.ev('Ac Kd 9h 7s 2d') then n := n + 1; end if;                          -- старшая карта до пятой
  if pg_temp.ev('Kc Kd Kh 7s 7d 7c 2h') = pg_temp.ev('Kc Kd Kh 7s 7d 2c 3h') then n := n + 1; end if;              -- две тройки = фулл-хаус K на 7
  if pg_temp.ev('Ah 2h 9h 4h 6h Kh 3c') = pg_temp.ev('Ah Kh 9h 6h 4h') then n := n + 1; end if;                    -- флеш из шести — пять старших
  if pg_temp.ev('Ah Kh Qh Jh Th 9h 8h') = pg_temp.ev('Ah Kh Qh Jh Th') then n := n + 1; end if;
  if pg_temp.ev('9c 8d 7h 6s 5d 4c 3h') = pg_temp.ev('9c 8d 7h 6s 5d') then n := n + 1; end if;                    -- длинный стрит — по старшей
  if public.poker_name(pg_temp.ev('As Ks Qs Js Ts')) = 'Роял-флеш' and public.poker_name(pg_temp.ev('Ac Ad Kh Ks Qd')) = 'Две пары'
     and public.poker_name(pg_temp.ev('2c 2d 2h 3s 4d')) = 'Тройка' and public.poker_name(pg_temp.ev('Ac Kd 9h 7s 3d')) = 'Старшая карта' then n := n + 1; end if;
  res := res || case when n = 17 then E'ok   1 комбинации: порядок, стрит и стрит-флеш с тузом снизу, кикеры, лучшая пятёрка из 7, названия\n'
                     else E'FAIL 1 (' || n || E'/17)\n' end;

  -- ===== 2. Стол: вход, лимиты, выход =====
  b := array(select public.coins_of(y) from unnest(u) y);
  n := 0;
  perform pg_temp.login(u[1]);
  begin perform public.poker_create(4, 79); exception when others then if sqlerrm = 'poker_bad_buyin' then n := n + 1; end if; end;
  begin perform public.poker_create(4, 200.01); exception when others then if sqlerrm = 'poker_bad_buyin' then n := n + 1; end if; end;
  begin perform public.poker_create(7, 100); exception when others then if sqlerrm = 'poker_bad_level' then n := n + 1; end if; end;
  t := public.poker_create(4, 200);
  begin perform public.poker_create(1, 2); exception when others then if sqlerrm = 'poker_busy' then n := n + 1; end if; end;
  if public.coins_of(u[1]) = b[1] - 200 then n := n + 1; end if;
  perform pg_temp.login(u[2]);
  begin perform public.poker_sit(t, 50); exception when others then if sqlerrm = 'poker_bad_buyin' then n := n + 1; end if; end;
  perform public.poker_sit(t, 100);
  perform public.poker_sit(t, 100);                                 -- второй раз — ничего не меняет
  if public.coins_of(u[2]) = b[2] - 100 and (select count(*) from public.poker_seats where table_id = t) = 2 then n := n + 1; end if;
  if (select next_at is not null from public.poker_tables where id = t) then n := n + 1; end if;   -- двое — раздача скоро начнётся
  x := public.poker_leave(t);
  if x = 100 and public.coins_of(u[2]) = b[2] then n := n + 1; end if;
  -- не больше 3 столов
  t2 := public.poker_create(1, 2);
  perform pg_temp.login(u[3]);
  t3 := public.poker_create(1, 0.80);
  perform pg_temp.login(u[4]);
  begin perform public.poker_create(1, 2); exception when others then if sqlerrm = 'poker_too_many' then n := n + 1; end if; end;
  perform pg_temp.login(u[2]); perform public.poker_leave(t2);
  perform pg_temp.login(u[3]); perform public.poker_leave(t3);
  if (select status from public.poker_tables where id = t2) = 'closed' and public.coins_of(u[3]) = b[3] then n := n + 1; end if;  -- пустой стол закрылся
  res := res || case when n = 11 then E'ok   2 стол: вход 40–100 ББ, уровни, занят другим столом, монеты списались и вернулись, не больше 3 столов, пустой закрывается\n'
                     else E'FAIL 2 (' || n || E'/11)\n' end;

  -- ===== 3. Вдвоём: дилер ставит малый блайнд и ходит первым до флопа, после флопа первым — большой блайнд =====
  n := 0;
  perform pg_temp.login(u[2]); perform public.poker_sit(t, 200);
  perform public.poker_deal(t);
  select * into g from public.poker_tables where id = t;
  btn := pg_temp.user_at(t, g.button_seat); bbu := pg_temp.user_at(t, g.bb_seat);
  if g.sb_seat = g.button_seat and g.turn_seat = g.button_seat and g.cur_bet = 2 then n := n + 1; end if;
  if pg_temp.stack(t, btn) = 199 and pg_temp.stack(t, bbu) = 198 then n := n + 1; end if;
  if pg_temp.act(t, bbu, 'check') = 'poker_not_turn' then n := n + 1; end if;
  if pg_temp.act(t, btn, 'check') = 'poker_bad_move' then n := n + 1; end if;      -- дилер должен доставить 1
  if pg_temp.act(t, btn, 'call') = 'ok' and pg_temp.turn(t) = bbu then n := n + 1; end if;   -- у большого блайнда право хода
  if pg_temp.act(t, bbu, 'check') = 'ok' then n := n + 1; end if;
  select * into g from public.poker_tables where id = t;
  if g.street = 'flop' and cardinality(g.board) = 3 and g.turn_seat = g.bb_seat and g.cur_bet = 0 then n := n + 1; end if;
  if pg_temp.act(t, bbu, 'check') = 'ok' and pg_temp.act(t, btn, 'check') = 'ok' then n := n + 1; end if;
  if pg_temp.act(t, bbu, 'raise', 4) = 'ok' and pg_temp.act(t, btn, 'fold') = 'ok' then n := n + 1; end if;
  select * into g from public.poker_tables where id = t;
  if g.status = 'open' and pg_temp.stack(t, bbu) = 202 and pg_temp.stack(t, btn) = 198 and g.shown = '{}' and not (g.result ->> 'showdown')::boolean
     and (g.result -> 'win' ->> g.bb_seat::text)::numeric = 4 and (g.result -> 'back' ->> g.bb_seat::text)::numeric = 4 then n := n + 1; end if;   -- выиграл 4, а 4 — своя неуравненная ставка
  if pg_temp.inv(t) is null then n := n + 1; end if;
  -- следующая раздача: дилер переходит ко второму
  perform public.poker_deal(t);
  if pg_temp.user_at(t, (select button_seat from public.poker_tables where id = t)) = bbu then n := n + 1; end if;
  perform pg_temp.act(t, pg_temp.turn(t), 'fold');
  res := res || case when n = 12 then E'ok   3 вдвоём: дилер — малый блайнд и ходит первым, у ББ право хода, после флопа первым ББ, пас — банк без вскрытия, дилер сдвигается\n'
                     else E'FAIL 3 (' || n || E'/12)\n' end;

  -- ===== 4. Втроём: позиции, первым до флопа — после ББ; минимальное повышение =====
  n := 0;
  perform pg_temp.login(u[3]); perform public.poker_sit(t, 200);
  update public.poker_seats set buyin = buyin + (200 - stack), stack = 200 where table_id = t and left_at is null;   -- выравниваем стеки (учёт фишек сходится)
  perform public.poker_deal(t);
  select * into g from public.poker_tables where id = t;
  btn := pg_temp.user_at(t, g.button_seat); sbu := pg_temp.user_at(t, g.sb_seat); bbu := pg_temp.user_at(t, g.bb_seat);
  if g.sb_seat = (select seat from public.poker_seats where table_id = t and in_hand and left_at is null and seat <> g.button_seat order by public.poker_after(g.button_seat, seat) limit 1)
     and g.bb_seat = (select seat from public.poker_seats where table_id = t and in_hand and left_at is null and seat not in (g.button_seat, g.sb_seat) limit 1)
     and pg_temp.turn(t) = btn then n := n + 1; end if;
  if pg_temp.act(t, btn, 'raise', 3) = 'poker_small_raise' then n := n + 1; end if;   -- до 3 — меньше минимального (2 + 2)
  if pg_temp.act(t, btn, 'call') = 'ok' and pg_temp.act(t, sbu, 'call') = 'ok' and pg_temp.turn(t) = bbu then n := n + 1; end if;
  perform pg_temp.login(bbu);
  v := public.poker_view(t) -> 'my';
  if (v ->> 'can_check')::boolean and (v ->> 'can_raise')::boolean and (v ->> 'min_to')::numeric = 4 then n := n + 1; end if;
  if pg_temp.act(t, bbu, 'check') = 'ok' and pg_temp.turn(t) = sbu then n := n + 1; end if;   -- после флопа первым — первый слева от дилера
  if pg_temp.act(t, sbu, 'raise', 1) = 'poker_small_raise' and pg_temp.act(t, sbu, 'raise', 2) = 'ok' then n := n + 1; end if;  -- ставка не меньше ББ
  if pg_temp.act(t, bbu, 'raise', 3) = 'poker_small_raise' and pg_temp.act(t, bbu, 'raise', 4) = 'ok' then n := n + 1; end if;
  e := pg_temp.act(t, btn, 'raise', 10);
  if e = 'ok' and (select min_raise from public.poker_tables where id = t) = 6 then n := n + 1; end if;
  if pg_temp.act(t, sbu, 'raise', 15) = 'poker_small_raise' and pg_temp.act(t, sbu, 'raise', 16) = 'ok' then n := n + 1; end if;
  if pg_temp.act(t, bbu, 'fold') = 'ok' and pg_temp.act(t, btn, 'call') = 'ok' then n := n + 1; end if;
  select * into g from public.poker_tables where id = t;
  if g.street = 'turn' and cardinality(g.board) = 4 and pg_temp.turn(t) = sbu and pg_temp.inv(t) is null then n := n + 1; end if;
  e := pg_temp.act(t, sbu, 'check') || pg_temp.act(t, btn, 'raise', 1000);
  if e = 'okok' and (select allin from public.poker_seats where table_id = t and user_id = btn and left_at is null) then n := n + 1; end if;  -- больше, чем есть, — ва-банк
  perform pg_temp.act(t, sbu, 'fold');
  res := res || case when n = 12 then E'ok   4 втроём: малый и большой блайнд после дилера, первым ходит следующий, мин. повышение = прошлое, ставка ≥ ББ, «больше чем есть» — ва-банк\n'
                     else E'FAIL 4 (' || n || E'/12)\n' end;

  -- ===== 5. Ва-банк меньше полного повышения не даёт повысить снова тем, кто уже ходил =====
  n := 0;
  update public.poker_seats set stack = 200, buyin = buyin + (200 - stack) where table_id = t and left_at is null;
  perform public.poker_deal(t);
  select * into g from public.poker_tables where id = t;
  -- до флопа все уравнивают
  for i in 1..3 loop cur := pg_temp.turn(t); exit when (select street from public.poker_tables where id = t) <> 'pre';
    perform pg_temp.act(t, cur, case when (select cur_bet from public.poker_tables where id = t) > (select bet from public.poker_seats where table_id = t and user_id = cur and left_at is null) then 'call' else 'check' end);
  end loop;
  if (select street from public.poker_tables where id = t) = 'flop' then n := n + 1; end if;
  ua := pg_temp.turn(t);
  perform pg_temp.act(t, ua, 'raise', 10);
  ub := pg_temp.turn(t);
  perform pg_temp.act(t, ub, 'call');
  uc := pg_temp.turn(t);
  update public.poker_seats set stack = 14, buyin = buyin - (stack - 14) where table_id = t and user_id = uc and left_at is null;
  e := pg_temp.act(t, uc, 'allin');
  if e = 'ok' and (select cur_bet from public.poker_tables where id = t) = 14 and (select min_raise from public.poker_tables where id = t) = 10 then n := n + 1; end if;
  perform pg_temp.login(ua);
  v := public.poker_view(t) -> 'my';
  if pg_temp.turn(t) = ua and not (v ->> 'can_raise')::boolean and (v ->> 'call')::numeric = 4 then n := n + 1; end if;
  if pg_temp.act(t, ua, 'raise', 30) = 'poker_bad_move' and pg_temp.act(t, ua, 'allin') = 'poker_bad_move' then n := n + 1; end if;
  if pg_temp.act(t, ua, 'call') = 'ok' and pg_temp.act(t, ub, 'call') = 'ok' then n := n + 1; end if;
  select * into g from public.poker_tables where id = t;
  if g.street = 'turn' and pg_temp.inv(t) is null then n := n + 1; end if;
  -- доиграть: чек до конца
  for i in 1..10 loop exit when (select status from public.poker_tables where id = t) <> 'play'; perform pg_temp.act(t, pg_temp.turn(t), 'check'); end loop;
  if (select status from public.poker_tables where id = t) = 'open' and pg_temp.inv(t) is null then n := n + 1; end if;
  res := res || case when n = 7 then E'ok   5 ва-банк 14 на ставку 10 (неполное повышение): уже ходившие только уравнивают или пасуют, мин. повышение не меняется\n'
                     else E'FAIL 5 (' || n || E'/7)\n' end;

  -- ===== 6. Побочные банки: 20 / 50 / 100, все ва-банк =====
  n := 0;
  for i in 1..3 loop   -- кто вылетел в прошлых проверках — садится снова
    if pg_temp.seat_of(t, u[i]) is null then perform pg_temp.login(u[i]); perform public.poker_sit(t, 200); end if;
  end loop;
  perform public.poker_deal(t);
  select * into g from public.poker_tables where id = t;
  -- места по кругу от дилера: даём разные стеки (вместе со ставкой блайнда) и подкладываем карты
  ua := pg_temp.user_at(t, g.bb_seat); ub := pg_temp.user_at(t, g.button_seat); uc := pg_temp.user_at(t, g.sb_seat);
  update public.poker_seats x set buyin = x.buyin + ((case x.user_id when ua then 20 when ub then 50 else 100 end) - x.bet - x.stack),
                                  stack = (case x.user_id when ua then 20 when ub then 50 else 100 end) - x.bet
   where x.table_id = t and x.left_at is null;
  perform pg_temp.rig(t, jsonb_build_object(g.bb_seat::text, 'As Ah', g.button_seat::text, 'Ks Kh', g.sb_seat::text, 'Qs Qh'), '2c 7d 9h Js 3c');
  for i in 1..6 loop exit when (select status from public.poker_tables where id = t) <> 'play'; perform pg_temp.act(t, pg_temp.turn(t), 'allin'); end loop;
  select * into g from public.poker_tables where id = t;
  if g.status = 'open' and (g.result ->> 'showdown')::boolean then n := n + 1; end if;
  if pg_temp.stack(t, ua) = 60 and pg_temp.stack(t, ub) = 60 and pg_temp.stack(t, uc) = 50 then n := n + 1; end if;   -- 60 главный, 60 побочный, 50 вернулось
  if jsonb_array_length(g.result -> 'pots') = 2 and (g.result -> 'pots' -> 0 ->> 'name') = 'Пара' and (g.result -> 'back' ->> g.sb_seat::text)::numeric = 50
     and not (g.result -> 'win') ? g.sb_seat::text and (g.result -> 'win' ->> g.bb_seat::text)::numeric = 60 then n := n + 1; end if;   -- возврат 50 — не банк и не выигрыш
  if g.shown ? g.bb_seat::text and g.shown ? g.button_seat::text and pg_temp.inv(t) is null then n := n + 1; end if;
  perform pg_temp.login(uc);
  v := public.poker_view(t);
  if (select count(*) from jsonb_array_elements(v -> 'players') p where p -> 'cards' is not null and p -> 'cards' <> 'null'::jsonb) = 3 then n := n + 1; end if;  -- после вскрытия карты видны всем
  res := res || case when n = 5 then E'ok   6 побочные банки: стеки 20/50/100 ва-банк, лучшая рука у 20 — главный 60, вторая — побочный 60, третьему вернулось 50 (не выигрыш); карты открыты\n'
                     else E'FAIL 6 (' || n || E'/5)\n' end;

  -- ===== 7. Тайна карт: чужие не видны, видно только число =====
  n := 0;
  update public.poker_seats set stack = 200, buyin = buyin + (200 - stack) where table_id = t and left_at is null;
  perform public.poker_deal(t);
  perform pg_temp.login(u[1]);
  v := public.poker_view(t);
  if (select count(*) from jsonb_array_elements(v -> 'players') p where (p ->> 'me')::boolean and jsonb_array_length(p -> 'cards') = 2) = 1 then n := n + 1; end if;
  if (select count(*) from jsonb_array_elements(v -> 'players') p where not (p ->> 'me')::boolean and (p -> 'cards' is null or p -> 'cards' = 'null'::jsonb) and (p ->> 'hidden')::boolean) = 2 then n := n + 1; end if;
  if v::text not like '%"deck"%' and jsonb_array_length(v -> 'board') = 0 then n := n + 1; end if;
  -- уйти посреди раздачи: карты сброшены, остаток — на баланс
  x := pg_temp.stack(t, u[1]);
  total0 := public.coins_of(u[1]);
  total1 := public.poker_leave(t);
  if total1 = x and public.coins_of(u[1]) = total0 + x and pg_temp.inv(t) is null then n := n + 1; end if;
  -- двое остались — играют дальше; уходит второй — последний забирает банк
  if (select status from public.poker_tables where id = t) = 'play' then
    cur := (select user_id from public.poker_seats where table_id = t and left_at is null and in_hand and not folded order by seat limit 1);
    perform pg_temp.login(cur); perform public.poker_leave(t);
    if (select status from public.poker_tables where id = t) = 'open' and pg_temp.inv(t) is null then n := n + 1; end if;
  else n := n + 1; end if;
  res := res || case when n = 5 then E'ok   7 тайна карт: свои видно, чужие — только рубашки, колоды в ответе нет; уход посреди раздачи — пас и остаток на баланс\n'
                     else E'FAIL 7 (' || n || E'/5)\n' end;
  -- все встают
  for i in 1..nu loop perform pg_temp.login(u[i]); perform public.poker_leave(t); end loop;

  -- ===== 8. Ничья с лишней копейкой: банк 0,05 на двоих — 0,03 первому слева от дилера =====
  n := 0;
  perform pg_temp.login(u[1]); t := public.poker_create(1, 2);
  perform pg_temp.login(u[2]); perform public.poker_sit(t, 2);
  perform pg_temp.login(u[3]); perform public.poker_sit(t, 2);
  perform public.poker_deal(t);
  select * into g from public.poker_tables where id = t;
  btn := pg_temp.user_at(t, g.button_seat); sbu := pg_temp.user_at(t, g.sb_seat); bbu := pg_temp.user_at(t, g.bb_seat);
  perform pg_temp.rig(t, jsonb_build_object(g.button_seat::text, '2c 3d', g.bb_seat::text, '4c 5d', g.sb_seat::text, '6c 7d'), 'As Ks Qs Js Ts');
  if pg_temp.act(t, btn, 'call') = 'ok' and pg_temp.act(t, sbu, 'fold') = 'ok' and pg_temp.act(t, bbu, 'check') = 'ok' then n := n + 1; end if;
  for i in 1..10 loop exit when (select status from public.poker_tables where id = t) <> 'play'; perform pg_temp.act(t, pg_temp.turn(t), 'check'); end loop;
  if pg_temp.stack(t, bbu) = 2.01 and pg_temp.stack(t, btn) = 2.00 and pg_temp.stack(t, sbu) = 1.99 then n := n + 1; end if;
  if (select (result -> 'pots' -> 0 ->> 'name') = 'Роял-флеш' and jsonb_array_length(result -> 'pots' -> 0 -> 'seats') = 2 from public.poker_tables where id = t) then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   8 ничья (обе играют доску): банк 0,05 делится 0,03 / 0,02, лишняя копейка — первому слева от дилера\n'
                     else E'FAIL 8 (' || n || E'/3)\n' end;

  -- ===== 9. Время: чек, если можно, иначе пас; два раза подряд — встаёт, фишки на баланс =====
  -- (03_no_clock.sql это правило убирала, 04_clock_alone.sql вернула — на ход 60 секунд; проверка снова проходит)
  n := 0;
  perform public.poker_deal(t);
  cur := pg_temp.turn(t);                                         -- до флопа должен доставить → пас
  update public.poker_tables set deadline = now() - interval '5 seconds' where id = t;
  perform public.poker_tick(t);
  if (select folded and misses = 1 from public.poker_seats where table_id = t and user_id = cur and left_at is null) then n := n + 1; end if;
  -- остальные доходят до флопа, там первый пропускает ход → чек
  for i in 1..4 loop exit when (select street from public.poker_tables where id = t) <> 'pre';
    perform pg_temp.act(t, pg_temp.turn(t), case when (select cur_bet from public.poker_tables where id = t) > (select bet from public.poker_seats where table_id = t and user_id = pg_temp.turn(t) and left_at is null) then 'call' else 'check' end);
  end loop;
  ua := pg_temp.turn(t);
  update public.poker_tables set deadline = now() - interval '5 seconds' where id = t;
  perform public.poker_tick(t);
  if (select not folded and last_act = 'check' and misses = 1 from public.poker_seats where table_id = t and user_id = ua and left_at is null) then n := n + 1; end if;
  for i in 1..10 loop exit when (select status from public.poker_tables where id = t) <> 'play'; perform pg_temp.act(t, pg_temp.turn(t), 'check'); end loop;
  -- следующая раздача: тот же игрок снова пропускает — встаёт из-за стола
  perform public.poker_deal(t);
  for i in 1..6 loop
    exit when pg_temp.turn(t) = cur or (select status from public.poker_tables where id = t) <> 'play';
    perform pg_temp.act(t, pg_temp.turn(t), case when (select cur_bet from public.poker_tables where id = t) > (select bet from public.poker_seats where table_id = t and user_id = pg_temp.turn(t) and left_at is null) then 'call' else 'check' end);
  end loop;
  total0 := public.coins_of(cur); x := pg_temp.stack(t, cur);
  update public.poker_tables set deadline = now() - interval '5 seconds' where id = t;
  perform public.poker_tick(t);
  if pg_temp.seat_of(t, cur) is null and public.coins_of(cur) = total0 + x
     and (select left_kind from public.poker_seats where table_id = t and user_id = cur order by id desc limit 1) = 'afk' then n := n + 1; end if;
  if pg_temp.inv(t) is null then n := n + 1; end if;
  perform pg_temp.login(cur);
  if (public.poker_view(t) -> 'gone' ->> 'kind') = 'afk' then n := n + 1; end if;
  res := res || case when n = 5 then E'ok   9 время вышло: должен доставить — пас, можно чек — чек; второй пропуск подряд — встаёт, фишки на баланс\n'
                     else E'FAIL 9 (' || n || E'/5)\n' end;
  for i in 1..nu loop perform pg_temp.login(u[i]); perform public.poker_leave(t); end loop;

  -- ===== 10. Фишки кончились — встаёт; докупить — между раздачами, до 100 ББ =====
  n := 0;
  perform pg_temp.login(u[1]); t := public.poker_create(4, 80);
  perform pg_temp.login(u[2]); perform public.poker_sit(t, 200);
  perform public.poker_deal(t);
  perform pg_temp.login(u[1]);
  begin perform public.poker_topup(t, 10); exception when others then if sqlerrm = 'poker_in_hand' then n := n + 1; end if; end;
  select * into g from public.poker_tables where id = t;
  perform pg_temp.rig(t, jsonb_build_object(pg_temp.seat_of(t, u[1])::text, '2c 7d', pg_temp.seat_of(t, u[2])::text, 'Ac Ad'), 'Ah Kd 9s 4c 3h');
  total0 := public.coins_of(u[1]);
  for i in 1..4 loop exit when (select status from public.poker_tables where id = t) <> 'play'; perform pg_temp.act(t, pg_temp.turn(t), 'allin'); end loop;
  if pg_temp.seat_of(t, u[1]) is null and public.coins_of(u[1]) = total0 and pg_temp.stack(t, u[2]) = 280 then n := n + 1; end if;
  perform pg_temp.login(u[1]);
  if (public.poker_view(t) -> 'gone' ->> 'kind') = 'bust' and (public.poker_view(t) -> 'gone' ->> 'net')::numeric = -80 then n := n + 1; end if;
  perform public.poker_sit(t, 100);                                 -- сесть снова
  if public.coins_of(u[1]) = total0 - 100 then n := n + 1; end if;
  begin perform public.poker_topup(t, 101); exception when others then if sqlerrm = 'poker_bad_buyin' then n := n + 1; end if; end;
  perform public.poker_topup(t, 100);
  if pg_temp.stack(t, u[1]) = 200 and public.coins_of(u[1]) = total0 - 200 and pg_temp.inv(t) is null then n := n + 1; end if;
  res := res || case when n = 6 then E'ok  10 проиграл всё — встаёт (видно «фишки кончились», −80), сел снова; докупить нельзя в раздаче и больше 100 ББ\n'
                     else E'FAIL 10 (' || n || E'/6)\n' end;
  for i in 1..nu loop perform pg_temp.login(u[i]); perform public.poker_leave(t); end loop;

  -- ===== 11. Сотни случайных раздач: 2–6 игроков, случайные честные ходы, уходы, пропуски по времени =====
  total0 := (select sum(public.coins_of(y)) from unnest(u) y);
  busts := -(select count(*) from public.poker_seats where left_kind = 'bust' and user_id = any(u));
  for k in 1..40 loop
    np := 2 + (k % (nu - 1));
    lvl := 1 + (k % 6);
    perform pg_temp.login(u[1]);
    select bb into x from public.poker_level(lvl);
    t := public.poker_create(lvl, round((40 + random() * 60)::numeric * x, 2));
    for i in 2..np loop perform pg_temp.login(u[i]); perform public.poker_sit(t, round((40 + random() * 60)::numeric * x, 2)); end loop;
    games := games + 1;
    for j in 1..15 loop
      exit when not public.poker_deal(t);
      hands := hands + 1; steps := 0;
      while (select status from public.poker_tables where id = t) = 'play' and steps < 300 loop
        steps := steps + 1;
        select * into g from public.poker_tables where id = t;
        select * into me from public.poker_seats where table_id = t and left_at is null and seat = g.turn_seat;
        v_call := greatest(g.cur_bet - me.bet, 0);
        r := random();
        if r < 0.02 then
          update public.poker_tables set deadline = now() - interval '5 seconds' where id = t;  -- пропуск хода по времени
          if me.misses >= 1 then afks := afks + 1; end if;
          perform public.poker_tick(t);
          e := 'ok';
        elsif r < 0.035 then
          -- уходит случайный игрок (не обязательно тот, чей ход)
          select user_id into pick from public.poker_seats where table_id = t and left_at is null order by random() limit 1;
          perform pg_temp.login(pick); perform public.poker_leave(t); leaves := leaves + 1;
          e := 'ok';
        elsif r < 0.05 then
          -- нечестный ход должен отклоняться
          e := pg_temp.act(t, me.user_id, case when v_call > 0 then 'check' else 'call' end);
          e := case when e in ('poker_bad_move') then 'ok' else 'нечестный ход принят: ' || e end;
        elsif r < 0.17 and v_call > 0 then
          e := pg_temp.act(t, me.user_id, 'fold');
        elsif r < 0.62 then
          e := pg_temp.act(t, me.user_id, case when v_call > 0 then 'call' else 'check' end);
        elsif r < 0.9 and not me.acted and me.stack > v_call then
          v_to := least(g.cur_bet + g.min_raise + round((random() * (me.stack - v_call - g.min_raise))::numeric, 2), me.bet + me.stack);
          v_to := greatest(v_to, least(g.cur_bet + g.min_raise, me.bet + me.stack));
          e := pg_temp.act(t, me.user_id, 'raise', v_to);
        elsif not me.acted or me.stack <= v_call then
          e := pg_temp.act(t, me.user_id, 'allin');
        else
          e := pg_temp.act(t, me.user_id, case when v_call > 0 then 'call' else 'check' end);
        end if;
        acts := acts + 1;
        if e <> 'ok' then bad := bad + 1; if fail_note = '' then fail_note := 'ход: ' || e; end if; end if;
        e := pg_temp.inv(t);
        if e is not null then bad := bad + 1; if fail_note = '' then fail_note := e; end if; end if;
      end loop;
      select * into g from public.poker_tables where id = t;
      if g.status = 'play' then bad := bad + 1; if fail_note = '' then fail_note := 'раздача не закончилась'; end if; end if;
      if (g.result ->> 'showdown')::boolean then showdowns := showdowns + 1; end if;
      if jsonb_array_length(coalesce(g.result -> 'pots', '[]')) > 1 then sidepots := sidepots + 1; end if;
      if exists (select 1 from jsonb_array_elements(coalesce(g.result -> 'pots', '[]')) p where jsonb_array_length(p -> 'seats') > 1) then splits := splits + 1; end if;
      exit when g.status = 'closed';
      -- иногда кто-то докупает или садится обратно
      if random() < 0.3 then
        select user_id into pick from public.poker_seats where table_id = t and left_at is null and stack < 100 * g.bb order by random() limit 1;
        if pick is not null then perform pg_temp.login(pick); perform public.poker_topup(t, least(100 * g.bb - pg_temp.stack(t, pick), 10 * g.bb)); end if;
      end if;
      for i in 1..np loop
        if pg_temp.seat_of(t, u[i]) is null and random() < 0.5 and (select status from public.poker_tables where id = t) <> 'closed' then
          perform pg_temp.login(u[i]); perform public.poker_sit(t, 40 * g.bb);
        end if;
      end loop;
      e := pg_temp.inv(t);
      if e is not null then bad := bad + 1; if fail_note = '' then fail_note := 'между раздачами: ' || e; end if; end if;
    end loop;
    for i in 1..nu loop perform pg_temp.login(u[i]); perform public.poker_leave(t); end loop;
    if (select status from public.poker_tables where id = t) <> 'closed' then bad := bad + 1; if fail_note = '' then fail_note := 'стол не закрылся'; end if; end if;
  end loop;
  total1 := (select sum(public.coins_of(y)) from unnest(u) y);
  busts := busts + (select count(*) from public.poker_seats where left_kind = 'bust' and user_id = any(u));
  res := res || case when bad = 0 and total1 = total0 and hands >= 200 and showdowns > 0 and sidepots > 0
                     then 'ok  11 ' || games || ' столов, ' || hands || ' раздач, ' || acts || ' ходов: фишки сходятся после каждого хода, монеты всех — до копейки ('
                          || showdowns || ' вскрытий, ' || sidepots || ' с побочными банками, ' || splits || ' делёжек, ' || leaves || ' уходов, ' || busts || ' вылетов)' || E'\n'
                     else 'FAIL 11 (ошибок ' || bad || ', ' || fail_note || ', монеты ' || total0 || ' → ' || total1 || ', раздач ' || hands || ', вскрытий ' || showdowns || ', побочных ' || sidepots || E')\n' end;

  raise exception E'\n%', res;
end $test$;
