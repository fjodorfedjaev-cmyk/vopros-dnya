-- «ВЕРЮ — НЕ ВЕРЮ»: комнаты на 3–6 человек, игра на монеты (ставка от 0). 21.11.2026.
--
-- Как устроено (простыми словами):
-- * Комната: создатель выбирает ставку, колоду «от [любая карта] до туза» (от двойки — полная, от туза — одни тузы)
--   и сколько джокеров (0–4). Мест — не больше 6 и не больше, чем карт в колоде. Ставка уходит «в банк» при входе,
--   выйти до старта можно — ставка возвращается. Открытых комнат — не больше 3; комната ждёт сутки;
--   один человек в открытой комнате минуту — комната закрывается. Уведомлений нет.
-- * Старт: создатель жмёт «Начать» (от 3 человек), у остальных 30 секунд нажать «Готов».
-- * Раздача: все карты по кругу. Четыре карты одного номинала на руках сразу уходят в биту (и при раздаче,
--   и каждый раз, когда кто-то забирает стопку). Джокеры в четвёрки не идут. Первым ходит случайный игрок.
-- * Начало круга: кладёшь рубашкой вверх сколько угодно карт и называешь номинал (любой из колоды).
-- * Следующий игрок:
--   «Доложить» — кладёт сколько угодно своих карт, номинал тот же;
--   «Не верю» — открываются последние положенные карты: враньё — всю стопку забирает тот, кто их положил,
--      новый круг начинает проверявший; правда — стопку забирает проверявший и пропускает ход;
--   «Верю» — открываются последние карты: правда — вся стопка уходит в биту, новый круг начинает поверивший;
--      враньё — стопку забирает поверивший и пропускает ход.
--   Джокер — любая карта: положить его всегда правда.
-- * Положил последние карты — выходишь, если их не разоблачили через «не верю» (после «доложить», «верю + правда»
--   и «верю + враньё» ты вышел; после «не верю + враньё» стопка возвращается к тебе). Проигрывает последний с картами.
-- * 30 секунд на ход. Не успел: в начале круга база честно кладёт одну карту, в ответ — докладывает одну.
--   Два пропуска подряд — выбываешь на последнее свободное место, карты уходят в биту.
--   «Выйти» во время игры — поражение (последнее свободное место, ставка не возвращается).
-- * Выплата за k-е место из N: 2 × ставка × (N − k) / (N − 1), до сотых (остаток копеек — первому); вышедший — 0.
-- * Карты на руках и в стопке видит только база; телефон получает свой вид (bluff_view): свою руку, сколько у кого
--   карт, сколько в стопке, названный номинал и карты, открытые при проверке.
--
-- Карта — число: 0..51 — обычные (номинал = карта / 4 + 2, где 11 — валет, 14 — туз; масть = карта % 4), 52..55 — джокеры.

-- 1. Комнаты
create table public.bluff_rooms (
  id bigint generated always as identity primary key,
  creator uuid not null references public.profiles (id) on delete cascade,
  stake integer not null check (stake between 0 and 100000),
  low_rank integer not null default 2 check (low_rank between 2 and 14),   -- колода: от этого номинала до туза
  jokers integer not null default 0 check (jokers between 0 and 4),
  test boolean not null default false,        -- тестовая комната админа с ботами
  status text not null default 'open' check (status in ('open', 'ready', 'play', 'finished', 'cancelled')),
  created_at timestamptz not null default now(),
  alone_since timestamptz,                    -- с какого момента в открытой комнате один человек (ставит триггер)
  deadline timestamptz,                       -- срок этапа: «Готов» или ход
  turn_seat integer,                          -- чей ход
  claim_rank integer,                         -- названный номинал круга (пусто — круг не начат, стол пуст)
  pile integer[] not null default '{}',       -- стопка: все карты круга, последние — сверху
  last_seat integer,                          -- кто клал последним
  last_n integer not null default 0,          -- сколько карт он положил (последние last_n карт стопки)
  bita integer not null default 0,            -- сколько карт ушло в биту
  version integer not null default 0,         -- растёт при каждом изменении (телефону — знак «перерисуй»)
  log jsonb not null default '[]',            -- последние действия (для экрана и анимаций)
  started_at timestamptz,
  finished_at timestamptz,
  rematch_of bigint references public.bluff_rooms (id) on delete set null,
  rematch_id bigint references public.bluff_rooms (id) on delete set null
);
create index bluff_rooms_status_idx on public.bluff_rooms (status, created_at);
alter table public.bluff_rooms enable row level security;
revoke all on public.bluff_rooms from anon, authenticated;

-- 2. Игроки. stake списан при входе, payout — выплата по итогу. У ботов профиля нет (только место за столом).
create table public.bluff_players (
  room_id bigint not null references public.bluff_rooms (id) on delete cascade,
  user_id uuid not null,
  bot_name text,
  seat integer not null,
  stake integer not null check (stake >= 0),
  payout numeric(12, 2),
  joined_at timestamptz not null default clock_timestamp(),
  ready boolean not null default false,
  hand integer[] not null default '{}',
  misses integer not null default 0,          -- сколько ходов подряд пропущено по времени
  place integer,                              -- место (1 — вышел первым); пусто — ещё играет
  out_kind text check (out_kind in ('done', 'afk', 'left', 'last')),
  primary key (room_id, user_id),
  constraint bluff_players_seat_key unique (room_id, seat) deferrable initially deferred
);
create index bluff_players_user_idx on public.bluff_players (user_id);
alter table public.bluff_players enable row level security;
revoke all on public.bluff_players from anon, authenticated;

-- 3. Баланс = книга монет + казино + лавка + дурак + покер + верю-не-верю − отложенное на заявки
create or replace function public.coins_of(p_user uuid)
returns numeric
language sql stable security definer set search_path to ''
as $function$
  select round(coalesce((select sum(l.amount) from public.points_ledger l where l.user_id = p_user), 0)
        + coalesce((select sum(coalesce(r.payout, 0) - r.bet) from public.casino_rounds r where r.user_id = p_user), 0)
        + coalesce((select sum(m.price - m.fee) from public.card_listings m where m.seller_id = p_user and m.status = 'sold'), 0)
        - coalesce((select sum(m.price) from public.card_listings m where m.buyer_id = p_user and m.status = 'sold'), 0)
        + coalesce((select sum(coalesce(d.payout, 0) - d.stake) from public.durak_players d where d.user_id = p_user), 0)
        + coalesce((select sum(coalesce(s.cashout, 0) - s.buyin) from public.poker_seats s where s.user_id = p_user and not s.test), 0)
        + coalesce((select sum(coalesce(b.payout, 0) - b.stake) from public.bluff_players b where b.user_id = p_user), 0)
        - coalesce((select sum(b.price) from public.card_bids b where b.buyer_id = p_user and b.status = 'active'), 0), 2)
$function$;

-- 4. Мелочи
-- Сколько карт в колоде: от номинала p_low до туза (по 4) + джокеры
create or replace function public.bluff_deck_n(p_low integer, p_jokers integer)
returns integer
language sql immutable set search_path to ''
as $function$ select (15 - p_low) * 4 + p_jokers $function$;
revoke all on function public.bluff_deck_n(integer, integer) from public, anon, authenticated;

-- Пять ботов (постоянные номера, чтобы «Ещё раз» сажал тех же)
create or replace function public.bluff_bot_list()
returns table (id uuid, name text)
language sql immutable set search_path to ''
as $function$
  values ('00000000-0000-4000-8000-0000000000c1'::uuid, 'Бот Альфа'),
         ('00000000-0000-4000-8000-0000000000c2'::uuid, 'Бот Бета'),
         ('00000000-0000-4000-8000-0000000000c3'::uuid, 'Бот Гамма'),
         ('00000000-0000-4000-8000-0000000000c4'::uuid, 'Бот Дельта'),
         ('00000000-0000-4000-8000-0000000000c5'::uuid, 'Бот Эпсилон')
$function$;
revoke all on function public.bluff_bot_list() from public, anon, authenticated;

-- Запись в журнал (10 последних; у каждой записи номер i — телефон показывает только новые)
create or replace function public.bluff_log(p_room bigint, p_entry jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v jsonb;
begin
  select g.log || jsonb_build_array(p_entry || jsonb_build_object('i', g.version + 1)) into v from public.bluff_rooms g where g.id = p_room;
  while jsonb_array_length(v) > 10 loop v := v - 0; end loop;
  update public.bluff_rooms g set log = v, version = g.version + 1 where g.id = p_room;
end $function$;
revoke all on function public.bluff_log(bigint, jsonb) from public, anon, authenticated;

-- Отменить комнату: ставки возвращаются (строки игроков удаляются — списание пропадает)
create or replace function public.bluff_cancel_room(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  delete from public.bluff_players x where x.room_id = p_room;
  update public.bluff_rooms g set status = 'cancelled', deadline = null, version = g.version + 1 where g.id = p_room;
end $function$;
revoke all on function public.bluff_cancel_room(bigint) from public, anon, authenticated;

-- Один человек в открытой комнате: триггер запоминает, с какого момента (ушедшие из открытой комнаты удаляются)
create or replace function public.bluff_alone_mark()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare r bigint;
begin
  if tg_op = 'DELETE' then r := old.room_id; else r := new.room_id; end if;
  update public.bluff_rooms g
     set alone_since = case when (select count(*) from public.bluff_players x where x.room_id = r and x.bot_name is null) = 1
                            then coalesce(g.alone_since, now()) else null end
   where g.id = r;
  return null;
end $function$;
revoke all on function public.bluff_alone_mark() from public, anon, authenticated;
create trigger bluff_players_alone after insert or delete on public.bluff_players
  for each row execute function public.bluff_alone_mark();

-- Когда закрыть комнату, где один человек (через минуту); не открыта, тестовая или не один — пусто
create or replace function public.bluff_alone_at(p_room bigint)
returns timestamptz
language sql stable security definer set search_path to ''
as $function$
  select g.alone_since + interval '1 minute' from public.bluff_rooms g
   where g.id = p_room and g.status = 'open' and not g.test and g.alone_since is not null
$function$;
revoke all on function public.bluff_alone_at(bigint) from public, anon, authenticated;

-- 5. Комната: создать, войти, боты
create or replace function public.bluff_new(p_user uuid, p_stake integer, p_low integer, p_jokers integer, p_from bigint, p_test boolean)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare v_id bigint;
begin
  if p_test and not exists (select 1 from public.admins a where a.user_id = p_user) then raise exception 'not_admin'; end if;
  if p_test then p_stake := 0; end if;
  if p_stake is null or p_stake < 0 or p_stake > 100000 then raise exception 'bluff_bad_stake'; end if;
  if p_low is null or p_low < 2 or p_low > 14 or p_jokers is null or p_jokers < 0 or p_jokers > 4 then raise exception 'bluff_bad_deck'; end if;
  if exists (select 1 from public.bluff_players x join public.bluff_rooms r on r.id = x.room_id
             where x.user_id = p_user and x.place is null and r.status in ('open', 'ready', 'play')) then
    raise exception 'bluff_busy';
  end if;
  perform pg_advisory_xact_lock(hashtext('bluff:rooms'));
  if not p_test and (select count(*) from public.bluff_rooms r where r.status in ('open', 'ready') and not r.test) >= 3 then
    raise exception 'bluff_too_many';
  end if;
  perform pg_advisory_xact_lock(hashtext('points:' || p_user::text));
  if public.coins_of(p_user) < p_stake then raise exception 'bluff_not_enough'; end if;
  insert into public.bluff_rooms (creator, stake, low_rank, jokers, rematch_of, test)
  values (p_user, p_stake, p_low, p_jokers, p_from, p_test) returning id into v_id;
  insert into public.bluff_players (room_id, user_id, seat, stake) values (v_id, p_user, 0, p_stake);
  return v_id;
end $function$;
revoke all on function public.bluff_new(uuid, integer, integer, integer, bigint, boolean) from public, anon, authenticated;

create or replace function public.bluff_create(p_stake integer, p_low integer, p_jokers integer, p_test boolean default false)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  return public.bluff_new(auth.uid(), p_stake, p_low, p_jokers, null, coalesce(p_test, false));
end $function$;
revoke all on function public.bluff_create(integer, integer, integer, boolean) from public, anon;
grant execute on function public.bluff_create(integer, integer, integer, boolean) to authenticated;

-- Мест: не больше 6 и не больше, чем карт в колоде
create or replace function public.bluff_max_seats(p_room bigint)
returns integer
language sql stable security definer set search_path to ''
as $function$ select least(6, public.bluff_deck_n(g.low_rank, g.jokers)) from public.bluff_rooms g where g.id = p_room $function$;
revoke all on function public.bluff_max_seats(bigint) from public, anon, authenticated;

create or replace function public.bluff_enter(p_room bigint, p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  v_seat integer;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or g.status <> 'open' then raise exception 'bluff_gone'; end if;
  if exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = p_user) then return; end if;
  if g.test then raise exception 'bluff_gone'; end if;
  if exists (select 1 from public.bluff_players x join public.bluff_rooms r on r.id = x.room_id
             where x.user_id = p_user and x.place is null and r.status in ('open', 'ready', 'play')) then
    raise exception 'bluff_busy';
  end if;
  if (select count(*) from public.bluff_players x where x.room_id = p_room) >= public.bluff_max_seats(p_room) then raise exception 'bluff_full'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || p_user::text));
  if public.coins_of(p_user) < g.stake then raise exception 'bluff_not_enough'; end if;
  select min(s) into v_seat from generate_series(0, 5) s
   where s not in (select x.seat from public.bluff_players x where x.room_id = p_room);
  insert into public.bluff_players (room_id, user_id, seat, stake) values (p_room, p_user, v_seat, g.stake);
  update public.bluff_rooms x set version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.bluff_enter(bigint, uuid) from public, anon, authenticated;

create or replace function public.bluff_join(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.bluff_tick(p_room);
  perform public.bluff_enter(p_room, auth.uid());
end $function$;
revoke all on function public.bluff_join(bigint) from public, anon;
grant execute on function public.bluff_join(bigint) to authenticated;

create or replace function public.bluff_add_bot(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
  v_bot uuid; v_name text; v_seat integer;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or not g.test or g.status <> 'open'
     or not exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'bluff_gone';
  end if;
  if (select count(*) from public.bluff_players x where x.room_id = p_room) >= public.bluff_max_seats(p_room) then raise exception 'bluff_full'; end if;
  select b.id, b.name into v_bot, v_name from public.bluff_bot_list() b
   where b.id not in (select x.user_id from public.bluff_players x where x.room_id = p_room)
   order by b.id limit 1;
  select min(s) into v_seat from generate_series(0, 5) s
   where s not in (select x.seat from public.bluff_players x where x.room_id = p_room);
  insert into public.bluff_players (room_id, user_id, seat, stake, bot_name, ready) values (p_room, v_bot, v_seat, 0, v_name, true);
  update public.bluff_rooms x set version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.bluff_add_bot(bigint) from public, anon;
grant execute on function public.bluff_add_bot(bigint) to authenticated;

create or replace function public.bluff_remove_bot(p_room bigint, p_bot uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid();
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  perform 1 from public.bluff_rooms x where x.id = p_room and x.test and x.status = 'open' for update;
  if not found or not exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'bluff_gone';
  end if;
  delete from public.bluff_players x where x.room_id = p_room and x.user_id = p_bot and x.bot_name is not null;
  update public.bluff_rooms x set version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.bluff_remove_bot(bigint, uuid) from public, anon;
grant execute on function public.bluff_remove_bot(bigint, uuid) to authenticated;

-- 6. Места и итог
-- «done» — избавился от карт (места сверху), «afk» / «left» — выбыл по времени или вышел сам (места снизу)
create or replace function public.bluff_place(p_room bigint, p_user uuid, p_kind text)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare v_n integer; v_place integer;
begin
  select count(*) into v_n from public.bluff_players x where x.room_id = p_room;
  if p_kind in ('afk', 'left') then
    v_place := v_n - (select count(*) from public.bluff_players x where x.room_id = p_room and x.out_kind in ('afk', 'left'));
  else
    v_place := 1 + (select count(*) from public.bluff_players x where x.room_id = p_room and x.out_kind = 'done');
  end if;
  update public.bluff_players x set place = v_place, out_kind = p_kind where x.room_id = p_room and x.user_id = p_user;
  return v_place;
end $function$;
revoke all on function public.bluff_place(bigint, uuid, text) from public, anon, authenticated;

create or replace function public.bluff_finish(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  v_n integer;
  v_rest numeric;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  select count(*) into v_n from public.bluff_players x where x.room_id = p_room;
  -- по местам: 2 × ставка × (N − место) / (N − 1); вышедший сам не получает ничего — его доля идёт первому месту
  update public.bluff_players x
     set payout = case when x.out_kind = 'left' then 0
                       else floor(2.0 * g.stake * (v_n - x.place) / greatest(v_n - 1, 1) * 100) / 100 end
   where x.room_id = p_room;
  v_rest := g.stake * v_n - (select sum(x.payout) from public.bluff_players x where x.room_id = p_room);
  update public.bluff_players x set payout = x.payout + v_rest where x.room_id = p_room and x.place = 1;
  update public.bluff_rooms x set status = 'finished', finished_at = now(), deadline = null, turn_seat = null, version = x.version + 1
   where x.id = p_room;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'end'));
end $function$;
revoke all on function public.bluff_finish(bigint) from public, anon, authenticated;

-- Конец партии? Остался один с картами — он последний; в тестовой комнате не осталось людей — места ботам по числу карт.
-- Возвращает true, если партия закончилась.
create or replace function public.bluff_end_check(p_room bigint)
returns boolean
language plpgsql security definer set search_path to ''
as $function$
declare g public.bluff_rooms%rowtype; r record;
begin
  select * into g from public.bluff_rooms x where x.id = p_room;
  if g.status <> 'play' then return g.status = 'finished'; end if;
  if g.test and not exists (select 1 from public.bluff_players x where x.room_id = p_room and x.place is null and x.bot_name is null) then
    for r in select x.user_id from public.bluff_players x where x.room_id = p_room and x.place is null
             order by cardinality(x.hand), x.seat loop
      perform public.bluff_place(p_room, r.user_id, 'done');
    end loop;
    perform public.bluff_finish(p_room);
    return true;
  end if;
  if (select count(*) from public.bluff_players x where x.room_id = p_room and x.place is null) <= 1 then
    update public.bluff_players x
       set place = 1 + (select count(*) from public.bluff_players y where y.room_id = p_room and y.out_kind = 'done'), out_kind = 'last'
     where x.room_id = p_room and x.place is null;
    perform public.bluff_finish(p_room);
    return true;
  end if;
  return false;
end $function$;
revoke all on function public.bluff_end_check(bigint) from public, anon, authenticated;

-- Следующий по кругу, кто ещё играет (не считая p_seat)
create or replace function public.bluff_next(p_room bigint, p_seat integer)
returns integer
language sql stable security definer set search_path to ''
as $function$
  select x.seat from public.bluff_players x
   where x.room_id = p_room and x.place is null and x.seat <> p_seat
   order by (x.seat < p_seat), x.seat limit 1
$function$;
revoke all on function public.bluff_next(bigint, integer) from public, anon, authenticated;

-- Четыре одного номинала на руках — в биту (показываются всем). Возвращает, сколько карт ушло.
create or replace function public.bluff_fours(p_room bigint, p_user uuid)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare p public.bluff_players%rowtype; v_ranks integer[]; v_out integer[];
begin
  select * into p from public.bluff_players x where x.room_id = p_room and x.user_id = p_user;
  select array_agg(t.rk order by t.rk) into v_ranks
    from (select c / 4 + 2 as rk from unnest(p.hand) c where c < 52 group by 1 having count(*) >= 4) t;
  if v_ranks is null then return 0; end if;
  v_out := array(select c from unnest(p.hand) c where c < 52 and c / 4 + 2 = any (v_ranks) order by c);
  update public.bluff_players x set hand = array(select c from unnest(p.hand) c where not (c < 52 and c / 4 + 2 = any (v_ranks)))
   where x.room_id = p_room and x.user_id = p_user;
  update public.bluff_rooms x set bita = x.bita + cardinality(v_out) where x.id = p_room;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'four', 'seat', p.seat, 'ranks', to_jsonb(v_ranks), 'cards', to_jsonb(v_out)));
  return cardinality(v_out);
end $function$;
revoke all on function public.bluff_fours(bigint, uuid) from public, anon, authenticated;

-- Кто остался без карт (и кому некому отвечать за ход) — вышел
create or replace function public.bluff_outs(p_room bigint, p_except integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare r record;
begin
  for r in select x.user_id, x.seat from public.bluff_players x
            where x.room_id = p_room and x.place is null and cardinality(x.hand) = 0 and x.seat is distinct from p_except
            order by x.seat loop
    perform public.bluff_log(p_room, jsonb_build_object('kind', 'out', 'seat', r.seat, 'place', public.bluff_place(p_room, r.user_id, 'done')));
  end loop;
end $function$;
revoke all on function public.bluff_outs(bigint, integer) from public, anon, authenticated;

-- 7. Раздача
create or replace function public.bluff_deal(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  v_deck integer[];
  v_n integer;
  v_seat integer;
  r record;
  i integer := 0;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  v_deck := array(select c from (select x as c from generate_series(0, 51) x where x / 4 + 2 >= g.low_rank
                                 union all select 52 + j from generate_series(0, g.jokers - 1) j) t order by random());
  select count(*) into v_n from public.bluff_players x where x.room_id = p_room;
  for r in select x.user_id from public.bluff_players x where x.room_id = p_room order by x.seat, x.joined_at loop
    update public.bluff_players x
       set seat = i, hand = array(select v_deck[k] from generate_series(i + 1, cardinality(v_deck), v_n) k),
           misses = 0, place = null, out_kind = null, payout = null
     where x.room_id = p_room and x.user_id = r.user_id;
    i := i + 1;
  end loop;
  update public.bluff_rooms x
     set status = 'play', pile = '{}', claim_rank = null, last_seat = null, last_n = 0, bita = 0, turn_seat = null,
         deadline = null, started_at = now(), log = '[]', version = x.version + 1
   where x.id = p_room;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'deal'));
  for r in select x.user_id from public.bluff_players x where x.room_id = p_room order by x.seat loop
    perform public.bluff_fours(p_room, r.user_id);     -- четвёрки с раздачи — сразу в биту
  end loop;
  perform public.bluff_outs(p_room, null);               -- ушло всё четвёрками — сразу вышел
  if public.bluff_end_check(p_room) then return; end if;
  select x.seat into v_seat from public.bluff_players x where x.room_id = p_room and x.place is null order by random() limit 1;
  update public.bluff_rooms x set turn_seat = v_seat, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'begin', 'seat', v_seat));
end $function$;
revoke all on function public.bluff_deal(bigint) from public, anon, authenticated;

-- 8. Старт и «Готов»
create or replace function public.bluff_start(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.bluff_tick(p_room);
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or g.status <> 'open' or g.creator <> uid then raise exception 'bluff_gone'; end if;
  if (select count(*) from public.bluff_players x where x.room_id = p_room) < 3 then raise exception 'bluff_few'; end if;
  update public.bluff_players x set ready = (x.user_id = uid or x.bot_name is not null) where x.room_id = p_room;
  update public.bluff_rooms x set status = 'ready', deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
  if not exists (select 1 from public.bluff_players x where x.room_id = p_room and not x.ready) then
    perform public.bluff_deal(p_room);
  end if;
end $function$;
revoke all on function public.bluff_start(bigint) from public, anon;
grant execute on function public.bluff_start(bigint) to authenticated;

create or replace function public.bluff_ready(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid();
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.bluff_tick(p_room);
  perform 1 from public.bluff_rooms x where x.id = p_room and x.status = 'ready' for update;
  if not found or not exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'bluff_gone';
  end if;
  update public.bluff_players x set ready = true where x.room_id = p_room and x.user_id = uid;
  update public.bluff_rooms x set version = x.version + 1 where x.id = p_room;
  if not exists (select 1 from public.bluff_players x where x.room_id = p_room and not x.ready) then
    perform public.bluff_deal(p_room);
  end if;
end $function$;
revoke all on function public.bluff_ready(bigint) from public, anon;
grant execute on function public.bluff_ready(bigint) to authenticated;

-- 9. Ход: «put» — положить карты (в начале круга — с номиналом), «trust» — верю, «doubt» — не верю
create or replace function public.bluff_move(p_room bigint, p_user uuid, p_kind text, p_cards integer[], p_rank integer, p_auto boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  me public.bluff_players%rowtype;
  v_prev public.bluff_players%rowtype;
  v_last integer[];
  v_truth boolean;
  v_taker uuid;
  v_taker_seat integer;
  v_start integer;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or g.status <> 'play' then raise exception 'bluff_gone'; end if;
  select * into me from public.bluff_players x where x.room_id = p_room and x.user_id = p_user;
  if not found or me.place is not null or me.seat is distinct from g.turn_seat then raise exception 'bluff_not_turn'; end if;
  if g.last_seat is not null then
    select * into v_prev from public.bluff_players x where x.room_id = p_room and x.seat = g.last_seat;
  end if;

  if p_kind = 'put' then
    if p_cards is null or cardinality(p_cards) = 0
       or (select count(distinct c) from unnest(p_cards) c) <> cardinality(p_cards)
       or exists (select 1 from unnest(p_cards) c where not (c = any (me.hand))) then
      raise exception 'bluff_bad_move';
    end if;
    if g.claim_rank is null then
      if p_rank is null or p_rank < g.low_rank or p_rank > 14 then raise exception 'bluff_bad_rank'; end if;
      g.claim_rank := p_rank;
    end if;
    update public.bluff_players x
       set hand = array(select c from unnest(me.hand) c where not (c = any (p_cards))),
           misses = case when coalesce(p_auto, false) then x.misses else 0 end
     where x.room_id = p_room and x.user_id = p_user;
    update public.bluff_rooms x set pile = x.pile || p_cards, claim_rank = g.claim_rank, last_seat = me.seat, last_n = cardinality(p_cards)
     where x.id = p_room;
    perform public.bluff_log(p_room, jsonb_build_object('kind', 'put', 'seat', me.seat, 'n', cardinality(p_cards), 'rank', g.claim_rank,
                                                        'new', g.last_seat is null, 'auto', coalesce(p_auto, false)));
    -- ход предыдущего принят: если он положил последние карты — вышел
    if v_prev.user_id is not null and v_prev.place is null and cardinality(v_prev.hand) = 0 then
      perform public.bluff_log(p_room, jsonb_build_object('kind', 'out', 'seat', v_prev.seat, 'place', public.bluff_place(p_room, v_prev.user_id, 'done')));
    end if;
    if public.bluff_end_check(p_room) then return; end if;
    v_start := public.bluff_next(p_room, me.seat);
    update public.bluff_rooms x set turn_seat = v_start, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
    return;
  end if;

  if p_kind not in ('trust', 'doubt') then raise exception 'bluff_bad_move'; end if;
  if g.claim_rank is null or g.last_seat is null or g.last_seat = me.seat then raise exception 'bluff_bad_move'; end if;
  update public.bluff_players x set misses = case when coalesce(p_auto, false) then x.misses else 0 end
   where x.room_id = p_room and x.user_id = p_user;
  v_last := g.pile[cardinality(g.pile) - g.last_n + 1 : cardinality(g.pile)];
  v_truth := not exists (select 1 from unnest(v_last) c where c < 52 and c / 4 + 2 <> g.claim_rank);   -- джокер — всегда правда
  if p_kind = 'doubt' then
    v_taker := case when v_truth then me.user_id else v_prev.user_id end;
  else
    v_taker := case when v_truth then null else me.user_id end;
  end if;
  -- забирать некому (положивший уже вышел из игры) — стопка в биту
  if v_taker is not null and exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = v_taker and x.place is not null) then
    v_taker := null;
  end if;
  select x.seat into v_taker_seat from public.bluff_players x where x.room_id = p_room and x.user_id = v_taker;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'reveal', 'seat', me.seat, 'call', p_kind, 'of', g.last_seat,
                                                      'cards', to_jsonb(v_last), 'truth', v_truth, 'rank', g.claim_rank,
                                                      'taker', v_taker_seat, 'n', cardinality(g.pile), 'auto', coalesce(p_auto, false)));
  if v_taker is not null then
    update public.bluff_players x set hand = x.hand || g.pile where x.room_id = p_room and x.user_id = v_taker;
  else
    update public.bluff_rooms x set bita = x.bita + cardinality(g.pile) where x.id = p_room;
  end if;
  update public.bluff_rooms x set pile = '{}', claim_rank = null, last_seat = null, last_n = 0 where x.id = p_room;
  if v_taker is not null then perform public.bluff_fours(p_room, v_taker); end if;
  perform public.bluff_outs(p_room, null);              -- положивший последние карты (не забрал) и забравший, у кого всё ушло четвёрками
  if public.bluff_end_check(p_room) then return; end if;
  if (p_kind = 'doubt' and not v_truth) or (p_kind = 'trust' and v_truth) then
    v_start := me.seat;                                 -- угадал — начинает новый круг
    if exists (select 1 from public.bluff_players x where x.room_id = p_room and x.seat = v_start and x.place is not null) then
      v_start := public.bluff_next(p_room, v_start);
    end if;
  else
    v_start := public.bluff_next(p_room, me.seat);      -- ошибся — забрал стопку и пропускает ход
  end if;
  update public.bluff_rooms x set turn_seat = v_start, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.bluff_move(bigint, uuid, text, integer[], integer, boolean) from public, anon, authenticated;

create or replace function public.bluff_put(p_room bigint, p_cards integer[], p_rank integer default null)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.bluff_tick(p_room);
  perform public.bluff_move(p_room, auth.uid(), 'put', p_cards, p_rank, false);
end $function$;
revoke all on function public.bluff_put(bigint, integer[], integer) from public, anon;
grant execute on function public.bluff_put(bigint, integer[], integer) to authenticated;

create or replace function public.bluff_call(p_room bigint, p_kind text)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if p_kind not in ('trust', 'doubt') then raise exception 'bluff_bad_move'; end if;
  perform public.bluff_tick(p_room);
  perform public.bluff_move(p_room, auth.uid(), p_kind, null, null, false);
end $function$;
revoke all on function public.bluff_call(bigint, text) from public, anon;
grant execute on function public.bluff_call(bigint, text) to authenticated;

-- 10. Ход бота (через 1,5 секунды после начала его хода)
-- Начало круга: называет номинал, которого у него больше всего, кладёт все такие карты, иногда подкладывает чужую.
-- В ответ: положили больше, чем может быть в колоде, — «не верю»; соперник выкладывает последние — чаще проверяет;
-- есть подходящие (или джокеры) — докладывает их; иначе случайно: «не верю», «верю» или докладывает 1–2 карты.
create or replace function public.bluff_bot_move(p_room bigint, p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  me public.bluff_players%rowtype;
  v_prev public.bluff_players%rowtype;
  v_rank integer; v_cards integer[]; v_k integer; v_j integer; v_roll double precision := random();
begin
  select * into g from public.bluff_rooms x where x.id = p_room;
  select * into me from public.bluff_players x where x.room_id = p_room and x.user_id = p_user;
  if g.claim_rank is null then
    select c / 4 + 2 into v_rank from unnest(me.hand) c where c < 52 group by 1 order by count(*) desc, random() limit 1;
    if v_rank is null then                                   -- одни джокеры
      v_rank := g.low_rank + floor(random() * (15 - g.low_rank))::integer;
      v_cards := me.hand[1:1];
    else
      v_cards := array(select c from unnest(me.hand) c where c < 52 and c / 4 + 2 = v_rank);
      if v_roll < 0.3 then
        v_cards := v_cards || array(select c from unnest(me.hand) c where not (c = any (v_cards)) order by random() limit 1);
      end if;
    end if;
    perform public.bluff_move(p_room, p_user, 'put', v_cards, v_rank, false);
    return;
  end if;
  select * into v_prev from public.bluff_players x where x.room_id = p_room and x.seat = g.last_seat;
  v_k := (select count(*) from unnest(me.hand) c where c < 52 and c / 4 + 2 = g.claim_rank);
  v_j := (select count(*) from unnest(me.hand) c where c >= 52);
  if v_k + g.last_n > 4 + g.jokers or (cardinality(v_prev.hand) = 0 and v_roll < 0.6) then
    perform public.bluff_move(p_room, p_user, 'doubt', null, null, false);
  elsif v_k + v_j > 0 and v_roll < 0.7 then
    perform public.bluff_move(p_room, p_user, 'put',
      array(select c from unnest(me.hand) c where c >= 52 or c / 4 + 2 = g.claim_rank), null, false);
  elsif v_roll < 0.25 then
    perform public.bluff_move(p_room, p_user, 'doubt', null, null, false);
  elsif v_roll < 0.45 then
    perform public.bluff_move(p_room, p_user, 'trust', null, null, false);
  else
    perform public.bluff_move(p_room, p_user, 'put',
      array(select c from unnest(me.hand) c order by random() limit 1 + floor(random() * 2)::integer), null, false);
  end if;
end $function$;
revoke all on function public.bluff_bot_move(bigint, uuid) from public, anon, authenticated;

-- 11. Часы комнаты: «Готов» вышел, время хода вышло, ход бота, один в комнате, сутки без игры
create or replace function public.bluff_tick(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  p public.bluff_players%rowtype;
  v_card integer; v_next integer;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found then return; end if;

  if g.status = 'open' then
    if g.created_at < now() - interval '24 hours'
       or not exists (select 1 from public.bluff_players x where x.room_id = g.id and x.bot_name is null) then
      perform public.bluff_cancel_room(g.id);
    elsif public.bluff_alone_at(g.id) <= now() then
      perform public.bluff_log(g.id, jsonb_build_object('kind', 'alone'));     -- телефону: почему закрыта
      perform public.bluff_cancel_room(g.id);
    end if;

  elsif g.status = 'ready' and g.deadline < now() - interval '2 seconds' then
    delete from public.bluff_players x where x.room_id = g.id and not x.ready;   -- не успели — ставка возвращается
    if (select count(*) from public.bluff_players x where x.room_id = g.id) >= 3 then
      perform public.bluff_deal(g.id);
    elsif exists (select 1 from public.bluff_players x where x.room_id = g.id and x.bot_name is null) then
      update public.bluff_players x set ready = x.bot_name is not null where x.room_id = g.id;
      update public.bluff_rooms x set status = 'open', deadline = null, version = x.version + 1 where x.id = g.id;
    else
      perform public.bluff_cancel_room(g.id);
    end if;

  elsif g.status = 'play' then
    select * into p from public.bluff_players x where x.room_id = g.id and x.seat = g.turn_seat and x.place is null;
    -- ход бота: через 1,5 секунды после начала хода (ход длится 30 секунд, срок = начало + 30)
    if found and p.bot_name is not null then
      if g.deadline - interval '28.5 seconds' <= now() then perform public.bluff_bot_move(g.id, p.user_id); end if;
      return;
    end if;
    if g.deadline >= now() - interval '2 seconds' then return; end if;
    if p.user_id is null then                               -- ход у того, кого уже нет, — следующему
      v_next := public.bluff_next(g.id, coalesce(g.turn_seat, 0));
      update public.bluff_rooms x set turn_seat = v_next, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = g.id;
      return;
    end if;
    update public.bluff_players x set misses = x.misses + 1 where x.room_id = g.id and x.user_id = p.user_id;
    if p.misses + 1 >= 2 then
      -- второй пропуск подряд: выбывает на последнее свободное место, его карты уходят в биту
      update public.bluff_rooms x set bita = x.bita + cardinality(p.hand) where x.id = g.id;
      update public.bluff_players x set hand = '{}' where x.room_id = g.id and x.user_id = p.user_id;
      perform public.bluff_log(g.id, jsonb_build_object('kind', 'afk', 'seat', p.seat, 'out', public.bluff_place(g.id, p.user_id, 'afk')));
      if public.bluff_end_check(g.id) then return; end if;
      v_next := public.bluff_next(g.id, p.seat);
      if g.last_seat is not null and v_next = g.last_seat then  -- отвечать на свой же ход нельзя: стопка в биту, новый круг
        update public.bluff_rooms x set bita = x.bita + cardinality(x.pile), pile = '{}', claim_rank = null, last_seat = null, last_n = 0
         where x.id = g.id;
        perform public.bluff_outs(g.id, null);
        if public.bluff_end_check(g.id) then return; end if;
      end if;
      update public.bluff_rooms x set turn_seat = v_next, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = g.id;
      return;
    end if;
    -- первый пропуск: база ходит за игрока
    if g.claim_rank is null then
      select c into v_card from unnest(p.hand) c order by (c >= 52), c limit 1;   -- новый круг: одна карта, честно
      perform public.bluff_move(g.id, p.user_id, 'put', array[v_card], case when v_card >= 52 then g.low_rank else v_card / 4 + 2 end, true);
    else
      select c into v_card from unnest(p.hand) c                                  -- доложить одну: подходящую, если есть
       order by (case when c >= 52 or c / 4 + 2 = g.claim_rank then 0 else 1 end), c limit 1;
      perform public.bluff_move(g.id, p.user_id, 'put', array[v_card], null, true);
    end if;
  end if;
end $function$;
revoke all on function public.bluff_tick(bigint) from public, anon, authenticated;

-- Пора ли трогать часы комнаты (зовут вид и список)
create or replace function public.bluff_due(p_room bigint)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.bluff_rooms g where g.id = p_room and (
           (g.status in ('ready', 'play') and g.deadline < now() - interval '2 seconds')
        or (g.status = 'open' and (g.created_at < now() - interval '24 hours' or public.bluff_alone_at(g.id) <= now()
              or not exists (select 1 from public.bluff_players x where x.room_id = g.id and x.bot_name is null)))
        or (g.status = 'play' and g.deadline - interval '28.5 seconds' <= now()
              and exists (select 1 from public.bluff_players x where x.room_id = g.id and x.seat = g.turn_seat
                          and x.place is null and x.bot_name is not null))))
$function$;
revoke all on function public.bluff_due(bigint) from public, anon, authenticated;

-- 12. Выйти: до старта — ставка возвращается; во время игры — поражение
create or replace function public.bluff_leave(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
  p public.bluff_players%rowtype;
  v_next uuid; v_seat integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.bluff_tick(p_room);
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found then raise exception 'bluff_gone'; end if;
  select * into p from public.bluff_players x where x.room_id = p_room and x.user_id = uid;
  if not found then raise exception 'bluff_gone'; end if;

  if g.status = 'play' then
    if p.place is not null then raise exception 'bluff_gone'; end if;
    update public.bluff_rooms x set bita = x.bita + cardinality(p.hand) where x.id = p_room;
    update public.bluff_players x set hand = '{}' where x.room_id = p_room and x.user_id = uid;
    perform public.bluff_log(p_room, jsonb_build_object('kind', 'left', 'seat', p.seat, 'out', public.bluff_place(p_room, uid, 'left')));
    -- клал последним — проверять некого: стопка в биту, круг окончен
    if g.last_seat = p.seat then
      update public.bluff_rooms x set bita = x.bita + cardinality(x.pile), pile = '{}', claim_rank = null, last_seat = null, last_n = 0
       where x.id = p_room;
    end if;
    if public.bluff_end_check(p_room) then return; end if;
    if g.turn_seat = p.seat then
      v_seat := public.bluff_next(p_room, p.seat);
      update public.bluff_rooms x set turn_seat = v_seat, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
    elsif g.last_seat = p.seat then
      update public.bluff_rooms x set deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
    end if;
    return;
  end if;

  if g.status not in ('open', 'ready') then raise exception 'bluff_gone'; end if;
  delete from public.bluff_players x where x.room_id = p_room and x.user_id = uid;
  select x.user_id into v_next from public.bluff_players x where x.room_id = p_room and x.bot_name is null order by x.joined_at limit 1;
  if v_next is null then
    perform public.bluff_cancel_room(p_room);
    return;
  end if;
  update public.bluff_players x set ready = x.bot_name is not null where x.room_id = p_room;
  update public.bluff_rooms x
     set creator = case when x.creator = uid then v_next else x.creator end,
         status = 'open', deadline = null, version = x.version + 1
   where x.id = p_room;
end $function$;
revoke all on function public.bluff_leave(bigint) from public, anon;
grant execute on function public.bluff_leave(bigint) to authenticated;

-- 13. «Ещё раз»: новая комната с той же ставкой и колодой (тестовая — с теми же ботами); остальные заходят в неё
create or replace function public.bluff_rematch(p_room bigint)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
  v_id bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or g.status <> 'finished'
     or not exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'bluff_gone';
  end if;
  if g.rematch_id is not null then
    perform public.bluff_tick(g.rematch_id);
    if exists (select 1 from public.bluff_players x where x.room_id = g.rematch_id and x.user_id = uid) then
      return g.rematch_id;
    end if;
    if exists (select 1 from public.bluff_rooms x where x.id = g.rematch_id and x.status = 'open') then
      perform public.bluff_enter(g.rematch_id, uid);
      update public.bluff_rooms x set version = x.version + 1 where x.id = p_room;
      return g.rematch_id;
    end if;
  end if;
  v_id := public.bluff_new(uid, g.stake, g.low_rank, g.jokers, g.id, g.test);
  if g.test then
    insert into public.bluff_players (room_id, user_id, seat, stake, bot_name, ready)
    select v_id, x.user_id, row_number() over (order by x.seat)::integer, 0, x.bot_name, true
      from public.bluff_players x where x.room_id = p_room and x.bot_name is not null;
  end if;
  update public.bluff_rooms x set rematch_id = v_id, version = x.version + 1 where x.id = p_room;
  return v_id;
end $function$;
revoke all on function public.bluff_rematch(bigint) from public, anon;
grant execute on function public.bluff_rematch(bigint) to authenticated;

-- 14. Вид комнаты для телефона: своя рука, сколько у кого карт, стопка (только число), названный номинал, журнал
create or replace function public.bluff_view(p_room bigint)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
  me public.bluff_players%rowtype;
  v_turn boolean;
  v_players jsonb; v_rematch jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if public.bluff_due(p_room) then perform public.bluff_tick(p_room); end if;
  select * into g from public.bluff_rooms x where x.id = p_room;
  if not found then raise exception 'bluff_gone'; end if;
  select * into me from public.bluff_players x where x.room_id = p_room and x.user_id = uid;
  if not found then
    -- не игрок: открытую комнату можно посмотреть (кто в ней), чужую игру и тестовую комнату — нет
    if g.test or g.status not in ('open', 'ready', 'cancelled') then raise exception 'bluff_gone'; end if;
  end if;
  v_turn := g.status = 'play' and me.user_id is not null and me.place is null and me.seat = g.turn_seat;

  select jsonb_agg(jsonb_build_object(
           'seat', x.seat, 'id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
           'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
           'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end, 'bot', x.bot_name is not null,
           'me', x.user_id = uid, 'creator', x.user_id = g.creator, 'ready', x.ready,
           'n', cardinality(x.hand), 'misses', x.misses, 'place', x.place, 'out', x.out_kind, 'payout', x.payout
         ) order by x.seat)
    into v_players
    from public.bluff_players x left join public.profiles pr on pr.id = x.user_id
   where x.room_id = p_room;

  if g.rematch_id is not null then
    select jsonb_build_object('id', r.id, 'status', r.status,
             'in', exists (select 1 from public.bluff_players y where y.room_id = r.id and y.user_id = uid),
             'n', (select count(*) from public.bluff_players y where y.room_id = r.id))
      into v_rematch from public.bluff_rooms r where r.id = g.rematch_id and r.status in ('open', 'ready');
  end if;

  return jsonb_build_object(
    'id', g.id, 'status', g.status, 'stake', g.stake, 'version', g.version, 'test', g.test,
    'low', g.low_rank, 'jokers', g.jokers, 'deck_n', public.bluff_deck_n(g.low_rank, g.jokers),
    'max_seats', least(6, public.bluff_deck_n(g.low_rank, g.jokers)),
    'creator', g.creator = uid,
    'server_ms', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'deadline_ms', (extract(epoch from g.deadline) * 1000)::bigint,
    'alone_ms', (extract(epoch from public.bluff_alone_at(g.id)) * 1000)::bigint,
    'turn', g.turn_seat, 'claim', g.claim_rank, 'pile_n', cardinality(g.pile), 'last_seat', g.last_seat, 'last_n', g.last_n,
    'bita', g.bita, 'log', g.log,
    'players', coalesce(v_players, '[]'),
    'rematch', v_rematch,
    'my', case when me.user_id is null then null else jsonb_build_object(
      'seat', me.seat, 'ready', me.ready, 'place', me.place, 'payout', me.payout, 'stake', me.stake,
      'hand', coalesce((select jsonb_agg(c order by (c >= 52), c) from unnest(me.hand) c), '[]'),
      'turn', v_turn,
      'new_round', v_turn and g.claim_rank is null,
      'can_call', v_turn and g.claim_rank is not null and g.last_seat is distinct from me.seat) end
  );
end $function$;
revoke all on function public.bluff_view(bigint) from public, anon;
grant execute on function public.bluff_view(bigint) to authenticated;

-- 15. Список комнат: открытые и свои текущие, плюс свои законченные за 3 дня (история)
create or replace function public.bluff_list()
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  r record;
  v jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  for r in select g.id from public.bluff_rooms g where g.status in ('open', 'ready', 'play') and public.bluff_due(g.id) loop
    perform public.bluff_tick(r.id);
  end loop;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.active desc, t.created_at desc), '[]') into v from (
    select g.id, g.status, g.stake, g.test, g.low_rank as low, g.jokers, g.created_at, g.finished_at,
           least(6, public.bluff_deck_n(g.low_rank, g.jokers)) as max_seats,
           g.status in ('open', 'ready', 'play') as active,
           exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid) as mine,
           g.creator = uid as is_creator,
           (select pr.display_name from public.profiles pr where pr.id = g.creator) as creator_name,
           (select jsonb_agg(jsonb_build_object('id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
                                                'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
                                                'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end,
                                                'place', x.place, 'payout', x.payout) order by x.seat)
              from public.bluff_players x left join public.profiles pr on pr.id = x.user_id where x.room_id = g.id) as players,
           (select x.place from public.bluff_players x where x.room_id = g.id and x.user_id = uid) as my_place,
           (select x.payout from public.bluff_players x where x.room_id = g.id and x.user_id = uid) as my_payout
      from public.bluff_rooms g
     where (g.status in ('open', 'ready') and (not g.test or exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid)))
        or (g.status = 'play' and exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid
                                           and coalesce(x.out_kind, '') not in ('afk', 'left')))
        or (g.status = 'finished' and g.finished_at > now() - interval '3 days'
            and exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid))
     order by g.created_at desc
     limit 20
  ) t;
  return v;
end $function$;
revoke all on function public.bluff_list() from public, anon;
grant execute on function public.bluff_list() to authenticated;
