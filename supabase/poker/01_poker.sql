-- «ПОКЕР» (техасский холдем без лимита): столы на 2–6 человек, фишки = монеты.
--
-- Как устроено (простыми словами):
-- * Стол открывают с уровнем блайндов (6 уровней: 0,01/0,02 … 25/50). За стол садятся с суммой от 40 до 100 больших блайндов —
--   эти монеты списываются с баланса и становятся фишками. Встал из-за стола — остаток фишек сразу возвращается на баланс.
--   Баланс: coins_of прибавляет по каждому месту «унёс − принёс» (пока сидит — «−принёс»).
-- * Раздача: дилер (кнопка) сдвигается по кругу, двое после него ставят малый и большой блайнд (вдвоём малый ставит дилер),
--   каждому 2 закрытые карты, в центр — 3, потом 1, потом 1. Четыре круга ставок. Лучшая пятёрка из 7 карт забирает банк.
-- * Ход: пас, чек, уравнять, ставка/повышение (минимум на размер прошлого повышения), ва-банк.
--   Ва-банк меньше полного повышения не даёт повысить снова тем, кто уже ходил на этом круге.
-- * Побочные банки: каждый может выиграть только ту часть банка, которую сам уравнял. Равные руки делят банк,
--   лишняя копейка — первому слева от дилера.
-- * На ход 30 секунд. Время вышло — чек, если можно, иначе пас. Два раза подряд — игрок встаёт из-за стола (фишки на баланс).
-- * Новый игрок вступает со следующей раздачи. Уйти можно в любой момент: посреди раздачи карты сбрасываются.
-- * Фишки кончились — игрок встаёт из-за стола (можно сесть снова). Докупить можно между раздачами, до 100 больших блайндов.
-- * Комиссии нет. Колоду тасует база (gen_random_uuid — надёжный генератор). Чужие карты телефон не получает до вскрытия.
-- * Тестовый стол — только админу: с ботами, без монет (места помечены test, в баланс не идут), без уведомлений.
--
-- Карта — число 0..51: достоинство = карта / 4 + 2 (2..14, где 11 — валет, 14 — туз), масть = карта % 4 (♠ ♥ ♦ ♣).

-- 1. Столы
create table public.poker_tables (
  id bigint generated always as identity primary key,
  creator uuid not null,
  level integer not null check (level between 1 and 6),
  sb numeric(12, 2) not null,
  bb numeric(12, 2) not null,
  test boolean not null default false,
  status text not null default 'open' check (status in ('open', 'play', 'closed')),  -- open — раздачи нет (ждём или пауза); play — идёт раздача
  created_at timestamptz not null default now(),
  active_at timestamptz not null default now(),   -- последняя раздача или посадка (стол без раздач сутки — закрывается)
  closed_at timestamptz,
  version integer not null default 0,             -- растёт при каждом изменении (телефону — знак «перерисуй»)
  log jsonb not null default '[]',                -- последние действия (для анимаций)
  hand_no integer not null default 0,
  button_seat integer,                            -- дилер
  sb_seat integer, bb_seat integer,
  street text check (street in ('pre', 'flop', 'turn', 'river', 'show')),
  deck integer[] not null default '{}',           -- остаток колоды (только база)
  board integer[] not null default '{}',          -- общие карты
  turn_seat integer,                              -- чей ход
  deadline timestamptz,                           -- срок хода
  cur_bet numeric(12, 2) not null default 0,      -- самая большая ставка на этом круге
  min_raise numeric(12, 2) not null default 0,    -- минимальное повышение (размер прошлого полного повышения)
  next_at timestamptz,                            -- когда начать следующую раздачу
  shown jsonb not null default '{}',              -- карты, открытые на вскрытии: {"место": [карта, карта]}
  result jsonb                                    -- итог последней раздачи (для экрана)
);
create index poker_tables_status_idx on public.poker_tables (status, created_at);
alter table public.poker_tables enable row level security;
revoke all on public.poker_tables from anon, authenticated;

-- 2. Места за столом. Одна строка — одна «посадка»: сел (buyin), докупил (buyin растёт), встал (cashout = остаток фишек).
create table public.poker_seats (
  id bigint generated always as identity primary key,
  table_id bigint not null references public.poker_tables (id) on delete cascade,
  user_id uuid not null,                          -- у ботов — постоянный номер без профиля
  seat integer not null check (seat between 0 and 5),
  bot_name text,
  test boolean not null default false,            -- место за тестовым столом: в баланс не идёт
  buyin numeric(12, 2) not null default 0 check (buyin >= 0),
  cashout numeric(12, 2),
  stack numeric(12, 2) not null default 0 check (stack >= 0),
  joined_at timestamptz not null default clock_timestamp(),
  left_at timestamptz,
  left_kind text check (left_kind in ('self', 'afk', 'bust', 'closed')),
  hands integer not null default 0,               -- сколько раздач сыграно
  misses integer not null default 0,              -- сколько ходов подряд пропущено по времени
  -- текущая раздача
  in_hand boolean not null default false,
  hole integer[] not null default '{}',
  folded boolean not null default false,
  allin boolean not null default false,
  acted boolean not null default false,           -- уже ходил после последнего полного повышения
  bet numeric(12, 2) not null default 0,          -- поставлено на этом круге
  put numeric(12, 2) not null default 0,          -- всего в банке за раздачу
  last_act text                                   -- последнее действие (подпись у игрока)
);
create unique index poker_seats_seat_key on public.poker_seats (table_id, seat) where left_at is null;
create unique index poker_seats_user_key on public.poker_seats (table_id, user_id) where left_at is null;
create index poker_seats_user_idx on public.poker_seats (user_id);
create index poker_seats_table_idx on public.poker_seats (table_id);
alter table public.poker_seats enable row level security;
revoke all on public.poker_seats from anon, authenticated;

-- 3. Баланс = книга монет + казино + лавка + дурак + покер (за столом: «унёс − принёс»; тестовые места не считаются)
create or replace function public.coins_of(p_user uuid)
returns numeric
language sql stable security definer set search_path to ''
as $function$
  select round(coalesce((select sum(l.amount) from public.points_ledger l where l.user_id = p_user), 0)
        + coalesce((select sum(coalesce(r.payout, 0) - r.bet) from public.casino_rounds r where r.user_id = p_user), 0)
        + coalesce((select sum(m.price - m.fee) from public.card_listings m where m.seller_id = p_user and m.status = 'sold'), 0)
        - coalesce((select sum(m.price) from public.card_listings m where m.buyer_id = p_user and m.status = 'sold'), 0)
        + coalesce((select sum(coalesce(d.payout, 0) - d.stake) from public.durak_players d where d.user_id = p_user), 0)
        + coalesce((select sum(coalesce(s.cashout, 0) - s.buyin) from public.poker_seats s where s.user_id = p_user and not s.test), 0), 2)
$function$;

-- 4. Уровни блайндов. Вход за стол — от 40 до 100 больших блайндов.
create or replace function public.poker_level(p_level integer)
returns table (sb numeric, bb numeric)
language sql immutable set search_path to ''
as $function$
  select x.sb, x.bb from (values (1, 0.01, 0.02), (2, 0.05, 0.10), (3, 0.25, 0.50), (4, 1.00, 2.00), (5, 5.00, 10.00), (6, 25.00, 50.00)) x(l, sb, bb)
  where x.l = p_level
$function$;

-- 5. Комбинации. Сила руки — одно число: категория (0 старшая карта … 8 стрит-флеш) и до пяти достоинств для сравнения.
-- Упаковать до пяти достоинств в одно число (по 4 бита)
create or replace function public.poker_pack(p integer[])
returns integer
language sql immutable set search_path to ''
as $function$
  select (coalesce(p[1], 0) << 16) | (coalesce(p[2], 0) << 12) | (coalesce(p[3], 0) << 8) | (coalesce(p[4], 0) << 4) | coalesce(p[5], 0)
$function$;

-- Стрит: достоинства без повторов по убыванию → старшая карта лучшего стрита (0 — стрита нет). Туз может быть единицей (A-2-3-4-5).
create or replace function public.poker_straight(p integer[])
returns integer
language plpgsql immutable set search_path to ''
as $function$
declare v integer[] := p; r integer; v_run integer := 0; v_prev integer := -1;
begin
  if 14 = any(p) then v := v || 1; end if;
  foreach r in array v loop
    if v_prev - 1 = r then v_run := v_run + 1; else v_run := 1; end if;
    if v_run >= 5 then return r + 4; end if;
    v_prev := r;
  end loop;
  return 0;
end $function$;

-- Лучшая пятёрка из 5–7 карт (работает и для 2 карт — у ботов до флопа)
create or replace function public.poker_eval(p_cards integer[])
returns integer
language plpgsql immutable set search_path to ''
as $function$
declare
  v_cnt integer[] := array_fill(0, array[14]);
  v_suit integer[] := array_fill(0, array[4]);
  c integer; r integer; v_fs integer := -1;
  v_quad integer := 0; v_trips integer[] := '{}'; v_pairs integer[] := '{}'; v_all integer[] := '{}';
  v_fl integer[]; v_st integer;
begin
  foreach c in array p_cards loop
    v_cnt[c / 4 + 2] := v_cnt[c / 4 + 2] + 1;
    v_suit[c % 4 + 1] := v_suit[c % 4 + 1] + 1;
  end loop;
  for r in 1..4 loop if v_suit[r] >= 5 then v_fs := r - 1; end if; end loop;
  if v_fs >= 0 then
    v_fl := array(select distinct x / 4 + 2 from unnest(p_cards) x where x % 4 = v_fs order by 1 desc);
    v_st := public.poker_straight(v_fl);
    if v_st > 0 then return (8 << 20) | public.poker_pack(array[v_st]); end if;
  end if;
  for r in reverse 14..2 loop
    if v_cnt[r] = 4 and v_quad = 0 then v_quad := r;
    elsif v_cnt[r] = 3 then v_trips := v_trips || r;
    elsif v_cnt[r] = 2 then v_pairs := v_pairs || r;
    end if;
    if v_cnt[r] > 0 then v_all := v_all || r; end if;
  end loop;
  if v_quad > 0 then
    return (7 << 20) | public.poker_pack(array[v_quad, (select max(x) from unnest(v_all) x where x <> v_quad)]);
  end if;
  if cardinality(v_trips) >= 1 and (cardinality(v_trips) >= 2 or cardinality(v_pairs) >= 1) then
    return (6 << 20) | public.poker_pack(array[v_trips[1], greatest(coalesce(v_trips[2], 0), coalesce(v_pairs[1], 0))]);
  end if;
  if v_fs >= 0 then return (5 << 20) | public.poker_pack(v_fl[1:5]); end if;
  v_st := public.poker_straight(v_all);
  if v_st > 0 then return (4 << 20) | public.poker_pack(array[v_st]); end if;
  if cardinality(v_trips) = 1 then
    return (3 << 20) | public.poker_pack(array[v_trips[1]] || array(select x from unnest(v_all) x where x <> v_trips[1] order by x desc limit 2));
  end if;
  if cardinality(v_pairs) >= 2 then
    return (2 << 20) | public.poker_pack(array[v_pairs[1], v_pairs[2],
                                               (select max(x) from unnest(v_all) x where x <> v_pairs[1] and x <> v_pairs[2])]);
  end if;
  if cardinality(v_pairs) = 1 then
    return (1 << 20) | public.poker_pack(array[v_pairs[1]] || array(select x from unnest(v_all) x where x <> v_pairs[1] order by x desc limit 3));
  end if;
  return public.poker_pack(v_all[1:5]);
end $function$;

create or replace function public.poker_name(p_score integer)
returns text
language sql immutable set search_path to ''
as $function$
  select case p_score >> 20
           when 8 then case when ((p_score >> 16) & 15) = 14 then 'Роял-флеш' else 'Стрит-флеш' end
           when 7 then 'Каре' when 6 then 'Фулл-хаус' when 5 then 'Флеш' when 4 then 'Стрит'
           when 3 then 'Тройка' when 2 then 'Две пары' when 1 then 'Пара' else 'Старшая карта' end
$function$;

-- 6. Порядок мест по часовой: 0 — следующее место после p_from, 5 — само p_from
create or replace function public.poker_after(p_from integer, p_seat integer)
returns integer
language sql immutable set search_path to ''
as $function$ select (p_seat - coalesce(p_from, 0) + 5) % 6 $function$;

-- 7. Журнал действий (последние 12) — по нему телефон показывает анимации
create or replace function public.poker_log(p_table bigint, p_entry jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v jsonb;
begin
  select g.log || jsonb_build_array(p_entry || jsonb_build_object('i', g.version + 1)) into v from public.poker_tables g where g.id = p_table;
  while jsonb_array_length(v) > 12 loop v := v - 0; end loop;
  update public.poker_tables g set log = v, version = g.version + 1 where g.id = p_table;
end $function$;

-- 8. Кто ходит следующим после места p_from: в раздаче, не пас, не ва-банк, и ещё не ходил или должен доставить
create or replace function public.poker_actor(p_table bigint, p_from integer)
returns integer
language sql stable security definer set search_path to ''
as $function$
  select x.seat from public.poker_seats x join public.poker_tables g on g.id = x.table_id
   where x.table_id = p_table and x.in_hand and not x.folded and not x.allin and (not x.acted or x.bet < g.cur_bet)
   order by public.poker_after(p_from, x.seat) limit 1
$function$;

-- 9. Закрыть стол: все, кто сидит, встают (фишки на баланс)
create or replace function public.poker_close(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  update public.poker_seats x set cashout = x.stack, left_at = now(), left_kind = 'closed'
   where x.table_id = p_table and x.left_at is null;
  update public.poker_tables g set status = 'closed', closed_at = now(), turn_seat = null, deadline = null, next_at = null,
         version = g.version + 1
   where g.id = p_table and g.status <> 'closed';
end $function$;

-- За столом не осталось людей — стол закрывается.
-- Тестовый стол, где у админа кончились фишки, ждёт 10 минут: можно сесть снова (боты без него не играют).
create or replace function public.poker_close_if_empty(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if exists (select 1 from public.poker_seats x where x.table_id = p_table and x.left_at is null and x.bot_name is null) then return; end if;
  if exists (select 1 from public.poker_tables g where g.id = p_table and g.test
               and (select x.left_kind = 'bust' and x.left_at > now() - interval '10 minutes' from public.poker_seats x
                     where x.table_id = g.id and x.user_id = g.creator order by x.id desc limit 1)) then
    return;
  end if;
  perform public.poker_close(p_table);
end $function$;

-- Если сидят хотя бы двое с фишками и раздачи нет — следующая начнётся через 2 секунды
create or replace function public.poker_schedule(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  update public.poker_tables g set next_at = now() + interval '2 seconds'
   where g.id = p_table and g.status = 'open' and g.next_at is null
     and (select count(*) from public.poker_seats x where x.table_id = p_table and x.left_at is null and x.stack > 0) >= 2;
end $function$;

-- 10. Итог раздачи: банки (с побочными), выплаты, кто встаёт (фишки кончились)
create or replace function public.poker_finish(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  v_live integer; v_total numeric; v_prev numeric := 0; v_lvl numeric; v_top numeric; v_amt numeric; v_share numeric;
  v_rem integer; v_best integer; v_win integer[]; v_seat integer; i integer;
  v_pots jsonb := '[]'; v_won jsonb := '{}'; v_shown jsonb := '{}';
  v_bseat integer; v_p1 numeric; v_p2 numeric; v_live1 boolean; v_back numeric := 0; v_show numeric; v_winmap jsonb;
begin
  select * into g from public.poker_tables x where x.id = p_table for update;
  select count(*) into v_live from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded;
  select coalesce(sum(x.put), 0) into v_total from public.poker_seats x where x.table_id = p_table and x.in_hand;
  -- возврат: часть ставки того, кто поставил больше всех, которую никто не уравнял (это не выигрыш)
  select x.seat, x.put, not x.folded into v_bseat, v_p1, v_live1
    from public.poker_seats x where x.table_id = p_table and x.in_hand order by x.put desc, x.folded limit 1;
  select coalesce(max(x.put), 0) into v_p2
    from public.poker_seats x where x.table_id = p_table and x.in_hand and x.seat <> v_bseat;
  if v_live1 and v_p1 > v_p2 then v_back := v_p1 - v_p2; end if;
  if v_live = 1 then
    -- остальные спасовали: весь банк одному, карты не открываются
    select x.seat into v_seat from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded;
    v_won := jsonb_build_object(v_seat::text, v_total);
    v_pots := jsonb_build_array(jsonb_build_object('amount', v_total - v_back, 'seats', jsonb_build_array(v_seat)));
  elsif v_live > 1 then
    select max(x.put) into v_top from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded;
    for v_lvl in select distinct x.put from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded order by 1 loop
      -- банк этого уровня: с каждого (и спасовавших) — сколько он положил между прошлым уровнем и этим; последний забирает и всё, что выше
      select coalesce(sum(least(x.put, case when v_lvl = v_top then x.put else v_lvl end) - least(x.put, v_prev)), 0) into v_amt
        from public.poker_seats x where x.table_id = p_table and x.in_hand;
      v_prev := v_lvl;
      continue when v_amt <= 0;
      select max(public.poker_eval(x.hole || g.board)) into v_best
        from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded and x.put >= v_lvl;
      v_win := array(select x.seat from public.poker_seats x
                      where x.table_id = p_table and x.in_hand and not x.folded and x.put >= v_lvl and public.poker_eval(x.hole || g.board) = v_best
                      order by public.poker_after(g.button_seat, x.seat));
      v_share := trunc(v_amt / cardinality(v_win), 2);
      v_rem := round((v_amt - v_share * cardinality(v_win)) * 100)::integer;   -- лишние копейки — первым слева от дилера
      for i in 1..cardinality(v_win) loop
        v_won := jsonb_set(v_won, array[v_win[i]::text],
                           to_jsonb(coalesce((v_won ->> v_win[i]::text)::numeric, 0) + v_share + case when i <= v_rem then 0.01 else 0 end));
      end loop;
      -- на экране возврат не показываем как банк
      v_show := v_amt - case when v_lvl = v_top and cardinality(v_win) = 1 and v_win[1] = v_bseat then v_back else 0 end;
      if v_show > 0 then
        v_pots := v_pots || jsonb_build_array(jsonb_build_object('amount', v_show, 'seats', to_jsonb(v_win), 'name', public.poker_name(v_best)));
      end if;
    end loop;
    select coalesce(jsonb_object_agg(x.seat::text, to_jsonb(x.hole)), '{}') into v_shown
      from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded;
  end if;

  select coalesce(jsonb_object_agg(k.key, k.value::numeric - case when k.key = v_bseat::text then v_back else 0 end), '{}') into v_winmap
    from jsonb_each_text(v_won) k where k.value::numeric - case when k.key = v_bseat::text then v_back else 0 end > 0;
  update public.poker_seats x set stack = x.stack + coalesce((v_won ->> x.seat::text)::numeric, 0)
   where x.table_id = p_table and x.in_hand and not x.folded;
  update public.poker_seats x set hands = x.hands + 1, last_act = null where x.table_id = p_table and x.in_hand;
  update public.poker_tables x
     set status = 'open', street = 'show', turn_seat = null, deadline = null, shown = v_shown,
         -- won — сколько фишек вернулось игроку (с возвратом), win — сколько он выиграл (без возврата)
         result = jsonb_build_object('hand', g.hand_no, 'pots', v_pots, 'won', v_won, 'showdown', v_live > 1,
                                     'back', case when v_back > 0 then jsonb_build_object(v_bseat::text, v_back) else '{}'::jsonb end,
                                     'win', v_winmap),
         next_at = now() + case when v_live > 1 then interval '6 seconds' else interval '3 seconds' end
   where x.id = p_table;
  perform public.poker_log(p_table, jsonb_build_object('kind', 'win', 'hand', g.hand_no, 'won', v_won, 'win', v_winmap, 'pots', v_pots, 'shown', v_shown));

  -- фишки кончились: бот за тестовым столом докупает, человек встаёт из-за стола (может сесть снова)
  update public.poker_seats x set stack = 100 * g.bb, buyin = x.buyin + 100 * g.bb
   where x.table_id = p_table and x.left_at is null and x.stack = 0 and x.bot_name is not null;
  update public.poker_seats x set cashout = 0, left_at = now(), left_kind = 'bust'
   where x.table_id = p_table and x.left_at is null and x.stack = 0;
  perform public.poker_close_if_empty(p_table);
end $function$;

-- 11. После хода: кто следующий, или круг окончен (выложить карты), или раздача окончена
create or replace function public.poker_advance(p_table bigint, p_from integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  v_live integer; v_can integer; v_owe boolean; v_seat integer; v_from integer := p_from; v_new integer[];
begin
  loop
    select * into g from public.poker_tables x where x.id = p_table;
    select count(*) filter (where not x.folded), count(*) filter (where not x.folded and not x.allin),
           coalesce(bool_or(not x.folded and not x.allin and x.bet < g.cur_bet), false)
      into v_live, v_can, v_owe
      from public.poker_seats x where x.table_id = p_table and x.in_hand;
    if v_live <= 1 then perform public.poker_finish(p_table); return; end if;
    -- ставить есть кому: двое и больше могут ходить, или один должен ответить на ставку
    if v_can >= 2 or v_owe then
      v_seat := public.poker_actor(p_table, v_from);
      if v_seat is not null then
        update public.poker_tables x set turn_seat = v_seat, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_table;
        return;
      end if;
    end if;
    -- круг ставок окончен: ставки уходят в банк
    update public.poker_seats x set bet = 0, acted = false,
           last_act = case when x.folded then 'fold' when x.allin then 'allin' end
     where x.table_id = p_table and x.in_hand;
    if g.street = 'river' then perform public.poker_finish(p_table); return; end if;
    -- первая карта колоды «сжигается», как за настоящим столом
    if g.street = 'pre' then v_new := g.deck[2:4]; g.deck := g.deck[5:];
    else v_new := g.deck[2:2]; g.deck := g.deck[3:]; end if;
    update public.poker_tables x
       set board = x.board || v_new, deck = g.deck, cur_bet = 0, min_raise = x.bb, turn_seat = null, deadline = null,
           street = case g.street when 'pre' then 'flop' when 'flop' then 'turn' else 'river' end
     where x.id = p_table;
    perform public.poker_log(p_table, jsonb_build_object('kind', 'street',
      'street', case g.street when 'pre' then 'flop' when 'flop' then 'turn' else 'river' end, 'cards', to_jsonb(v_new)));
    v_from := g.button_seat;   -- после флопа первым ходит первый слева от дилера
  end loop;
end $function$;

-- 12. Новая раздача
create or replace function public.poker_deal(p_table bigint)
returns boolean
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  v_n integer; v_btn integer; v_sb integer; v_bb integer; v_deck integer[]; r record; k integer := 0;
begin
  select * into g from public.poker_tables x where x.id = p_table for update;
  if g.status <> 'open' then return false; end if;
  select count(*) into v_n from public.poker_seats x where x.table_id = p_table and x.left_at is null and x.stack > 0;
  if v_n < 2 then
    update public.poker_tables x set next_at = null where x.id = p_table;
    return false;
  end if;
  update public.poker_seats x set in_hand = false, hole = '{}', folded = false, allin = false, acted = false, bet = 0, put = 0, last_act = null
   where x.table_id = p_table and (x.in_hand or x.left_at is null);
  update public.poker_seats x set in_hand = true where x.table_id = p_table and x.left_at is null and x.stack > 0;
  -- дилер: в первой раздаче — случайно, потом — следующий по часовой
  if g.button_seat is null then
    select x.seat into v_btn from public.poker_seats x where x.table_id = p_table and x.in_hand and x.left_at is null order by random() limit 1;
  else
    select x.seat into v_btn from public.poker_seats x where x.table_id = p_table and x.in_hand and x.left_at is null
     order by public.poker_after(g.button_seat, x.seat) limit 1;
  end if;
  if v_n = 2 then v_sb := v_btn;   -- вдвоём малый блайнд ставит дилер
  else
    select x.seat into v_sb from public.poker_seats x where x.table_id = p_table and x.in_hand and x.left_at is null
     order by public.poker_after(v_btn, x.seat) limit 1;
  end if;
  select x.seat into v_bb from public.poker_seats x where x.table_id = p_table and x.in_hand and x.left_at is null
   order by public.poker_after(v_sb, x.seat) limit 1;
  v_deck := array(select c from generate_series(0, 51) c order by gen_random_uuid());
  -- раздача по одной карте по кругу, начиная слева от дилера
  for r in select x.id from public.poker_seats x where x.table_id = p_table and x.in_hand and x.left_at is null
           order by public.poker_after(v_btn, x.seat) loop
    k := k + 1;
    update public.poker_seats x set hole = array[v_deck[k], v_deck[k + v_n]] where x.id = r.id;
  end loop;
  v_deck := v_deck[2 * v_n + 1:];
  -- блайнды (если фишек меньше — сколько есть, это ва-банк)
  update public.poker_seats x set stack = x.stack - least(x.stack, g.sb), bet = least(x.stack, g.sb), put = least(x.stack, g.sb),
         allin = x.stack <= g.sb, last_act = case when x.stack <= g.sb then 'allin' else 'sb' end
   where x.table_id = p_table and x.left_at is null and x.seat = v_sb;
  update public.poker_seats x set stack = x.stack - least(x.stack, g.bb), bet = least(x.stack, g.bb), put = least(x.stack, g.bb),
         allin = x.stack <= g.bb, last_act = case when x.stack <= g.bb then 'allin' else 'bb' end
   where x.table_id = p_table and x.left_at is null and x.seat = v_bb;
  update public.poker_tables x
     set status = 'play', street = 'pre', hand_no = x.hand_no + 1, button_seat = v_btn, sb_seat = v_sb, bb_seat = v_bb,
         deck = v_deck, board = '{}', cur_bet = g.bb, min_raise = g.bb, shown = '{}', result = null, next_at = null,
         turn_seat = null, deadline = null, active_at = now()
   where x.id = p_table;
  perform public.poker_log(p_table, jsonb_build_object('kind', 'hand', 'hand', g.hand_no + 1, 'button', v_btn, 'sb', v_sb, 'bb', v_bb,
    'seats', (select jsonb_agg(x.seat order by public.poker_after(v_btn, x.seat)) from public.poker_seats x
               where x.table_id = p_table and x.in_hand and x.left_at is null)));
  perform public.poker_advance(p_table, v_bb);   -- первым ходит следующий после большого блайнда (вдвоём — дилер)
  return true;
end $function$;

-- 13. Ход. p_kind: fold | check | call | raise (p_to — до скольки поднять ставку на этом круге) | allin
create or replace function public.poker_move(p_table bigint, p_user uuid, p_kind text, p_to numeric, p_auto boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  me public.poker_seats%rowtype;
  v_kind text := p_kind; v_call numeric; v_to numeric; v_pay numeric; v_act text;
begin
  select * into g from public.poker_tables x where x.id = p_table for update;
  if not found or g.status <> 'play' then raise exception 'poker_gone'; end if;
  select * into me from public.poker_seats x where x.table_id = p_table and x.user_id = p_user and x.left_at is null;
  if not found or not me.in_hand or me.folded or me.allin or me.seat is distinct from g.turn_seat then raise exception 'poker_not_turn'; end if;
  v_call := greatest(g.cur_bet - me.bet, 0);
  if v_kind = 'allin' then
    v_to := me.bet + me.stack;
    v_kind := case when v_to <= g.cur_bet then 'call' else 'raise' end;
  elsif v_kind = 'raise' then
    v_to := round(p_to, 2);
    if v_to is null then raise exception 'poker_bad_move'; end if;
    if v_to > me.bet + me.stack then v_to := me.bet + me.stack; end if;   -- больше, чем есть, — это ва-банк
  end if;

  if v_kind = 'fold' then
    v_act := 'fold'; v_pay := 0;
    update public.poker_seats x set folded = true, acted = true, last_act = v_act where x.id = me.id;
  elsif v_kind = 'check' then
    if v_call > 0 then raise exception 'poker_bad_move'; end if;
    v_act := 'check'; v_pay := 0;
    update public.poker_seats x set acted = true, last_act = v_act where x.id = me.id;
  elsif v_kind = 'call' then
    if v_call <= 0 then raise exception 'poker_bad_move'; end if;
    v_pay := least(v_call, me.stack);
    v_act := case when v_pay = me.stack then 'allin' else 'call' end;
    update public.poker_seats x set stack = x.stack - v_pay, bet = x.bet + v_pay, put = x.put + v_pay, acted = true,
           allin = v_pay = me.stack, last_act = v_act where x.id = me.id;
  elsif v_kind = 'raise' then
    -- повышать можно, если после последнего полного повышения ещё не ходил и фишек больше, чем нужно уравнять
    if me.acted or me.stack <= v_call or v_to <= g.cur_bet then raise exception 'poker_bad_move'; end if;
    if v_to < g.cur_bet + g.min_raise and v_to < me.bet + me.stack then raise exception 'poker_small_raise'; end if;
    v_pay := v_to - me.bet;
    v_act := case when v_pay = me.stack then 'allin' when g.cur_bet = 0 then 'bet' else 'raise' end;
    update public.poker_seats x set stack = x.stack - v_pay, bet = v_to, put = x.put + v_pay, acted = true,
           allin = v_pay = me.stack, last_act = v_act where x.id = me.id;
    if v_to - g.cur_bet >= g.min_raise then
      -- полное повышение: всем остальным снова надо ходить, и они могут повысить
      update public.poker_seats x set acted = false
       where x.table_id = p_table and x.in_hand and not x.folded and not x.allin and x.id <> me.id;
      update public.poker_tables x set cur_bet = v_to, min_raise = v_to - g.cur_bet where x.id = p_table;
    else
      -- ва-банк меньше полного повышения: доставить надо, но повысить снова уже ходившие не могут
      update public.poker_tables x set cur_bet = v_to where x.id = p_table;
    end if;
  else
    raise exception 'poker_bad_move';
  end if;
  if not coalesce(p_auto, false) then update public.poker_seats x set misses = 0 where x.id = me.id; end if;
  perform public.poker_log(p_table, jsonb_build_object('kind', 'act', 'seat', me.seat, 'act', v_act, 'pay', v_pay,
                                                      'bet', me.bet + v_pay, 'auto', coalesce(p_auto, false)));
  perform public.poker_advance(p_table, me.seat);
end $function$;

-- 14. Встать из-за стола: посреди раздачи — пас; остаток фишек — на баланс
create or replace function public.poker_stand(p_table bigint, p_seat_id bigint, p_kind text)
returns numeric
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  p public.poker_seats%rowtype;
  v_live boolean;
begin
  select * into g from public.poker_tables x where x.id = p_table for update;
  select * into p from public.poker_seats x where x.id = p_seat_id and x.table_id = p_table and x.left_at is null;
  if not found then return null; end if;
  v_live := g.status = 'play' and p.in_hand and not p.folded;
  if v_live then
    update public.poker_seats x set folded = true, acted = true, last_act = 'fold' where x.id = p.id;
  end if;
  update public.poker_seats x set cashout = x.stack, left_at = now(), left_kind = p_kind where x.id = p.id;
  perform public.poker_log(p_table, jsonb_build_object('kind', 'leave', 'seat', p.seat, 'why', p_kind));
  if v_live then
    if g.turn_seat = p.seat then perform public.poker_advance(p_table, p.seat);
    elsif (select count(*) from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded) <= 1 then
      perform public.poker_finish(p_table);
    end if;
  end if;
  perform public.poker_close_if_empty(p_table);
  return p.stack;
end $function$;

-- 15. Боты (только тестовые столы админа). Пять постоянных номеров.
create or replace function public.poker_bot_list()
returns table (id uuid, name text)
language sql immutable set search_path to ''
as $function$
  values ('00000000-0000-4000-8000-0000000000c1'::uuid, 'Бот Альфа'),
         ('00000000-0000-4000-8000-0000000000c2'::uuid, 'Бот Бета'),
         ('00000000-0000-4000-8000-0000000000c3'::uuid, 'Бот Гамма'),
         ('00000000-0000-4000-8000-0000000000c4'::uuid, 'Бот Дельта'),
         ('00000000-0000-4000-8000-0000000000c5'::uuid, 'Бот Эпсилон')
$function$;

-- Ход бота: сильная рука — ставит или повышает, средняя — уравнивает, слабая — чек или пас. Иногда ва-банк (проверка побочных банков).
create or replace function public.poker_bot_move(p_table bigint, p_bot uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  p public.poker_seats%rowtype;
  v_call numeric; v_pot numeric; v_cat integer; v_str integer; v_rnd float8 := random(); v_to numeric;
begin
  select * into g from public.poker_tables x where x.id = p_table;
  select * into p from public.poker_seats x where x.table_id = p_table and x.user_id = p_bot and x.left_at is null;
  v_call := greatest(g.cur_bet - p.bet, 0);
  select coalesce(sum(x.put), 0) into v_pot from public.poker_seats x where x.table_id = p_table and x.in_hand;
  v_cat := public.poker_eval(p.hole || g.board) >> 20;
  if cardinality(g.board) = 0 then
    v_str := case when p.hole[1] / 4 = p.hole[2] / 4 then 2 when p.hole[1] / 4 + 2 >= 10 and p.hole[2] / 4 + 2 >= 10 then 1 else 0 end;
  else
    v_str := case when v_cat >= 2 then 2 when v_cat = 1 then 1 else 0 end;
  end if;
  if v_str = 2 and v_rnd < 0.06 and not p.acted then
    perform public.poker_move(p_table, p_bot, 'allin', null, false);
  elsif v_str = 2 and v_rnd < 0.5 and not p.acted and p.stack > v_call then
    v_to := g.cur_bet + greatest(g.min_raise, round(v_pot * 0.5, 2));
    perform public.poker_move(p_table, p_bot, 'raise', v_to, false);
  elsif v_call = 0 then
    perform public.poker_move(p_table, p_bot, 'check', null, false);
  elsif v_str >= 1 or v_call <= 2 * g.bb or (v_rnd < 0.25 and v_call <= p.stack * 0.1) then
    perform public.poker_move(p_table, p_bot, 'call', null, false);
  else
    perform public.poker_move(p_table, p_bot, 'fold', null, false);
  end if;
end $function$;

-- 16. Часы стола: ход бота, время хода вышло, пора начать раздачу, пустой или заброшенный стол
create or replace function public.poker_tick(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  p public.poker_seats%rowtype;
begin
  select * into g from public.poker_tables x where x.id = p_table for update;
  if not found or g.status = 'closed' then return; end if;
  if g.status = 'play' then
    select * into p from public.poker_seats x
     where x.table_id = p_table and x.left_at is null and x.seat = g.turn_seat and x.in_hand and not x.folded and not x.allin;
    if not found then perform public.poker_advance(p_table, coalesce(g.turn_seat, g.button_seat)); return; end if;
    -- бот ходит через 1,5 секунды после начала своего хода (ход длится 30 секунд)
    if p.bot_name is not null then
      if g.deadline - interval '28.5 seconds' <= now() then perform public.poker_bot_move(p_table, p.user_id); end if;
      return;
    end if;
    if g.deadline >= now() - interval '1 second' then return; end if;
    update public.poker_seats x set misses = x.misses + 1 where x.id = p.id;
    if p.misses + 1 >= 2 then
      perform public.poker_stand(p_table, p.id, 'afk');            -- второй пропуск подряд — встаёт из-за стола
    elsif g.cur_bet <= p.bet then
      perform public.poker_move(p_table, p.user_id, 'check', null, true);
    else
      perform public.poker_move(p_table, p.user_id, 'fold', null, true);
    end if;
  else
    if g.active_at < now() - interval '24 hours' then
      perform public.poker_close(p_table);
    elsif not exists (select 1 from public.poker_seats x where x.table_id = p_table and x.left_at is null and x.bot_name is null) then
      perform public.poker_close_if_empty(p_table);              -- людей нет — раздач нет
    elsif g.next_at is not null and g.next_at <= now() then
      perform public.poker_deal(p_table);
    end if;
  end if;
end $function$;

-- Пора ли трогать часы стола (вызывают вид, список и расписание)
create or replace function public.poker_due(p_table bigint)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.poker_tables g where g.id = p_table and (
           (g.status = 'play' and (g.deadline < now() - interval '1 second'
              or (g.deadline - interval '28.5 seconds' <= now()
                  and exists (select 1 from public.poker_seats x where x.table_id = g.id and x.left_at is null
                              and x.seat = g.turn_seat and x.bot_name is not null))))
        or (g.status = 'open' and (g.next_at <= now() or g.active_at < now() - interval '24 hours'
              or not exists (select 1 from public.poker_seats x where x.table_id = g.id and x.left_at is null and x.bot_name is null)))))
$function$;

-- Раз в минуту (pg_cron): столы, где все закрыли приложение, тоже идут дальше — пропустившие ход встают, монеты возвращаются
create or replace function public.poker_tick_all()
returns void
language plpgsql security definer set search_path to ''
as $function$
declare r record;
begin
  for r in select g.id from public.poker_tables g where g.status <> 'closed' loop
    if public.poker_due(r.id) then perform public.poker_tick(r.id); end if;
  end loop;
end $function$;

-- 17. Не сидит ли уже за другим столом
create or replace function public.poker_busy(p_user uuid, p_except bigint)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.poker_seats x join public.poker_tables g on g.id = x.table_id
                  where x.user_id = p_user and x.left_at is null and g.status <> 'closed' and g.id is distinct from p_except)
$function$;

-- 18. Открыть стол (и сразу сесть за него). p_test — тестовый стол админа с ботами (без монет и уведомлений).
create or replace function public.poker_create(p_level integer, p_buyin numeric, p_test boolean default false)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  v_sb numeric; v_bb numeric; v_buy numeric := round(p_buyin, 2); v_id bigint; v_test boolean := coalesce(p_test, false);
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if v_test and not public.is_admin() then raise exception 'not_admin'; end if;
  select l.sb, l.bb into v_sb, v_bb from public.poker_level(p_level) l;
  if v_bb is null then raise exception 'poker_bad_level'; end if;
  if v_test and v_buy is null then v_buy := 100 * v_bb; end if;
  if v_buy is null or v_buy < 40 * v_bb or v_buy > 100 * v_bb then raise exception 'poker_bad_buyin'; end if;
  perform pg_advisory_xact_lock(hashtext('poker:tables'));
  if not v_test and (select count(*) from public.poker_tables g where g.status <> 'closed' and not g.test) >= 3 then
    raise exception 'poker_too_many';
  end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));   -- под этой блокировкой: два быстрых нажатия не посадят за два стола
  if public.poker_busy(uid, null) then raise exception 'poker_busy'; end if;
  if not v_test and public.coins_of(uid) < v_buy then raise exception 'poker_not_enough'; end if;
  insert into public.poker_tables (creator, level, sb, bb, test) values (uid, p_level, v_sb, v_bb, v_test) returning id into v_id;
  insert into public.poker_seats (table_id, user_id, seat, test, buyin, stack) values (v_id, uid, 0, v_test, v_buy, v_buy);
  if not v_test and exists (select 1 from public.push_subscriptions ps where ps.user_id <> uid and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'poker', 'table_id', v_id, 'event', 'table'));
  end if;
  return v_id;
end $function$;
revoke all on function public.poker_create(integer, numeric, boolean) from public, anon;
grant execute on function public.poker_create(integer, numeric, boolean) to authenticated;

-- 19. Сесть за стол
create or replace function public.poker_sit(p_table bigint, p_buyin numeric)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.poker_tables%rowtype;
  v_buy numeric := round(p_buyin, 2); v_seat integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into g from public.poker_tables x where x.id = p_table for update;
  if not found or g.status = 'closed' or (g.test and g.creator <> uid) then raise exception 'poker_gone'; end if;
  if exists (select 1 from public.poker_seats x where x.table_id = p_table and x.user_id = uid and x.left_at is null) then return; end if;
  if v_buy is null or v_buy < 40 * g.bb or v_buy > 100 * g.bb then raise exception 'poker_bad_buyin'; end if;
  select min(s) into v_seat from generate_series(0, 5) s
   where s not in (select x.seat from public.poker_seats x where x.table_id = p_table and x.left_at is null);
  if v_seat is null then raise exception 'poker_full'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  if public.poker_busy(uid, p_table) then raise exception 'poker_busy'; end if;
  if not g.test and public.coins_of(uid) < v_buy then raise exception 'poker_not_enough'; end if;
  insert into public.poker_seats (table_id, user_id, seat, test, buyin, stack) values (p_table, uid, v_seat, g.test, v_buy, v_buy);
  update public.poker_tables x set active_at = now() where x.id = p_table;
  perform public.poker_log(p_table, jsonb_build_object('kind', 'sit', 'seat', v_seat));
  perform public.poker_schedule(p_table);
end $function$;
revoke all on function public.poker_sit(bigint, numeric) from public, anon;
grant execute on function public.poker_sit(bigint, numeric) to authenticated;

-- 20. Докупить фишки (между раздачами или после паса), до 100 больших блайндов
create or replace function public.poker_topup(p_table bigint, p_amount numeric)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.poker_tables%rowtype;
  me public.poker_seats%rowtype;
  v_amt numeric := round(p_amount, 2);
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into g from public.poker_tables x where x.id = p_table for update;
  if not found or g.status = 'closed' then raise exception 'poker_gone'; end if;
  select * into me from public.poker_seats x where x.table_id = p_table and x.user_id = uid and x.left_at is null;
  if not found then raise exception 'poker_gone'; end if;
  if g.status = 'play' and me.in_hand and not me.folded then raise exception 'poker_in_hand'; end if;
  if v_amt is null or v_amt <= 0 or me.stack + v_amt > 100 * g.bb then raise exception 'poker_bad_buyin'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  if not g.test and public.coins_of(uid) < v_amt then raise exception 'poker_not_enough'; end if;
  update public.poker_seats x set buyin = x.buyin + v_amt, stack = x.stack + v_amt where x.id = me.id;
  perform public.poker_log(p_table, jsonb_build_object('kind', 'topup', 'seat', me.seat));
  perform public.poker_schedule(p_table);
end $function$;
revoke all on function public.poker_topup(bigint, numeric) from public, anon;
grant execute on function public.poker_topup(bigint, numeric) to authenticated;

-- 21. Ход игрока (кнопки на телефоне)
create or replace function public.poker_act(p_table bigint, p_kind text, p_to numeric default null)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.poker_move(p_table, auth.uid(), p_kind, p_to, false);
end $function$;
revoke all on function public.poker_act(bigint, text, numeric) from public, anon;
grant execute on function public.poker_act(bigint, text, numeric) to authenticated;

-- 22. Встать из-за стола (кнопка «Выйти»): возвращает, сколько монет вернулось
create or replace function public.poker_leave(p_table bigint)
returns numeric
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid(); v_id bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform 1 from public.poker_tables x where x.id = p_table for update;
  select x.id into v_id from public.poker_seats x where x.table_id = p_table and x.user_id = uid and x.left_at is null;
  if v_id is null then return 0; end if;
  return public.poker_stand(p_table, v_id, 'self');
end $function$;
revoke all on function public.poker_leave(bigint) from public, anon;
grant execute on function public.poker_leave(bigint) to authenticated;

-- 23. Посадить / убрать бота (только админ, только свой тестовый стол)
create or replace function public.poker_add_bot(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.poker_tables%rowtype;
  v_bot uuid; v_name text; v_seat integer;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into g from public.poker_tables x where x.id = p_table for update;
  if not found or not g.test or g.status = 'closed' or g.creator <> uid then raise exception 'poker_gone'; end if;
  select min(s) into v_seat from generate_series(0, 5) s
   where s not in (select x.seat from public.poker_seats x where x.table_id = p_table and x.left_at is null);
  if v_seat is null then raise exception 'poker_full'; end if;
  select b.id, b.name into v_bot, v_name from public.poker_bot_list() b
   where b.id not in (select x.user_id from public.poker_seats x where x.table_id = p_table and x.left_at is null)
   order by b.id limit 1;
  insert into public.poker_seats (table_id, user_id, seat, bot_name, test, buyin, stack) values (p_table, v_bot, v_seat, v_name, true, 100 * g.bb, 100 * g.bb);
  perform public.poker_log(p_table, jsonb_build_object('kind', 'sit', 'seat', v_seat));
  perform public.poker_schedule(p_table);
end $function$;
revoke all on function public.poker_add_bot(bigint) from public, anon;
grant execute on function public.poker_add_bot(bigint) to authenticated;

create or replace function public.poker_remove_bot(p_table bigint, p_bot uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid(); v_id bigint;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  perform 1 from public.poker_tables x where x.id = p_table and x.test and x.creator = uid for update;
  if not found then raise exception 'poker_gone'; end if;
  select x.id into v_id from public.poker_seats x where x.table_id = p_table and x.user_id = p_bot and x.bot_name is not null and x.left_at is null;
  if v_id is not null then perform public.poker_stand(p_table, v_id, 'self'); end if;
end $function$;
revoke all on function public.poker_remove_bot(bigint, uuid) from public, anon;
grant execute on function public.poker_remove_bot(bigint, uuid) to authenticated;

-- 24. Вид стола для телефона: свои карты, чужие — только числом (до вскрытия), что можно сделать в свой ход
create or replace function public.poker_view(p_table bigint)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.poker_tables%rowtype;
  me public.poker_seats%rowtype;
  v_last public.poker_seats%rowtype;
  v_players jsonb; v_pot numeric := 0; v_turn boolean := false; v_call numeric := 0; v_my jsonb; v_gone jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if public.poker_due(p_table) then perform public.poker_tick(p_table); end if;
  select * into g from public.poker_tables x where x.id = p_table;
  if not found then raise exception 'poker_gone'; end if;
  select * into me from public.poker_seats x where x.table_id = p_table and x.user_id = uid and x.left_at is null;
  if me.id is null then
    select * into v_last from public.poker_seats x where x.table_id = p_table and x.user_id = uid order by x.id desc limit 1;
    -- не сидит: открытый стол можно посмотреть; тестовый чужой и закрытый (где не сидел) — нет
    if (g.test and g.creator <> uid) or (g.status = 'closed' and v_last.id is null) then raise exception 'poker_gone'; end if;
    if v_last.id is not null and v_last.left_at > now() - interval '30 minutes' then
      v_gone := jsonb_build_object('kind', v_last.left_kind, 'cashout', v_last.cashout, 'net', v_last.cashout - v_last.buyin);
    end if;
  end if;

  if g.status = 'play' then
    select coalesce(sum(x.put - x.bet), 0) into v_pot from public.poker_seats x where x.table_id = p_table and x.in_hand;
  end if;

  select jsonb_agg(jsonb_build_object(
           'seat', x.seat, 'id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
           'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
           'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end, 'bot', x.bot_name is not null,
           'me', x.user_id = uid, 'stack', x.stack, 'bet', x.bet, 'in_hand', x.in_hand, 'folded', x.folded, 'allin', x.allin,
           'act', x.last_act,
           -- свои карты видно всегда, чужие — только открытые на вскрытии
           'cards', case when x.in_hand and (x.user_id = uid or g.shown ? x.seat::text) then to_jsonb(x.hole) end,
           'hidden', x.in_hand and not x.folded and x.user_id <> uid and not (g.shown ? x.seat::text) and cardinality(x.hole) = 2
         ) order by x.seat)
    into v_players
    from public.poker_seats x left join public.profiles pr on pr.id = x.user_id
   where x.table_id = p_table and x.left_at is null;

  if me.id is not null then
    v_turn := g.status = 'play' and me.in_hand and not me.folded and not me.allin and me.seat = g.turn_seat;
    v_call := least(greatest(g.cur_bet - me.bet, 0), me.stack);
    v_my := jsonb_build_object(
      'seat', me.seat, 'stack', me.stack, 'buyin', me.buyin, 'bet', me.bet, 'in_hand', me.in_hand, 'folded', me.folded, 'allin', me.allin,
      'hole', case when me.in_hand then to_jsonb(me.hole) end,
      'turn', v_turn, 'call', v_call,
      'can_check', v_turn and g.cur_bet <= me.bet,
      'can_raise', v_turn and not me.acted and me.stack > greatest(g.cur_bet - me.bet, 0),
      'min_to', least(g.cur_bet + g.min_raise, me.bet + me.stack), 'max_to', me.bet + me.stack,
      'can_topup', not (g.status = 'play' and me.in_hand and not me.folded) and me.stack < 100 * g.bb,
      'topup_max', greatest(100 * g.bb - me.stack, 0));
  end if;

  return jsonb_build_object(
    'id', g.id, 'status', g.status, 'version', g.version, 'test', g.test, 'level', g.level, 'sb', g.sb, 'bb', g.bb,
    'min_buy', 40 * g.bb, 'max_buy', 100 * g.bb, 'creator', g.creator = uid,
    'server_ms', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'deadline_ms', (extract(epoch from g.deadline) * 1000)::bigint,
    'next_ms', (extract(epoch from g.next_at) * 1000)::bigint,
    'hand', g.hand_no, 'street', g.street, 'board', to_jsonb(g.board), 'pot', v_pot, 'cur_bet', g.cur_bet,
    'button', g.button_seat, 'sb_seat', g.sb_seat, 'bb_seat', g.bb_seat, 'turn', case when g.status = 'play' then g.turn_seat end,
    'result', case when g.status = 'open' then g.result end,
    'log', g.log,
    'players', coalesce(v_players, '[]'),
    'my', v_my, 'gone', v_gone
  );
end $function$;
revoke all on function public.poker_view(bigint) from public, anon;
grant execute on function public.poker_view(bigint) to authenticated;

-- 25. Список столов и моя история (последние 3 дня)
create or replace function public.poker_list()
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  r record; v_tables jsonb; v_hist jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  for r in select g.id from public.poker_tables g where g.status <> 'closed' loop
    if public.poker_due(r.id) then perform public.poker_tick(r.id); end if;
  end loop;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.mine desc, t.created_at desc), '[]') into v_tables from (
    select g.id, g.level, g.sb, g.bb, g.test, g.status, g.created_at,
           40 * g.bb as min_buy, 100 * g.bb as max_buy,
           exists (select 1 from public.poker_seats x where x.table_id = g.id and x.user_id = uid and x.left_at is null) as mine,
           (select pr.display_name from public.profiles pr where pr.id = g.creator) as creator_name,
           (select jsonb_agg(jsonb_build_object('id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
                                                'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
                                                'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end) order by x.seat)
              from public.poker_seats x left join public.profiles pr on pr.id = x.user_id
             where x.table_id = g.id and x.left_at is null) as players
      from public.poker_tables g
     where g.status <> 'closed' and (not g.test or g.creator = uid)
  ) t;
  select coalesce(jsonb_agg(row_to_json(h)::jsonb order by h.left_at desc), '[]') into v_hist from (
    select x.id, x.table_id, g.sb, g.bb, x.buyin, x.cashout, x.cashout - x.buyin as net, x.hands, x.left_at, x.left_kind
      from public.poker_seats x join public.poker_tables g on g.id = x.table_id
     where x.user_id = uid and x.left_at > now() - interval '3 days' and not x.test
     order by x.left_at desc limit 15
  ) h;
  return jsonb_build_object('tables', v_tables, 'history', v_hist);
end $function$;
revoke all on function public.poker_list() from public, anon;
grant execute on function public.poker_list() to authenticated;

-- 26. Кому отправить уведомление (только с ключом сервера): 'table' — новый стол: всем, кто за ним не сидит
create or replace function public.push_poker_targets(p_id bigint, p_event text)
returns table (user_id uuid, creator_name text, sb numeric, bb numeric)
language sql stable security definer set search_path to ''
as $function$
  select distinct ps.user_id, coalesce(pr.display_name, 'Кто-то'), g.sb, g.bb
  from public.poker_tables g
  join public.push_subscriptions ps on ps.active
  left join public.profiles pr on pr.id = g.creator
  where g.id = p_id and p_event = 'table' and g.status <> 'closed' and not g.test
    and not exists (select 1 from public.poker_seats x where x.table_id = g.id and x.user_id = ps.user_id and x.left_at is null)
$function$;
revoke all on function public.push_poker_targets(bigint, text) from public, anon, authenticated;
grant execute on function public.push_poker_targets(bigint, text) to service_role;

-- Служебные функции — только для базы
revoke all on function public.poker_log(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.poker_actor(bigint, integer) from public, anon, authenticated;
revoke all on function public.poker_close(bigint) from public, anon, authenticated;
revoke all on function public.poker_close_if_empty(bigint) from public, anon, authenticated;
revoke all on function public.poker_schedule(bigint) from public, anon, authenticated;
revoke all on function public.poker_finish(bigint) from public, anon, authenticated;
revoke all on function public.poker_advance(bigint, integer) from public, anon, authenticated;
revoke all on function public.poker_deal(bigint) from public, anon, authenticated;
revoke all on function public.poker_move(bigint, uuid, text, numeric, boolean) from public, anon, authenticated;
revoke all on function public.poker_stand(bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.poker_bot_move(bigint, uuid) from public, anon, authenticated;
revoke all on function public.poker_tick(bigint) from public, anon, authenticated;
revoke all on function public.poker_due(bigint) from public, anon, authenticated;
revoke all on function public.poker_tick_all() from public, anon, authenticated;
revoke all on function public.poker_busy(uuid, bigint) from public, anon, authenticated;

-- 27. Расписание: раз в минуту (если в базе есть pg_cron)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('poker-tick', '* * * * *', 'select public.poker_tick_all()');
  end if;
end $$;
